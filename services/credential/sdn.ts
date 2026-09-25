/**
 * OFAC SDN digital-currency address screening.
 *
 * Source: Treasury's official SDN list (SDN.XML from the Sanctions List Service). Every
 * `<id>` whose idType is "Digital Currency Address - <asset>" is kept — SOL and every other
 * asset, since a Solana address can be listed under a token symbol (USDC, USDT) as well.
 * SDN.CSV is not used: its remarks column is truncated and drops most addresses.
 *
 * The parsed list is cached as JSON with its fetch time. A fresh cache is used as is; a stale
 * one is refreshed, and kept (flagged stale) if the download fails. With no list at all,
 * screening fails closed.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"

export const OFAC_SDN_XML_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML"

export interface SdnEntry {
  address: string
  /** The asset after "Digital Currency Address - " (SOL, XBT, ETH, USDC, …). */
  currency: string
  /** SDN entry uid (or a fixture id). */
  uid: string
  name: string
}

export interface SdnList {
  source: string
  fetchedAt: string
  publishDate: string | null
  recordCount: number | null
  sha256: string
  entries: SdnEntry[]
}

export interface LoadedList {
  list: SdnList
  from: "download" | "cache"
  stale: boolean
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => ENTITIES[e]).trim()
const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`))
  return m ? decode(m[1]) : null
}

export function parseSdnXml(xml: string): Pick<SdnList, "publishDate" | "recordCount" | "entries"> {
  if (!/<sdnList[\s>]/.test(xml) || !/<sdnEntry>/.test(xml)) throw new Error("not an OFAC SDN list (no <sdnList>/<sdnEntry>)")
  const entries: SdnEntry[] = []
  for (const [, block] of xml.matchAll(/<sdnEntry>([\s\S]*?)<\/sdnEntry>/g)) {
    if (!block.includes("Digital Currency Address")) continue
    const uid = tag(block, "uid") ?? "?"
    const name = [tag(block, "firstName"), tag(block, "lastName")].filter(Boolean).join(" ")
    for (const [, id] of block.matchAll(/<id>([\s\S]*?)<\/id>/g)) {
      const type = tag(id, "idType")
      const value = tag(id, "idNumber")
      const m = type?.match(/^Digital Currency Address - (.*)$/)
      if (m && value) entries.push({ address: value, currency: m[1].trim() || "?", uid, name })
    }
  }
  const count = tag(xml.slice(0, 2_000), "Record_Count")
  return { publishDate: tag(xml.slice(0, 2_000), "Publish_Date"), recordCount: count ? Number(count) : null, entries }
}

/** 0x-hex addresses are case-insensitive; base58 (Solana, Bitcoin, Tron) are not. */
export const normalizeAddress = (a: string) => (/^0x[0-9a-fA-F]+$/.test(a.trim()) ? a.trim().toLowerCase() : a.trim())

export class Screener {
  private readonly index = new Map<string, SdnEntry>()
  constructor(official: SdnEntry[], fixture: SdnEntry[] = []) {
    for (const e of [...official, ...fixture]) this.index.set(normalizeAddress(e.address), e)
  }
  get size(): number { return this.index.size }
  match(address: string): SdnEntry | null {
    return this.index.get(normalizeAddress(address)) ?? null
  }
}

const entrySchema = z.object({ address: z.string().min(1), currency: z.string(), uid: z.string(), name: z.string() })
const listSchema = z.object({
  source: z.string(), fetchedAt: z.string(), publishDate: z.string().nullable(), recordCount: z.number().nullable(),
  sha256: z.string(), entries: z.array(entrySchema),
})

export function loadFixture(path: string): SdnEntry[] {
  return z.object({ entries: z.array(entrySchema) }).parse(JSON.parse(readFileSync(path, "utf8"))).entries
}

function readCache(path: string): SdnList | null {
  if (!existsSync(path)) return null
  const parsed = listSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
  return parsed.success && parsed.data.entries.length > 0 ? parsed.data : null
}

async function download(url: string, fetchImpl: typeof fetch, now: number): Promise<SdnList> {
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const xml = await response.text()
  const parsed = parseSdnXml(xml)
  if (parsed.entries.length === 0) throw new Error("the list parsed but holds no digital-currency addresses")
  return {
    source: url, fetchedAt: new Date(now).toISOString(), ...parsed,
    sha256: createHash("sha256").update(xml).digest("hex"),
  }
}

export async function loadOfficialList(opts: {
  cachePath: string
  url: string
  maxAgeMs: number
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<LoadedList> {
  const now = (opts.now ?? Date.now)()
  const cached = readCache(opts.cachePath)
  if (cached && now - Date.parse(cached.fetchedAt) < opts.maxAgeMs) return { list: cached, from: "cache", stale: false }
  try {
    const list = await download(opts.url, opts.fetchImpl ?? fetch, now)
    mkdirSync(dirname(opts.cachePath), { recursive: true })
    const tmp = `${opts.cachePath}.tmp`
    writeFileSync(tmp, JSON.stringify(list) + "\n")
    renameSync(tmp, opts.cachePath)
    return { list, from: "download", stale: false }
  } catch (error) {
    if (cached) return { list: cached, from: "cache", stale: true }
    throw new Error(`OFAC SDN list unavailable (${error instanceof Error ? error.message : String(error)}) and no cached copy`)
  }
}

export function countByCurrency(entries: SdnEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of entries) out[e.currency] = (out[e.currency] ?? 0) + 1
  return out
}

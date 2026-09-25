/**
 * Tier classification. Tier 1 = S&P 500 + Russell 1000 members (+ eligible ETPs); everything else
 * is Tier 2 (order §II.F, fn 70–71). Membership comes from the iShares IVV and IWB holdings CSVs;
 * when those cannot settle it, a documented override is used and the tier is marked inferred.
 * With neither, the tier is unknown (null) — never guessed.
 */
import { getText } from "../rehearsal/http.js"
import { TIER1_LISTS, TIER_OVERRIDES, TIER_RATE, type ListKey, type Tier } from "./config.js"

export type ListStatus =
  | { ok: true; index: string; url: string; fetchedAt: string; asOf: string | null; count: number; tickers: Set<string> }
  | { ok: false; index: string; url: string; error: string }

export type TierLists = Record<ListKey, ListStatus>

export interface TierResult {
  tier: Tier | null
  percent: number | null
  basis: "ishares" | "override" | "none"
  inferred: boolean
  reason: string
  lists: { key: ListKey; index: string; url: string; ok: boolean; asOf: string | null; count: number | null; fetchedAt: string | null; error: string | null }[]
}

/** Tickers compare without punctuation: iShares writes BRK.B as BRKB. */
export const normalizeTicker = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "")

export function parseCsvRow(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ",") { out.push(cur); cur = "" } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/** iShares holdings CSV → equity tickers. Throws on anything that is not a holdings file (an HTML page, say). */
export function parseIsharesHoldings(body: string, minRows: number): { asOf: string | null; tickers: Set<string> } {
  const head = body.trimStart().slice(0, 200).toLowerCase()
  if (head.startsWith("<!doctype") || head.startsWith("<html")) throw new Error("iShares served an HTML page, not a holdings CSV")
  const lines = body.split(/\r?\n/)
  const asOfLine = lines.find((l) => /^fund holdings as of/i.test(l))
  const asOf = asOfLine ? parseCsvRow(asOfLine)[1] || null : null
  const headerAt = lines.findIndex((l) => { const cells = parseCsvRow(l); return cells.includes("Ticker") && cells.includes("Asset Class") })
  if (headerAt < 0) throw new Error("no Ticker/Asset Class header row in the iShares file")
  const header = parseCsvRow(lines[headerAt])
  const [ti, ai] = [header.indexOf("Ticker"), header.indexOf("Asset Class")]
  const tickers = new Set<string>()
  for (const line of lines.slice(headerAt + 1)) {
    const cells = parseCsvRow(line)
    if (cells.length < header.length) break // the holdings table ends at the first short row
    if (cells[ai] === "Equity" && cells[ti] && cells[ti] !== "-") tickers.add(normalizeTicker(cells[ti]))
  }
  if (tickers.size < minRows) throw new Error(`iShares file lists ${tickers.size} equities, expected at least ${minRows}`)
  return { asOf, tickers }
}

export async function fetchTierList(key: ListKey, fetchImpl: typeof fetch = fetch): Promise<ListStatus> {
  const { index, url, minRows } = TIER1_LISTS[key]
  try {
    const { body, fetchedAt } = await getText(url, fetchImpl, 1)
    const { asOf, tickers } = parseIsharesHoldings(body, minRows)
    return { ok: true, index, url, fetchedAt, asOf, count: tickers.size, tickers }
  } catch (e) {
    return { ok: false, index, url, error: e instanceof Error ? e.message : String(e) }
  }
}

export function classifyTier(symbol: string, lists: TierLists): TierResult {
  const key = normalizeTicker(symbol)
  const listInfo = (Object.keys(lists) as ListKey[]).map((k) => {
    const l = lists[k]
    return l.ok
      ? { key: k, index: l.index, url: l.url, ok: true, asOf: l.asOf, count: l.count, fetchedAt: l.fetchedAt, error: null }
      : { key: k, index: l.index, url: l.url, ok: false, asOf: null, count: null, fetchedAt: null, error: l.error }
  })
  const result = (tier: Tier | null, basis: TierResult["basis"], inferred: boolean, reason: string): TierResult => ({
    tier, percent: tier === null ? null : TIER_RATE[tier].percent, basis, inferred, reason, lists: listInfo,
  })
  const member = (Object.values(lists) as ListStatus[]).filter((l) => l.ok && l.tickers.has(key)).map((l) => l.index)
  if (member.length > 0) return result(1, "ishares", false, `held by the iShares ${member.join(" and ")} fund`)
  const override = TIER_OVERRIDES[symbol.toUpperCase()]
  const allLoaded = Object.values(lists).every((l) => l.ok)
  if (override && (override.tier === 1 || !allLoaded)) {
    return result(override.tier, "override", true, `${override.reason} (override checked ${override.checked})`)
  }
  if (allLoaded) return result(2, "ishares", false, "in neither the S&P 500 (IVV) nor the Russell 1000 (IWB) holdings")
  return result(null, "none", false, "iShares lists unavailable and no documented override")
}

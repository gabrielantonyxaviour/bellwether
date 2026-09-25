/**
 * FWDI market discovery, from two directions that must agree:
 *  1. every FWDI token account (Token-2022 getProgramAccounts, mint @0) and who owns it —
 *     a DEX vault is typically self-owned or owned by a data-less PDA;
 *  2. direct scans of each Token-2022-capable DEX program for markets whose mint fields hold FWDI.
 * Each market is then read for its vaults, their freeze state and balance, and its activity.
 * Jupiter's token API is an off-chain cross-check of the first pool it knows.
 */
import { getAddressDecoder, getBase64Encoder } from "@solana/kit"
import { ACTIVITY_WINDOW_DAYS, DEX_LAYOUTS, FWDI_MINT, programLabel, type DexLayout } from "./constants.js"
import { enumerateTokenAccounts, ownerPrograms, readTokenAccounts, signaturesFor, toIso } from "./accounts.js"
import { getJson } from "./http.js"
import type { RpcClient } from "./rpc.js"
import type { Market, Markets, Source } from "./schema.js"

type Scan = Markets["scans"][number]

async function scanDexPrograms(rpc: RpcClient, mint: string): Promise<{ scans: Scan[]; hits: Map<string, { layout: DexLayout; fields: string[] }>; fetchedAt: string }> {
  const scans: Scan[] = []
  const hits = new Map<string, { layout: DexLayout; fields: string[] }>()
  let fetchedAt = new Date().toISOString()
  for (const layout of DEX_LAYOUTS) {
    for (const [i, offset] of layout.mintOffsets.entries()) {
      const field = i === 0 ? "base / mint A" : "quote / mint B"
      try {
        const response = await rpc.call<{ pubkey: string }[]>("getProgramAccounts", [layout.program, {
          encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset, bytes: mint } }],
        }])
        fetchedAt = response.fetchedAt
        const matches = response.result.map((r) => r.pubkey)
        scans.push({ program: layout.program, programName: layout.name, offset, field, status: "ok", matches })
        for (const m of matches) hits.set(m, { layout, fields: [...(hits.get(m)?.fields ?? []), field] })
      } catch (error) {
        scans.push({ program: layout.program, programName: layout.name, offset, field, status: "error", matches: [], error: String(error instanceof Error ? error.message : error) })
      }
    }
  }
  return { scans, hits, fetchedAt }
}

async function jupiterHint(mint: string, fetchImpl?: typeof fetch): Promise<Omit<Markets["jupiter"], "listedPoolFound">> {
  const url = `https://lite-api.jup.ag/tokens/v2/search?query=${mint}`
  try {
    const { body, fetchedAt } = await getJson<{ id: string; firstPool?: { id: string; createdAt: string } }[]>(url, fetchImpl, 2)
    const token = body.find((t) => t.id === mint)
    const source: Source = { name: "Jupiter token API (off-chain cross-check)", url, fetchedAt }
    if (!token?.firstPool) return { status: "ok", firstPool: null, firstPoolCreatedAt: null, note: "Jupiter lists no pool for FWDI", source }
    return { status: "ok", firstPool: token.firstPool.id, firstPoolCreatedAt: token.firstPool.createdAt, source }
  } catch (error) {
    return { status: "unavailable", firstPool: null, firstPoolCreatedAt: null, note: String(error instanceof Error ? error.message : error), source: null }
  }
}

export async function discoverMarkets(rpc: RpcClient, options: { now: Date; mint?: string; fetchImpl?: typeof fetch }): Promise<Markets> {
  const mint = options.mint ?? FWDI_MINT
  const sources: Source[] = []
  const tokenAccounts = await enumerateTokenAccounts(rpc, mint)
  const enumerationSource: Source = {
    name: "Solana mainnet RPC getProgramAccounts (Token-2022, memcmp mint @0)", url: rpc.url, method: "getProgramAccounts",
    fetchedAt: tokenAccounts.fetchedAt, slot: tokenAccounts.slot,
  }
  sources.push(enumerationSource)
  const accounts = tokenAccounts.accounts
  const owners = await ownerPrograms(rpc, accounts.map((a) => a.owner))
  const ownerCounts: Record<string, number> = {}
  for (const a of accounts) {
    const label = programLabel(owners.get(a.owner) ?? null)
    ownerCounts[label] = (ownerCounts[label] ?? 0) + 1
  }

  let largest: Markets["largestAccounts"]
  try {
    const { result } = await rpc.call<{ value: { address: string }[] }>("getTokenLargestAccounts", [mint], { maxRetries: 1 })
    largest = { status: "ok", accounts: result.value.map((v) => v.address) }
  } catch (error) {
    const text = String(error instanceof Error ? error.message : error)
    largest = { status: /429|too many/i.test(text) ? "rate_limited" : "error", accounts: [], note: `${text}; the full getProgramAccounts enumeration is used instead` }
  }

  const { scans, hits, fetchedAt: scanFetchedAt } = await scanDexPrograms(rpc, mint)
  sources.push({ name: "Solana mainnet RPC getProgramAccounts on DEX programs (memcmp FWDI at verified mint offsets)", url: rpc.url, method: "getProgramAccounts", fetchedAt: scanFetchedAt })
  const jupiter = await jupiterHint(mint, options.fetchImpl)
  if (jupiter.firstPool && !hits.has(jupiter.firstPool)) {
    // A pool Jupiter knows but no layout scan matched: read it anyway if its program has a known layout.
    const { result } = await rpc.call<{ value: { owner: string } | null }>("getAccountInfo", [jupiter.firstPool, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])
    const layout = DEX_LAYOUTS.find((l) => l.program === result.value?.owner)
    if (layout) hits.set(jupiter.firstPool, { layout, fields: ["jupiter firstPool"] })
  }

  const marketAddresses = [...hits.keys()]
  const found: Market[] = []
  const enumerated = new Set(accounts.map((a) => a.account))
  if (marketAddresses.length > 0) {
    const response = await rpc.call<{ value: ({ owner: string; data: [string, string] } | null)[] }>(
      "getMultipleAccounts", [marketAddresses, { encoding: "base64", dataSlice: { offset: 0, length: 320 } }])
    const decoder = getAddressDecoder()
    const decoded = marketAddresses.map((address, i) => {
      const value = response.result.value[i]
      const { layout, fields } = hits.get(address)!
      if (!value || value.owner !== layout.program) return null
      const bytes = getBase64Encoder().encode(value.data[0])
      const at = (o: number) => decoder.decode(bytes.slice(o, o + 32))
      const [baseMint, quoteMint] = layout.mintOffsets.map(at)
      const [baseVault, quoteVault] = layout.vaultOffsets.map(at)
      return { address, layout, fields, baseMint, quoteMint, baseVault, quoteVault }
    }).filter((d): d is NonNullable<typeof d> => d !== null && (d.baseMint === mint || d.quoteMint === mint))
    const { reads, fetchedAt } = await readTokenAccounts(rpc, decoded.flatMap((d) => [d.baseVault, d.quoteVault]))
    const since = Math.floor(options.now.getTime() / 1000) - ACTIVITY_WINDOW_DAYS * 86_400
    for (const d of decoded) {
      const fwdiSide = d.baseMint === mint ? "base" : "quote"
      const [fwdiVaultAddress, otherVaultAddress, otherMint] = fwdiSide === "base" ? [d.baseVault, d.quoteVault, d.quoteMint] : [d.quoteVault, d.baseVault, d.baseMint]
      const fv = reads.get(fwdiVaultAddress)!
      const ov = reads.get(otherVaultAddress)!
      const sigs = await signaturesFor(rpc, d.address)
      const times = sigs.signatures.map((s) => s.blockTime).filter((t): t is number => t !== null)
      const canTrade = fv.exists && fv.state === "initialized"
      found.push({
        address: d.address, program: d.layout.program, programName: d.layout.name, kind: d.layout.kind,
        baseMint: d.baseMint, quoteMint: d.quoteMint, fwdiSide,
        fwdiVault: { address: fwdiVaultAddress, mint, state: fv.state, amountRaw: fv.amountRaw, exists: fv.exists, inEnumeratedAccounts: enumerated.has(fwdiVaultAddress) },
        otherVault: { address: otherVaultAddress, mint: otherMint, state: ov.state, amountRaw: ov.amountRaw, exists: ov.exists },
        canTrade,
        blocker: canTrade ? null : fv.state === "frozen"
          ? "FWDI vault is frozen: the issuer's freeze authority has not thawed (allowlisted) this venue's vault, so no FWDI can be deposited or traded"
          : `FWDI vault is ${fv.exists ? fv.state : "missing"}`,
        discoveredBy: [...d.fields.map((f) => (f === "jupiter firstPool" ? "Jupiter firstPool" : `${d.layout.name} scan (${f})`)),
          ...(enumerated.has(fwdiVaultAddress) ? ["FWDI token-account enumeration"] : [])],
        activity: {
          signatures: sigs.signatures.length, capped: sigs.capped,
          firstAt: toIso(times.length ? Math.min(...times) : null), lastAt: toIso(times.length ? Math.max(...times) : null),
          last30Days: times.filter((t) => t >= since).length,
        },
        source: { name: "Solana mainnet RPC getMultipleAccounts (market + vaults) and getSignaturesForAddress", url: rpc.url, method: "getMultipleAccounts", fetchedAt },
      })
    }
  }

  const claimed = new Set(found.map((m) => m.fwdiVault.address))
  const selfOwned = accounts.filter((a) => a.owner === a.account)
  const funded = accounts.filter((a) => a.amountRaw !== "0").sort((a, b) => b.shares - a.shares)
    .map((a) => ({ ...a, ownerProgram: owners.get(a.owner) ?? null, ownerLabel: programLabel(owners.get(a.owner) ?? null) }))
  return {
    found,
    tokenAccounts: {
      total: accounts.length,
      frozen: accounts.filter((a) => a.state === "frozen").length,
      initialized: accounts.filter((a) => a.state === "initialized").length,
      funded, ownerPrograms: ownerCounts, selfOwned,
      unattributedVaults: selfOwned.filter((a) => !claimed.has(a.account)).map((a) => a.account),
      source: enumerationSource,
    },
    scans, largestAccounts: largest,
    jupiter: { ...jupiter, listedPoolFound: jupiter.firstPool ? found.some((m) => m.address === jupiter.firstPool) : null },
    sources: jupiter.source ? [...sources, jupiter.source] : sources,
  }
}


/**
 * FWDI's on-chain activity over the last 30 days, reported as found: signatures on the mint,
 * on every funded holder account (plain Transfer does not list the mint) and on each market and
 * its vaults, each transaction classified from its parsed instructions.
 */
import { ACTIVITY_WINDOW_DAYS, ATA_PROGRAM, DEX_PROGRAM_NAMES, FWDI_MINT, LENDING_PROGRAMS, TOKEN_2022_PROGRAM } from "./constants.js"
import { signaturesFor, toIso, type SignatureInfo } from "./accounts.js"
import type { RpcClient } from "./rpc.js"
import type { Activity, Markets } from "./schema.js"

const MAX_TRANSACTIONS = 150
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

interface ParsedIx { programId: string; parsed?: { type?: string; info?: Record<string, unknown> } | string }
interface TokenBalance { accountIndex: number; mint: string }
interface ParsedTx {
  slot: number; blockTime: number | null
  meta: { err: unknown; innerInstructions?: { instructions: ParsedIx[] }[]; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null
  transaction: { message: { instructions: ParsedIx[]; accountKeys: ({ pubkey: string } | string)[] } }
}

const TOKEN_CATEGORIES: Record<string, string> = {
  transfer: "transfer", transferChecked: "transfer", transferCheckedWithFee: "transfer", burn: "burn", burnChecked: "burn",
  mintTo: "mint", mintToChecked: "mint", thawAccount: "thaw", freezeAccount: "freeze", closeAccount: "close",
  approve: "approve", approveChecked: "approve",
}

/** FWDI token accounts a transaction touched, from its own pre/post token balances. */
function fwdiAccountsIn(tx: ParsedTx, mint: string): Set<string> {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey))
  const balances = [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]
  return new Set(balances.filter((b) => b.mint === mint).map((b) => keys[b.accountIndex]).filter(Boolean))
}

export function classifyTransaction(tx: ParsedTx, knownFwdiAccounts: Set<string>, mint = FWDI_MINT): { categories: string[]; programs: string[] } {
  const fwdiAccounts = new Set([...knownFwdiAccounts, ...fwdiAccountsIn(tx, mint)])
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)]
  const programs = [...new Set(all.map((ix) => ix.programId))]
  const categories = new Set<string>()
  if (tx.meta?.err) categories.add("failed")
  if (programs.some((p) => DEX_PROGRAM_NAMES[p])) categories.add(tx.meta?.err ? "dex-attempt" : "dex-trade")
  if (programs.some((p) => LENDING_PROGRAMS[p])) categories.add("lending")
  for (const ix of all) {
    // Superstate's redemption transfers carry a memo such as "Detokenize FWDI superstate".
    if (ix.programId === MEMO_PROGRAM && typeof ix.parsed === "string" && /detokeni[sz]e|redeem|redemption/i.test(ix.parsed)) categories.add("redemption")
    if (ix.programId === ATA_PROGRAM) {
      const info = typeof ix.parsed === "object" ? ix.parsed.info : undefined
      if (!info || info.mint === mint) categories.add("ata-create")
      continue
    }
    // jsonParsed labels Token-2022 instructions "spl-token", so match on the program id.
    if (ix.programId !== TOKEN_2022_PROGRAM || typeof ix.parsed !== "object" || !ix.parsed.type) continue
    const info = ix.parsed.info ?? {}
    const touchesFwdi = info.mint === mint || [info.account, info.source, info.destination].some((a) => typeof a === "string" && fwdiAccounts.has(a))
    const category = TOKEN_CATEGORIES[ix.parsed.type]
    if (touchesFwdi && category) categories.add(category)
  }
  if (categories.size === 0 || (categories.size === 1 && categories.has("failed"))) categories.add("other")
  return { categories: [...categories].sort(), programs }
}

export async function readActivity(rpc: RpcClient, options: {
  now: Date; markets: Markets; mint?: string
}): Promise<Activity> {
  const mint = options.mint ?? FWDI_MINT
  const to = new Date(options.now.getTime())
  const from = new Date(to.getTime() - ACTIVITY_WINDOW_DAYS * 86_400_000)
  const since = Math.floor(from.getTime() / 1000)
  const targets: { address: string; role: string }[] = [
    { address: mint, role: "mint" },
    ...options.markets.tokenAccounts.funded.map((a) => ({ address: a.account, role: `holder account (${a.ownerLabel})` })),
    ...options.markets.found.flatMap((m) => [
      { address: m.address, role: `${m.programName} market` },
      { address: m.fwdiVault.address, role: `${m.programName} FWDI vault` },
      { address: m.otherVault.address, role: `${m.programName} quote vault` },
    ]),
  ]
  const seen = new Map<string, SignatureInfo>()
  const addresses: Activity["addresses"] = []
  let lastFetch = new Date().toISOString()
  for (const target of targets) {
    const { signatures, pages, fetchedAt } = await signaturesFor(rpc, target.address, { sinceUnix: since })
    lastFetch = fetchedAt
    const inWindow = signatures.filter((s) => s.blockTime !== null && s.blockTime >= since && s.blockTime <= to.getTime() / 1000)
    for (const s of inWindow) seen.set(s.signature, s)
    addresses.push({ address: target.address, role: target.role, signaturesInWindow: inWindow.length, pages })
  }

  const ordered = [...seen.values()].sort((a, b) => b.slot - a.slot)
  const fwdiAccounts = new Set([...options.markets.tokenAccounts.funded.map((a) => a.account), ...options.markets.tokenAccounts.selfOwned.map((a) => a.account)])
  const entries: Activity["entries"] = []
  let txFetchedAt = lastFetch
  for (const sig of ordered.slice(0, MAX_TRANSACTIONS)) {
    const { result, fetchedAt } = await rpc.call<ParsedTx | null>("getTransaction", [sig.signature, {
      encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed",
    }])
    txFetchedAt = fetchedAt
    const classified = result ? classifyTransaction(result, fwdiAccounts, mint) : { categories: ["unavailable"], programs: [] }
    entries.push({ signature: sig.signature, at: toIso(sig.blockTime), slot: sig.slot, ok: sig.err === null, ...classified })
  }
  const categories: Record<string, number> = {}
  for (const e of entries) for (const c of e.categories) categories[c] = (categories[c] ?? 0) + 1
  const failed = ordered.filter((s) => s.err !== null).length
  return {
    windowDays: ACTIVITY_WINDOW_DAYS, from: from.toISOString(), to: to.toISOString(), addresses,
    signatures: ordered.length, succeeded: ordered.length - failed, failed,
    trades: entries.filter((e) => e.categories.includes("dex-trade")).length,
    categories, entries, truncated: ordered.length > MAX_TRANSACTIONS,
    sources: [
      { name: "Solana mainnet RPC getSignaturesForAddress (mint, funded holder accounts, markets, vaults)", url: rpc.url, method: "getSignaturesForAddress", fetchedAt: lastFetch },
      { name: "Solana mainnet RPC getTransaction (jsonParsed) for classification", url: rpc.url, method: "getTransaction", fetchedAt: txFetchedAt },
    ],
  }
}

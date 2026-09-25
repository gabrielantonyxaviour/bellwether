/**
 * Chain resolvers: the live facts the Notice states about the venue's distributed ledger
 * applications. Program id and upgrade authority come from the BPF upgradeable loader's
 * ProgramData account; keys and parameters from VenueConfig; listings, pools and vaults from
 * SymbolRecord and Pool accounts; each listed mint's authorities and extensions through
 * services/rehearsal's readFwdiMint (the same reader that audited FWDI on mainnet).
 * A part that cannot be read becomes an entry in `errors`, never a guessed value.
 */
import { readFwdiMint } from "../rehearsal/mint.js"
import { createRpcClient, type RpcClient } from "../rehearsal/rpc.js"
import {
  SYMBOL_LEN, UPGRADEABLE_LOADER, decodePool, decodeProgramAccount, decodeProgramData, decodeSymbol, decodeVenue,
  poolPda, programDataPda, symbolPda,
} from "./layout.js"
import type { ChainFacts, SymbolFacts, TokenFacts } from "./schema.js"

interface RawAccount { data: Uint8Array; owner: string; executable: boolean; lamports: number }
interface AccountInfoResult { value: { data: [string, string]; owner: string; executable: boolean; lamports: number } | null }

export async function readAccount(rpc: RpcClient, address: string): Promise<RawAccount | null> {
  const { result } = await rpc.call<AccountInfoResult>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }])
  if (!result.value) return null
  const { data, owner, executable, lamports } = result.value
  return { data: new Uint8Array(Buffer.from(data[0], "base64")), owner, executable, lamports }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function resolveProgram(rpc: RpcClient, programId: string): Promise<NonNullable<ChainFacts["program"]>> {
  const account = await readAccount(rpc, programId)
  if (!account) throw new Error(`program ${programId}: account not found`)
  if (!account.executable) throw new Error(`program ${programId}: account is not executable`)
  if (account.owner !== UPGRADEABLE_LOADER) {
    // BPF loader v2 programs cannot be upgraded; other loaders are reported as found.
    return { id: programId, loader: account.owner, upgradeable: false, programData: null, upgradeAuthority: null, deploySlot: null, programLength: account.data.length }
  }
  const { programData } = decodeProgramAccount(account.data)
  const expected = await programDataPda(programId)
  if (programData !== expected) throw new Error(`program ${programId}: ProgramData ${programData} is not the loader PDA ${expected}`)
  const pd = await readAccount(rpc, programData)
  if (!pd) throw new Error(`program ${programId}: ProgramData ${programData} not found`)
  const decoded = decodeProgramData(pd.data)
  return { id: programId, loader: account.owner, upgradeable: decoded.upgradeAuthority !== null, programData, ...decoded }
}

export async function resolveVenue(rpc: RpcClient, programId: string, venue: string): Promise<NonNullable<ChainFacts["venue"]>> {
  const account = await readAccount(rpc, venue)
  if (!account) throw new Error(`venue ${venue}: account not found`)
  if (account.owner !== programId) throw new Error(`venue ${venue}: owned by ${account.owner}, not the venue program`)
  return { address: venue, ...decodeVenue(account.data) }
}

interface ParsedExtensions { value: { data: { parsed: { info: { extensions?: { extension: string; state?: Record<string, unknown> }[] } } } } | null }
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

export async function resolveToken(rpc: RpcClient, mint: string): Promise<TokenFacts> {
  const facts = await readFwdiMint(rpc, mint)
  let transferHook: TokenFacts["transferHook"] = null
  let pausable: TokenFacts["pausable"] = null
  if (facts.hasTransferHook || facts.hasPausable) {
    const { result } = await rpc.call<ParsedExtensions>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }])
    const extensions = result.value?.data.parsed.info.extensions ?? []
    const hook = extensions.find((e) => e.extension === "transferHook")?.state
    const pause = extensions.find((e) => /^pausable/i.test(e.extension))?.state
    if (hook) transferHook = { authority: str(hook.authority), programId: str(hook.programId) }
    if (pause) pausable = { authority: str(pause.authority), paused: pause.paused === true }
  }
  return {
    address: facts.address, name: facts.name, symbol: facts.symbol, tokenProgram: facts.tokenProgram, decimals: facts.decimals,
    mintAuthority: facts.mintAuthority, freezeAuthority: facts.freezeAuthority, permanentDelegate: facts.permanentDelegate,
    defaultAccountState: facts.defaultAccountState,
    metadataPointerAuthority: facts.metadataPointer?.authority ?? null,
    metadataUpdateAuthority: facts.metadata?.updateAuthority ?? null,
    scaledUiAuthority: facts.scaledUiAmount?.authority ?? null,
    transferHook, pausable, extensions: facts.extensions,
    readVia: "services/rehearsal readFwdiMint (getAccountInfo jsonParsed)",
    slot: facts.source.slot ?? 0,
  }
}

interface ProgramAccountsResult { pubkey: string; account: { data: [string, string] } }

/** SymbolRecords of this venue: program-account scan, plus the PDAs of any mints named by the caller. */
async function symbolAddresses(rpc: RpcClient, programId: string, venue: string, mints: string[], errors: string[]): Promise<string[]> {
  const found = new Set<string>()
  try {
    const { result } = await rpc.call<ProgramAccountsResult[]>("getProgramAccounts", [programId, {
      encoding: "base64", commitment: "confirmed", filters: [{ dataSize: SYMBOL_LEN }, { memcmp: { offset: 24, bytes: venue } }],
    }], { maxRetries: 1 })
    for (const r of result) found.add(r.pubkey)
  } catch (error) {
    errors.push(`symbol scan (getProgramAccounts) unavailable, using configured mints: ${message(error)}`)
  }
  for (const mint of mints) found.add(await symbolPda(programId, venue, mint))
  return [...found]
}

async function resolveSymbol(rpc: RpcClient, programId: string, venue: string, address: string, errors: string[]): Promise<SymbolFacts | null> {
  const account = await readAccount(rpc, address)
  if (!account) return null // a configured mint that is not registered yet
  if (account.owner !== programId) { errors.push(`symbol ${address}: owned by ${account.owner}`); return null }
  const s = decodeSymbol(account.data)
  if (s.venue !== venue) return null
  let pool: SymbolFacts["pool"] = null
  const poolAddress = await poolPda(programId, address)
  const poolAccount = await readAccount(rpc, poolAddress)
  if (poolAccount && poolAccount.owner === programId) {
    const p = decodePool(poolAccount.data)
    pool = {
      address: poolAddress, feeBps: p.feeBps, stockVault: p.stockVault, usdcVault: p.usdcVault, stockMint: p.stockMint, usdcMint: p.usdcMint,
      stockDecimals: p.stockDecimals, usdcDecimals: p.usdcDecimals, reserveStock: p.reserveStock, reserveUsdc: p.reserveUsdc, lpTotal: p.lpTotal,
    }
  }
  let token: TokenFacts | null = null
  try {
    token = await resolveToken(rpc, s.mint)
  } catch (error) {
    errors.push(`mint ${s.mint} (${s.ticker}): ${message(error)}`)
  }
  return {
    address, ticker: s.ticker, mint: s.mint, tier: s.tier, issuerSponsored: s.issuerSponsored, active: s.active, halted: s.halted,
    haltReason: s.haltReason, objected: s.objected, breachCount: s.breachCount, advShares: s.advShares, capShares: s.capShares,
    pausedUntil: s.pausedUntil, lastHeartbeat: s.lastHeartbeat, noticeReceivedAt: s.noticeReceivedAt, pool, token,
  }
}

export interface ResolveOptions {
  programId: string
  venue: string
  /** Mints to look up even if the program-account scan misses them (e.g. the config's listings). */
  mints?: string[]
  rpcUrl?: string
  rpc?: RpcClient
}

export async function resolveChainFacts(options: ResolveOptions): Promise<ChainFacts> {
  const local = options.rpcUrl !== undefined && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(options.rpcUrl)
  // A local fork needs no spacing; a public RPC keeps the rehearsal client's polite default.
  const rpc = options.rpc ?? createRpcClient({ url: options.rpcUrl, ...(local ? { minIntervalMs: 0 } : {}) })
  const errors: string[] = []
  const { result: slot } = await rpc.call<number>("getSlot", [{ commitment: "confirmed" }])
  const fetchedAt = new Date().toISOString()
  const program = await resolveProgram(rpc, options.programId).catch((error) => { errors.push(`program: ${message(error)}`); return null })
  const venue = await resolveVenue(rpc, options.programId, options.venue).catch((error) => { errors.push(`venue: ${message(error)}`); return null })
  const symbols: SymbolFacts[] = []
  if (venue) {
    for (const address of await symbolAddresses(rpc, options.programId, options.venue, options.mints ?? [], errors)) {
      const s = await resolveSymbol(rpc, options.programId, options.venue, address, errors).catch((error) => {
        errors.push(`symbol ${address}: ${message(error)}`); return null
      })
      if (s) symbols.push(s)
    }
    symbols.sort((a, b) => a.ticker.localeCompare(b.ticker))
  }
  return { rpcUrl: rpc.url, slot, fetchedAt, program, venue, symbols, errors }
}

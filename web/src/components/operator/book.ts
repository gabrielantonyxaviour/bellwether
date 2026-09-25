/**
 * On-chain operator book: every SymbolRecord for this venue, plus its pool when one exists.
 * Pooled symbols come from the tape. A symbol registered in this session is remembered until a pool exists.
 */
import type { Address } from "@solana/kit"
import { api } from "@/lib/api"
import { clusterConfig } from "@/lib/cluster"
import { decodePool, decodeSymbolRecord, decodeVenueConfig, poolPda, symbolPda, type Pool, type SymbolRecord, type VenueConfig } from "@/lib/program"
import { readAccount } from "@/lib/wallet-ui/chain"

/** Mints registered in this session before the tape has a pool for them. */
const rememberedMints = new Set<string>()
export function rememberMint(mint: string) { rememberedMints.add(mint) }

const CLOCK = "SysvarC1ock11111111111111111111111111111111" as Address


export interface BookRow {
  address: Address
  symbol: SymbolRecord
  pool: Pool | null
}

export interface OperatorBook {
  programId: Address
  venueAddress: Address
  venue: VenueConfig
  chainTime: number
  rows: BookRow[]
}

export async function readOperatorBook(signal?: AbortSignal): Promise<OperatorBook> {
  const config = clusterConfig()
  if (!config.programId || !config.venue) throw new Error("Venue program is not configured on this cluster")
  const programId = config.programId
  const venueAddress = config.venue
  const [clockRaw, venueRaw] = await Promise.all([readAccount(CLOCK, signal), readAccount(venueAddress, signal)])
  if (!clockRaw || clockRaw.length < 40) throw new Error("Clock sysvar is unavailable")
  if (!venueRaw) throw new Error("Venue account is not on this cluster")
  const chainTime = Number(new DataView(clockRaw.buffer, clockRaw.byteOffset, clockRaw.byteLength).getBigInt64(32, true))
  const venue = decodeVenueConfig(venueRaw)
  const rows = new Map<string, BookRow>()
  const add = async (symbolAddress: Address, raw: Uint8Array) => {
    let symbol: SymbolRecord
    try { symbol = decodeSymbolRecord(raw) } catch { return }
    if (symbol.venue !== venueAddress || rows.has(symbolAddress)) return
    const poolRaw = await readAccount(await poolPda(programId, symbolAddress), signal)
    rows.set(symbolAddress, { address: symbolAddress, symbol, pool: poolRaw ? decodePool(poolRaw) : null })
  }
  const mints = new Set<string>(rememberedMints)
  try {
    for (const pair of (await api.symbols(signal)).symbols) mints.add(pair.stock_mint)
  } catch { /* tape down */ }
  for (const mint of mints) {
    const symbolAddress = await symbolPda(programId, venueAddress, mint as Address)
    const raw = await readAccount(symbolAddress, signal)
    if (raw) await add(symbolAddress, raw)
  }
  return { programId, venueAddress, venue, chainTime, rows: [...rows.values()].sort((a, b) => a.symbol.ticker.localeCompare(b.symbol.ticker)) }
}

export function tickerOf(row: BookRow): string {
  return row.symbol.ticker || "Untitled"
}

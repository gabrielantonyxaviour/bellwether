/**
 * Read-only decoders for the venue accounts the tape needs (layouts: docs/program-contract.md,
 * programs/venue/src/state.rs). Byte 0 is the account kind, byte 1 the PDA bump.
 */
import { getAddressDecoder } from "@solana/kit"

export const POOL_KIND = 3
export const POOL_LEN = 192
export const SYMBOL_KIND = 2
export const SYMBOL_LEN = 168

export interface PoolAccount {
  stockDecimals: number
  usdcDecimals: number
  feeBps: number
  symbol: string
  stockMint: string
  usdcMint: string
  stockVault: string
  usdcVault: string
  reserveStock: bigint
  reserveUsdc: bigint
  lpTotal: bigint
}

export interface SymbolAccount {
  tier: number
  sponsored: boolean
  active: boolean
  halted: boolean
  ticker: string
  haltReason: string
  venue: string
  mint: string
  capShares: bigint
  sharesTradedToday: bigint
  lastHeartbeat: number
}

const keys = getAddressDecoder()

function view(data: Uint8Array) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    u8: (o: number) => data[o],
    u16: (o: number) => dv.getUint16(o, true),
    u64: (o: number) => dv.getBigUint64(o, true),
    i64: (o: number) => Number(dv.getBigInt64(o, true)),
    key: (o: number) => keys.decode(data.subarray(o, o + 32)),
    text: (o: number, n: number) => new TextDecoder().decode(data.subarray(o, o + n)).replace(/\0+$/, ""),
  }
}

export function decodePool(data: Uint8Array): PoolAccount | null {
  if (data.length < POOL_LEN || data[0] !== POOL_KIND) return null
  const v = view(data)
  return {
    stockDecimals: v.u8(2), usdcDecimals: v.u8(3), feeBps: v.u16(4), symbol: v.key(8),
    stockMint: v.key(40), usdcMint: v.key(72), stockVault: v.key(104), usdcVault: v.key(136),
    reserveStock: v.u64(168), reserveUsdc: v.u64(176), lpTotal: v.u64(184),
  }
}

export function decodeSymbol(data: Uint8Array): SymbolAccount | null {
  if (data.length < SYMBOL_LEN || data[0] !== SYMBOL_KIND) return null
  const v = view(data)
  return {
    tier: v.u8(2), sponsored: v.u8(3) !== 0, active: v.u8(4) !== 0, halted: v.u8(5) !== 0,
    ticker: v.text(8, 8), haltReason: v.text(16, 8), venue: v.key(24), mint: v.key(56),
    capShares: v.u64(96), sharesTradedToday: v.u64(120), lastHeartbeat: v.i64(136),
  }
}

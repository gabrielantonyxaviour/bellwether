/**
 * Shared test fixtures: a BWTRADE1 encoder mirroring programs/venue/src/swap.rs, and a sample swap.
 */
import { getAddressEncoder, type Address } from "@solana/kit"
import { EVENT_LEN, type TradeEvent } from "./event.js"

export const PROGRAM = "BwVenue111111111111111111111111111111111111"
export const OTHER = "Xther11111111111111111111111111111111111111"
export const POOL = "Poo1111111111111111111111111111111111111111"
export const STOCK = "Stock11111111111111111111111111111111111111"
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

export function encodeEvent(e: TradeEvent): Uint8Array {
  const b = new Uint8Array(EVENT_LEN)
  const v = new DataView(b.buffer)
  const enc = getAddressEncoder()
  b.set(new TextEncoder().encode("BWTRADE1"), 0)
  b.set(new TextEncoder().encode(e.ticker), 8)
  b.set(enc.encode(e.stockMint as Address), 16)
  b.set(enc.encode(e.usdcMint as Address), 48)
  b.set(enc.encode(e.pool as Address), 80)
  b.set(enc.encode(e.program as Address), 112)
  b[144] = e.direction
  b[145] = e.stockDecimals
  b[146] = e.usdcDecimals
  const u = (o: number, x: bigint) => v.setBigUint64(o, x, true)
  u(148, e.stockAmount); u(156, e.usdcAmount); u(164, e.priceUnits)
  v.setBigInt64(172, BigInt(e.time), true)
  u(180, e.shareUnits); v.setBigInt64(188, BigInt(e.tradeDate), true); u(196, e.sharesTradedToday)
  u(204, e.reserveStock); u(212, e.reserveUsdc); u(220, e.fee)
  return b
}

export function sampleEvent(over: Partial<TradeEvent> = {}): TradeEvent {
  return {
    ticker: "BWRS", stockMint: STOCK, usdcMint: USDC, pool: POOL, program: PROGRAM, direction: 0,
    stockDecimals: 6, usdcDecimals: 6, stockAmount: 39_880_159n, usdcAmount: 1_000_000_000n, priceUnits: 25_074_625n,
    time: 1_790_330_000, shareUnits: 39_880_159n, tradeDate: 20_721, sharesTradedToday: 39_880_159n,
    reserveStock: 9_960_119_841n, reserveUsdc: 251_000_000_000n, fee: 3_000_000n, ...over,
  }
}

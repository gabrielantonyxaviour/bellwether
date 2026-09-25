/**
 * From a decoded event to a stored print, and exact decimal formatting for the public tape.
 *
 * USD method (disclosed on /venue): the paired asset is USDC, counted at $1.00 par, so the
 * stock's USD price is the USDC leg divided by the stock leg, as the program computes it.
 */
import type { TradeEvent } from "./event.js"
import { SELL } from "./event.js"
import type { PoolSnapshot, TapePrint } from "./store.js"

export const PAIRED_SYMBOL = "USDC"
export const USD_METHOD =
  "USDC leg at $1.00 par: price_usd = USDC paid or received ÷ shares, from the program's own event; pool stock marked at the pool's reserve ratio"

export function toPrint(event: TradeEvent, at: { signature: string; eventIndex: number; slot: number; indexedAt: number }): TapePrint {
  return {
    signature: at.signature,
    eventIndex: at.eventIndex,
    slot: at.slot,
    program: event.program,
    pool: event.pool,
    ticker: event.ticker,
    stockMint: event.stockMint,
    usdcMint: event.usdcMint,
    side: event.direction === SELL ? "sell" : "buy",
    stockDecimals: event.stockDecimals,
    usdcDecimals: event.usdcDecimals,
    stockAmount: event.stockAmount,
    usdcAmount: event.usdcAmount,
    priceUnits: event.priceUnits,
    time: event.time,
    shareUnits: event.shareUnits,
    tradeDate: event.tradeDate,
    sharesTradedToday: event.sharesTradedToday,
    reserveStock: event.reserveStock,
    reserveUsdc: event.reserveUsdc,
    fee: event.fee,
    indexedAt: at.indexedAt,
  }
}

/** Base units → fixed-point decimal string with exactly `decimals` fraction digits. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0")
  const whole = digits.slice(0, digits.length - decimals)
  const frac = digits.slice(digits.length - decimals)
  return `${negative ? "-" : ""}${whole}${decimals > 0 ? `.${frac}` : ""}`
}

export function pairName(ticker: string): string {
  return `${ticker}/${PAIRED_SYMBOL}`
}

export function tradeDateIso(dayIndex: number): string {
  return new Date(dayIndex * 86_400_000).toISOString().slice(0, 10)
}

export interface PoolSizeView {
  as_of: string
  slot: number
  source: PoolSnapshot["source"]
  /** Whole tokens of the stock mint held by the pool. */
  stock_tokens: string
  usdc: string
  /** USDC reserve plus the stock reserve marked at the pool's own reserve ratio. */
  usd: string
}

/** A snapshot in public units. With the stock marked at usdc/stock, the stock leg is worth the USDC leg. */
export function poolSizeView(snapshot: PoolSnapshot, decimals: { stock: number; usdc: number }, iso: (t: number) => string): PoolSizeView {
  const stockValue = snapshot.reserveStock === 0n ? 0n : snapshot.reserveUsdc
  return {
    as_of: iso(snapshot.time),
    slot: snapshot.slot,
    source: snapshot.source,
    stock_tokens: formatUnits(snapshot.reserveStock, decimals.stock),
    usdc: formatUnits(snapshot.reserveUsdc, decimals.usdc),
    usd: formatUnits(snapshot.reserveUsdc + stockValue, decimals.usdc),
  }
}

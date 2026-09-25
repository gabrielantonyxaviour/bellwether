/**
 * Public JSON shapes of the tape. Amounts are exact decimal strings (never floats); times are
 * ISO 8601 UTC. Field names follow the order's transparency list (REGULATION.md §5).
 */
import { PAIRED_SYMBOL, formatUnits, pairName, poolSizeView, tradeDateIso, type PoolSizeView } from "../indexer/print.js"
import { DAY_S, isoTime, type PoolInfo, type PoolSnapshot, type PrintWithVolume, type TapePrint, type Volume } from "../indexer/store.js"

export interface VolumeView {
  window: "rolling_24h"
  from: string
  to: string
  shares: string
  usd: string
  trades: number
}

export function volumeView(v: Volume, to: number, decimals: { stock: number; usdc: number }): VolumeView {
  return {
    window: "rolling_24h",
    from: isoTime(to - DAY_S),
    to: isoTime(to),
    shares: formatUnits(v.shareUnits, decimals.stock),
    usd: formatUnits(v.usdcUnits, decimals.usdc),
    trades: v.trades,
  }
}

export type EodView = (PoolSizeView & { date: string }) | null

export function eodView(snapshot: PoolSnapshot | null, date: string, decimals: { stock: number; usdc: number }): EodView {
  return snapshot ? { date, ...poolSizeView(snapshot, decimals, isoTime) } : null
}

export function printView(p: PrintWithVolume, eod: EodView) {
  const dec = { stock: p.stockDecimals, usdc: p.usdcDecimals }
  const buy = p.side === "buy"
  return {
    signature: p.signature,
    event_index: p.eventIndex,
    slot: p.slot,
    pair: pairName(p.ticker),
    symbol: p.ticker,
    paired_symbol: PAIRED_SYMBOL,
    price_usd: formatUnits(p.priceUnits, p.usdcDecimals),
    size_shares: formatUnits(p.shareUnits, p.stockDecimals),
    size_tokens: formatUnits(p.stockAmount, p.stockDecimals),
    size_usdc: formatUnits(p.usdcAmount, p.usdcDecimals),
    notional_usd: formatUnits(p.usdcAmount, p.usdcDecimals),
    time: isoTime(p.time),
    unix_time: p.time,
    published_at: new Date(p.indexedAt).toISOString(),
    direction: p.side,
    asset_in: buy ? PAIRED_SYMBOL : p.ticker,
    asset_out: buy ? p.ticker : PAIRED_SYMBOL,
    pool: p.pool,
    program: p.program,
    stock_mint: p.stockMint,
    usdc_mint: p.usdcMint,
    fee: { asset: buy ? PAIRED_SYMBOL : p.ticker, amount: formatUnits(p.fee, buy ? p.usdcDecimals : p.stockDecimals) },
    trade_date: tradeDateIso(p.tradeDate),
    daily_volume: volumeView(p.rolling24h, p.time, dec),
    pool_after: { stock_tokens: formatUnits(p.reserveStock, p.stockDecimals), usdc: formatUnits(p.reserveUsdc, p.usdcDecimals) },
    eod_pool_size: eod,
  }
}

export function pairView(pool: PoolInfo, extra: { rolling: Volume; rollingTo: number; eod: EodView; last: TapePrint | null }) {
  const dec = { stock: pool.stockDecimals, usdc: pool.usdcDecimals }
  return {
    pair: pairName(pool.ticker),
    symbol: pool.ticker,
    paired_symbol: PAIRED_SYMBOL,
    pool: pool.pool,
    program: pool.program,
    stock_mint: pool.stockMint,
    usdc_mint: pool.usdcMint,
    stock_decimals: pool.stockDecimals,
    usdc_decimals: pool.usdcDecimals,
    fee_bps: pool.feeBps,
    halted: pool.halted,
    active: pool.active,
    last_price_usd: extra.last ? formatUnits(extra.last.priceUnits, extra.last.usdcDecimals) : null,
    last_trade_at: extra.last ? isoTime(extra.last.time) : null,
    rolling_24h: volumeView(extra.rolling, extra.rollingTo, dec),
    eod_pool_size: extra.eod,
  }
}

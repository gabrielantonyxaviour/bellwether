/**
 * The tape's storage seam. The indexer writes through it and the API reads through it; the
 * SQLite implementation (sql-store.ts) runs on node:sqlite locally and on any SQLite that can
 * run the same statements (a SQLite-backed Durable Object) when hosted.
 */

export type Side = "buy" | "sell"

/** One swap as stored: the decoded event plus where and when it was seen. */
export interface TapePrint {
  signature: string
  eventIndex: number
  slot: number
  program: string
  pool: string
  ticker: string
  stockMint: string
  usdcMint: string
  side: Side
  stockDecimals: number
  usdcDecimals: number
  stockAmount: bigint
  usdcAmount: bigint
  priceUnits: bigint
  /** Unix seconds at the pool (the swap's Clock). */
  time: number
  shareUnits: bigint
  tradeDate: number
  sharesTradedToday: bigint
  reserveStock: bigint
  reserveUsdc: bigint
  fee: bigint
  /** Unix milliseconds when the indexer stored it. */
  indexedAt: number
}

export interface Volume {
  shareUnits: bigint
  usdcUnits: bigint
  trades: number
}

/** A print with the pair's rolling 24-hour volume ending at (and including) that print. */
export interface PrintWithVolume extends TapePrint {
  rolling24h: Volume
}

export interface PoolInfo {
  pool: string
  program: string
  ticker: string
  stockMint: string
  usdcMint: string
  stockDecimals: number
  usdcDecimals: number
  symbolRecord: string | null
  feeBps: number | null
  halted: boolean | null
  active: boolean | null
  /** Unix milliseconds. */
  updatedAt: number
}

export interface PoolSnapshot {
  pool: string
  /** Unix seconds of the observation. */
  time: number
  slot: number
  /** Order inside the slot: the event index for prints, ACCOUNT_ORD for account reads. */
  ord: number
  reserveStock: bigint
  reserveUsdc: bigint
  source: "print" | "account"
}

export const ACCOUNT_ORD = 1_000_000

/** The indexer's health, written to meta under STATUS_KEY and served on /venue. */
export interface IndexerStatus {
  program: string
  ws: "off" | "connecting" | "open" | "subscribed" | "closed"
  lastSlot: number
  lastBackfillAt: number | null
  lastPoolRefreshAt: number | null
  printsIndexed: number
  lastError: string | null
  updatedAt: number
}

export const STATUS_KEY = "indexer:status"

export interface PrintQuery {
  /** UTC calendar date, YYYY-MM-DD. */
  date: string
  symbol?: string
  side?: Side
}

export interface TapeStore {
  /** False when the print (signature, eventIndex) was already stored. */
  insertPrint(print: TapePrint): Promise<boolean>
  listPrints(query: PrintQuery): Promise<PrintWithVolume[]>
  /** Pair volume over (at − 24 h, at]. */
  rolling24h(pool: string, at: number): Promise<Volume>
  /** Pool size at the end of `date` (UTC), or as of `now` while that day is still running. */
  eodPoolSize(pool: string, date: string, now: number): Promise<PoolSnapshot | null>
  latestSnapshot(pool: string): Promise<PoolSnapshot | null>
  insertSnapshot(snapshot: PoolSnapshot): Promise<void>
  upsertPool(pool: PoolInfo): Promise<void>
  listPools(): Promise<PoolInfo[]>
  lastPrint(pool: string): Promise<TapePrint | null>
  /** Drops prints and snapshots older than `before` (unix s), keeping each pool's latest snapshot. */
  prune(before: number): Promise<number>
  getMeta(key: string): Promise<string | null>
  setMeta(key: string, value: string): Promise<void>
}

export const DAY_S = 86_400
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** [start, end) unix seconds of a UTC calendar date; null when the string is not a real date. */
export function utcDayBounds(date: string): { start: number; end: number } | null {
  const m = DATE_RE.exec(date)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (new Date(ms).toISOString().slice(0, 10) !== date) return null
  return { start: ms / 1000, end: ms / 1000 + DAY_S }
}

export function utcDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

export function isoTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z")
}

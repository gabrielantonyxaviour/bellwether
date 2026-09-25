/**
 * TapeStore over plain SQLite statements, behind a three-method driver so the same SQL runs on
 * node:sqlite (node-sqlite.ts) and on a SQLite-backed Durable Object (wrap `ctx.storage.sql`).
 * u64 amounts are bound as decimal strings (INTEGER affinity stores them exactly) and read back
 * through BigInt(), so drivers that return numbers or bigints both work.
 */
import {
  DAY_S, utcDayBounds,
  type PoolInfo, type PoolSnapshot, type PrintQuery, type PrintWithVolume, type TapePrint, type TapeStore, type Volume,
} from "./store.js"

export type SqlValue = string | number | null
export type Row = Record<string, unknown>

export interface SqlDriver {
  exec(sql: string): void | Promise<void>
  all(sql: string, params?: SqlValue[]): Row[] | Promise<Row[]>
  run(sql: string, params?: SqlValue[]): { changes: number } | Promise<{ changes: number }>
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS prints (
  signature TEXT NOT NULL, event_index INTEGER NOT NULL, slot INTEGER NOT NULL,
  program TEXT NOT NULL, pool TEXT NOT NULL, ticker TEXT NOT NULL, stock_mint TEXT NOT NULL, usdc_mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')), stock_decimals INTEGER NOT NULL, usdc_decimals INTEGER NOT NULL,
  stock_amount INTEGER NOT NULL, usdc_amount INTEGER NOT NULL, price_units INTEGER NOT NULL, time INTEGER NOT NULL,
  share_units INTEGER NOT NULL, trade_date INTEGER NOT NULL, shares_traded_today INTEGER NOT NULL,
  reserve_stock INTEGER NOT NULL, reserve_usdc INTEGER NOT NULL, fee INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS prints_time ON prints (time);
CREATE INDEX IF NOT EXISTS prints_pool_time ON prints (pool, time);
CREATE TABLE IF NOT EXISTS pools (
  pool TEXT PRIMARY KEY, program TEXT NOT NULL, ticker TEXT NOT NULL, stock_mint TEXT NOT NULL, usdc_mint TEXT NOT NULL,
  stock_decimals INTEGER NOT NULL, usdc_decimals INTEGER NOT NULL, symbol_record TEXT, fee_bps INTEGER,
  halted INTEGER, active INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pool_snapshots (
  pool TEXT NOT NULL, time INTEGER NOT NULL, slot INTEGER NOT NULL, ord INTEGER NOT NULL,
  reserve_stock INTEGER NOT NULL, reserve_usdc INTEGER NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (pool, slot, ord)
);
CREATE INDEX IF NOT EXISTS pool_snapshots_time ON pool_snapshots (pool, time);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(v as string | number | bigint))
const num = (v: unknown): number => Number(v)
const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) !== 0)

function printFromRow(r: Row): TapePrint {
  return {
    signature: String(r.signature), eventIndex: num(r.event_index), slot: num(r.slot),
    program: String(r.program), pool: String(r.pool), ticker: String(r.ticker),
    stockMint: String(r.stock_mint), usdcMint: String(r.usdc_mint), side: r.side === "sell" ? "sell" : "buy",
    stockDecimals: num(r.stock_decimals), usdcDecimals: num(r.usdc_decimals),
    stockAmount: big(r.stock_amount), usdcAmount: big(r.usdc_amount), priceUnits: big(r.price_units),
    time: num(r.time), shareUnits: big(r.share_units), tradeDate: num(r.trade_date),
    sharesTradedToday: big(r.shares_traded_today), reserveStock: big(r.reserve_stock), reserveUsdc: big(r.reserve_usdc),
    fee: big(r.fee), indexedAt: num(r.indexed_at),
  }
}

function snapshotFromRow(r: Row): PoolSnapshot {
  return {
    pool: String(r.pool), time: num(r.time), slot: num(r.slot), ord: num(r.ord),
    reserveStock: big(r.reserve_stock), reserveUsdc: big(r.reserve_usdc), source: r.source === "account" ? "account" : "print",
  }
}

export class SqlTapeStore implements TapeStore {
  private constructor(private readonly db: SqlDriver) {}

  static async open(db: SqlDriver): Promise<SqlTapeStore> {
    await db.exec(SCHEMA)
    return new SqlTapeStore(db)
  }

  async insertPrint(p: TapePrint): Promise<boolean> {
    const { changes } = await this.db.run(
      `INSERT OR IGNORE INTO prints VALUES (${Array(22).fill("?").join(",")})`,
      [
        p.signature, p.eventIndex, p.slot, p.program, p.pool, p.ticker, p.stockMint, p.usdcMint, p.side,
        p.stockDecimals, p.usdcDecimals, String(p.stockAmount), String(p.usdcAmount), String(p.priceUnits), p.time,
        String(p.shareUnits), p.tradeDate, String(p.sharesTradedToday), String(p.reserveStock), String(p.reserveUsdc),
        String(p.fee), p.indexedAt,
      ],
    )
    return changes > 0
  }

  async listPrints(q: PrintQuery): Promise<PrintWithVolume[]> {
    const day = utcDayBounds(q.date)
    if (!day) throw new Error(`not a UTC date: ${q.date}`)
    // The window sees the previous 24 h too, so the first print of the day carries yesterday's tail.
    const filters: string[] = ["time >= ?", "time < ?"]
    const params: SqlValue[] = [day.start - DAY_S, day.end, day.start, day.end]
    if (q.symbol) { filters.push("ticker = ?"); params.push(q.symbol) }
    if (q.side) { filters.push("side = ?"); params.push(q.side) }
    const rows = await this.db.all(
      `WITH w AS (
         SELECT p.*, SUM(share_units) OVER win AS vol_shares, SUM(usdc_amount) OVER win AS vol_usdc, COUNT(*) OVER win AS vol_trades
         FROM prints p WHERE time > ? AND time < ?
         WINDOW win AS (PARTITION BY pool ORDER BY time RANGE BETWEEN ${DAY_S - 1} PRECEDING AND CURRENT ROW)
       )
       SELECT * FROM w WHERE ${filters.join(" AND ")} ORDER BY time, slot, signature, event_index`,
      params,
    )
    return rows.map((r) => ({
      ...printFromRow(r),
      rolling24h: { shareUnits: big(r.vol_shares), usdcUnits: big(r.vol_usdc), trades: num(r.vol_trades) },
    }))
  }

  async rolling24h(pool: string, at: number): Promise<Volume> {
    const [r] = await this.db.all(
      "SELECT COALESCE(SUM(share_units), 0) AS s, COALESCE(SUM(usdc_amount), 0) AS u, COUNT(*) AS n FROM prints WHERE pool = ? AND time > ? AND time <= ?",
      [pool, at - DAY_S, at],
    )
    return { shareUnits: big(r.s), usdcUnits: big(r.u), trades: num(r.n) }
  }

  async eodPoolSize(pool: string, date: string, now: number): Promise<PoolSnapshot | null> {
    const day = utcDayBounds(date)
    if (!day) throw new Error(`not a UTC date: ${date}`)
    const at = Math.min(day.end - 1, now)
    const rows = await this.db.all(
      "SELECT * FROM pool_snapshots WHERE pool = ? AND time <= ? ORDER BY slot DESC, ord DESC LIMIT 1",
      [pool, at],
    )
    return rows[0] ? snapshotFromRow(rows[0]) : null
  }

  async latestSnapshot(pool: string): Promise<PoolSnapshot | null> {
    const rows = await this.db.all("SELECT * FROM pool_snapshots WHERE pool = ? ORDER BY slot DESC, ord DESC LIMIT 1", [pool])
    return rows[0] ? snapshotFromRow(rows[0]) : null
  }

  async insertSnapshot(s: PoolSnapshot): Promise<void> {
    await this.db.run(
      "INSERT OR REPLACE INTO pool_snapshots (pool, time, slot, ord, reserve_stock, reserve_usdc, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [s.pool, s.time, s.slot, s.ord, String(s.reserveStock), String(s.reserveUsdc), s.source],
    )
  }

  async upsertPool(p: PoolInfo): Promise<void> {
    const flag = (b: boolean | null) => (b === null ? null : b ? 1 : 0)
    await this.db.run(
      `INSERT INTO pools (pool, program, ticker, stock_mint, usdc_mint, stock_decimals, usdc_decimals, symbol_record, fee_bps, halted, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pool) DO UPDATE SET
         program = excluded.program, ticker = excluded.ticker, stock_mint = excluded.stock_mint, usdc_mint = excluded.usdc_mint,
         stock_decimals = excluded.stock_decimals, usdc_decimals = excluded.usdc_decimals,
         symbol_record = COALESCE(excluded.symbol_record, pools.symbol_record), fee_bps = COALESCE(excluded.fee_bps, pools.fee_bps),
         halted = COALESCE(excluded.halted, pools.halted), active = COALESCE(excluded.active, pools.active),
         updated_at = excluded.updated_at`,
      [p.pool, p.program, p.ticker, p.stockMint, p.usdcMint, p.stockDecimals, p.usdcDecimals, p.symbolRecord, p.feeBps, flag(p.halted), flag(p.active), p.updatedAt],
    )
  }

  async listPools(): Promise<PoolInfo[]> {
    const rows = await this.db.all("SELECT * FROM pools ORDER BY ticker, pool")
    return rows.map((r) => ({
      pool: String(r.pool), program: String(r.program), ticker: String(r.ticker), stockMint: String(r.stock_mint),
      usdcMint: String(r.usdc_mint), stockDecimals: num(r.stock_decimals), usdcDecimals: num(r.usdc_decimals),
      symbolRecord: r.symbol_record === null ? null : String(r.symbol_record),
      feeBps: r.fee_bps === null ? null : num(r.fee_bps), halted: bool(r.halted), active: bool(r.active), updatedAt: num(r.updated_at),
    }))
  }

  async lastPrint(pool: string): Promise<TapePrint | null> {
    const rows = await this.db.all("SELECT * FROM prints WHERE pool = ? ORDER BY time DESC, slot DESC, event_index DESC LIMIT 1", [pool])
    return rows[0] ? printFromRow(rows[0]) : null
  }

  async prune(before: number): Promise<number> {
    const prints = await this.db.run("DELETE FROM prints WHERE time < ?", [before])
    const snaps = await this.db.run(
      `DELETE FROM pool_snapshots WHERE time < ? AND rowid NOT IN (
         SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY pool ORDER BY slot DESC, ord DESC) AS rn FROM pool_snapshots) WHERE rn = 1
       )`,
      [before],
    )
    return prints.changes + snaps.changes
  }

  async getMeta(key: string): Promise<string | null> {
    const rows = await this.db.all("SELECT value FROM meta WHERE key = ?", [key])
    return rows[0] ? String(rows[0].value) : null
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value])
  }
}


/**
 * The public venue API: free, JSON, CORS-open, read-only. Query parameters are zod-validated and
 * every error is { error, code? } with no internals. Runtime-neutral (Hono): Node serves it via
 * main.ts; a Worker can serve the same app over a Durable Object-backed TapeStore.
 *
 *   GET /tape?date=YYYY-MM-DD&symbol=BWRS&side=buy|sell   prints of one UTC day (default today)
 *   GET /symbols                                          pairs with last price, rolling 24 h volume, pool size
 *   GET /venue                                            program, pools, USD method, retention, indexer health
 *   GET /halts?symbol=                                    the halt relay's ledger
 */
import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { z } from "zod"
import { USD_METHOD } from "../indexer/print.js"
import { DAY_S, STATUS_KEY, utcDate, utcDayBounds, type IndexerStatus, type PoolInfo, type TapeStore } from "../indexer/store.js"
import { HaltLedgerUnreadable, type HaltSource } from "./halts.js"
import { eodView, pairView, printView } from "./present.js"

export interface ApiDeps {
  store: TapeStore
  halts: HaltSource
  venue: { programId: string; cluster: string; retentionDays: number }
  /** Unix milliseconds; injectable for tests. */
  now?: () => number
}

const DateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((d) => utcDayBounds(d) !== null, "date is not a calendar date")
const SymbolParam = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9.]{1,8}$/, "symbol must be 1-8 letters, digits or dots")
  .transform((s) => s.toUpperCase())
const TapeQuery = z.object({ date: DateParam.optional(), symbol: SymbolParam.optional(), side: z.enum(["buy", "sell"]).optional() })
const HaltsQuery = z.object({ symbol: SymbolParam.optional() })

/** A watcher that has not written status for this long is reported stale. */
const STALE_MS = 5 * 60_000

class ApiError extends Error {
  constructor(readonly status: 400 | 404 | 503, message: string, readonly code: string) {
    super(message)
  }
}

function parseQuery<T extends z.ZodTypeAny>(schema: T, c: Context): z.infer<T> {
  const parsed = schema.safeParse(c.req.query())
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ApiError(400, `invalid ${issue.path.join(".") || "query"}: ${issue.message}`, "invalid_query")
  }
  return parsed.data
}

export function createApp(deps: ApiDeps): Hono {
  const nowMs = deps.now ?? Date.now
  const nowS = () => Math.floor(nowMs() / 1000)
  const app = new Hono()

  app.use("*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], maxAge: 86_400 }))
  app.use("*", async (c, next) => {
    await next()
    if (c.res.status === 200) c.header("cache-control", "public, max-age=5")
  })

  async function pairFor(pool: PoolInfo, date: string) {
    const day = utcDayBounds(date)!
    const to = Math.min(day.end - 1, nowS())
    const dec = { stock: pool.stockDecimals, usdc: pool.usdcDecimals }
    const [rolling, eod, last] = await Promise.all([
      deps.store.rolling24h(pool.pool, to),
      deps.store.eodPoolSize(pool.pool, date, nowS()),
      deps.store.lastPrint(pool.pool),
    ])
    return { pool, view: pairView(pool, { rolling, rollingTo: to, eod: eodView(eod, date, dec), last }) }
  }

  app.get("/", (c) =>
    c.json({
      name: "Bellwether venue API",
      free: true,
      format: "application/json",
      endpoints: {
        "/tape": "prints of one UTC day: ?date=YYYY-MM-DD (default today) &symbol= &side=buy|sell",
        "/symbols": "pairs with last price, rolling 24-hour share volume and pool size",
        "/venue": "program (contract) address, pools, USD method, retention and indexer health",
        "/halts": "halt ledger mirrored from the primary listing exchange: ?symbol=",
      },
    }))

  app.get("/tape", async (c) => {
    const q = parseQuery(TapeQuery, c)
    const today = utcDate(nowS())
    const date = q.date ?? today
    const oldest = utcDate(nowS() - deps.venue.retentionDays * DAY_S)
    if (date > today) throw new ApiError(400, `date ${date} is in the future (today is ${today} UTC)`, "date_in_future")
    if (date < oldest) throw new ApiError(400, `the tape keeps ${deps.venue.retentionDays} days; the oldest date served is ${oldest}`, "date_out_of_retention")
    const prints = await deps.store.listPrints({ date, symbol: q.symbol, side: q.side })
    const pools = (await deps.store.listPools()).filter((p) => !q.symbol || p.ticker === q.symbol)
    const pairs = await Promise.all(pools.map((p) => pairFor(p, date)))
    const eodByPool = new Map(pairs.map((p) => [p.pool.pool, p.view.eod_pool_size]))
    return c.json({
      date,
      filters: { symbol: q.symbol ?? null, side: q.side ?? null },
      generated_at: new Date(nowMs()).toISOString(),
      usd_method: USD_METHOD,
      retention_days: deps.venue.retentionDays,
      count: prints.length,
      prints: prints.map((p) => printView(p, eodByPool.get(p.pool) ?? null)),
      pairs: pairs.map((p) => p.view),
    })
  })

  app.get("/symbols", async (c) => {
    const today = utcDate(nowS())
    const pairs = await Promise.all((await deps.store.listPools()).map((p) => pairFor(p, today)))
    return c.json({ generated_at: new Date(nowMs()).toISOString(), symbols: pairs.map((p) => p.view) })
  })

  app.get("/venue", async (c) => {
    const today = utcDate(nowS())
    const pairs = await Promise.all((await deps.store.listPools()).map((p) => pairFor(p, today)))
    const raw = await deps.store.getMeta(STATUS_KEY)
    const status = raw ? (JSON.parse(raw) as IndexerStatus) : null
    return c.json({
      name: "Bellwether",
      program: deps.venue.programId,
      cluster: deps.venue.cluster,
      generated_at: new Date(nowMs()).toISOString(),
      usd_method: USD_METHOD,
      retention_days: deps.venue.retentionDays,
      transparency: { free: true, format: "application/json", publication_target: "seconds (order limit: 10 minutes)", time_zone: "UTC" },
      pools: pairs.map(({ view }) => ({ ...view, contract_address: view.program })),
      indexer: status && {
        ws: status.ws,
        last_slot: status.lastSlot,
        last_backfill_at: status.lastBackfillAt ? new Date(status.lastBackfillAt).toISOString() : null,
        last_pool_refresh_at: status.lastPoolRefreshAt ? new Date(status.lastPoolRefreshAt).toISOString() : null,
        prints_indexed_since_start: status.printsIndexed,
        last_error: status.lastError,
        updated_at: new Date(status.updatedAt).toISOString(),
        stale: nowMs() - status.updatedAt > STALE_MS,
      },
    })
  })

  app.get("/halts", async (c) => {
    const q = parseQuery(HaltsQuery, c)
    const list = await deps.halts.list()
    const entries = q.symbol ? list.entries.filter((e) => e.symbol === q.symbol) : list.entries
    return c.json({ generated_at: new Date(nowMs()).toISOString(), source: list.source, skipped: list.skipped, relay: list.relay, halts: entries })
  })

  app.notFound((c) => c.json({ error: `no route ${c.req.method} ${c.req.path}`, code: "not_found" }, 404))
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: error.message, code: error.code }, error.status)
    if (error instanceof HaltLedgerUnreadable) return c.json({ error: "the halt ledger cannot be read right now", code: "halts_unavailable" }, 503)
    return c.json({ error: "internal error", code: "internal" }, 500)
  })
  return app
}

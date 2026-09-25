/**
 * The venue API over an in-memory store: response fields, validation errors in {error, code}
 * form, CORS, and the halt ledger's missing / present / corrupt cases.
 *   npx tsx --test services/api/*.test.ts
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { openNodeSqlite } from "../indexer/node-sqlite.js"
import { toPrint } from "../indexer/print.js"
import { SqlTapeStore } from "../indexer/sql-store.js"
import { STATUS_KEY, utcDayBounds } from "../indexer/store.js"
import { POOL, PROGRAM, sampleEvent } from "../indexer/test-fixtures.js"
import { createApp, type ApiDeps } from "./app.js"
import { fileHaltSource } from "./halts-file.js"

const DAY = utcDayBounds("2026-09-25")!
const NOW_MS = (DAY.start + 12 * 3600) * 1000
const dir = mkdtempSync(join(tmpdir(), "bellwether-api-test-"))
process.on("exit", () => rmSync(dir, { recursive: true, force: true }))

async function appWith(haltPath = join(dir, "missing.json"), marketFetch?: typeof fetch, extra: Partial<ApiDeps> = {}) {
  const store = await SqlTapeStore.open(openNodeSqlite(":memory:"))
  const at = (signature: string, time: number, direction: 0 | 1, stock: bigint, usdc: bigint) =>
    store.insertPrint(toPrint(sampleEvent({ time, direction, stockAmount: stock, shareUnits: stock, usdcAmount: usdc, priceUnits: (usdc * 1_000_000n) / stock }), { signature, eventIndex: 0, slot: time, indexedAt: time * 1000 + 800 }))
  await at("buy1", DAY.start + 3600, 0, 40_000_000n, 1_000_000_000n)
  await at("sell1", DAY.start + 7200, 1, 10_000_000n, 249_000_000n)
  await store.upsertPool({ pool: POOL, program: PROGRAM, ticker: "BWRS", stockMint: sampleEvent().stockMint, usdcMint: sampleEvent().usdcMint, stockDecimals: 6, usdcDecimals: 6, symbolRecord: null, feeBps: 30, halted: false, active: true, updatedAt: 0 })
  await store.insertSnapshot({ pool: POOL, time: DAY.start + 7200, slot: DAY.start + 7200, ord: 0, reserveStock: 9_970_000_000n, reserveUsdc: 250_751_000_000n, source: "print" })
  await store.setMeta(STATUS_KEY, JSON.stringify({ program: PROGRAM, ws: "subscribed", lastSlot: 9, lastBackfillAt: NOW_MS, lastPoolRefreshAt: null, printsIndexed: 2, lastError: null, updatedAt: NOW_MS - 1000 }))
  return createApp({ store, halts: fileHaltSource(haltPath), venue: { programId: PROGRAM, cluster: "fork", retentionDays: 35 }, now: () => NOW_MS, marketFetch, ...extra })
}

test("FWDI report refresh requires an operator token and enforces the ten-minute limit", async () => {
  const report = JSON.parse(readFileSync("services/rehearsal/latest-report.json", "utf8"))
  let refreshes = 0
  const app = await appWith(undefined, undefined, {
    operatorToken: "long-operator-token",
    rehearsalReport: async (refresh) => { if (refresh) refreshes++; return report },
  })
  assert.equal((await app.request("/rehearsal/fwdi")).status, 200)
  const denied = await app.request("/rehearsal/fwdi?refresh=1")
  assert.deepEqual(await json(denied), { error: "operator token required", code: "unauthorized" })
  const auth = { authorization: "Bearer long-operator-token" }
  assert.equal((await app.request("/rehearsal/fwdi?refresh=1", { headers: auth })).status, 200)
  const repeated = await app.request("/rehearsal/fwdi?refresh=1", { headers: auth })
  assert.equal(repeated.status, 429)
  assert.equal(refreshes, 1)
  assert.equal((await app.request("/notice/draft")).status, 503)
})

test("GET /market/FWDI validates the Yahoo chart, caches it, and reports outages", async () => {
  const fixture = JSON.parse(readFileSync("services/caps/fixtures/fwdi-2026-08.json", "utf8"))
  let calls = 0
  const marketFetch: typeof fetch = async () => { calls++; return Response.json(fixture.responses.yahoo.body) }
  const app = await appWith(join(dir, "missing.json"), marketFetch)
  const first = await app.request("/market/FWDI?range=6mo&interval=1d")
  assert.equal(first.status, 200)
  assert.equal(first.headers.get("cache-control"), "public, max-age=300")
  const result = await json(first)
  assert.equal(result.chart.result[0].meta.symbol, "FWDI")
  assert.ok(result.chart.result[0].timestamp.length > 0)
  assert.equal((await app.request("/market/FWDI?range=6mo")).status, 200)
  assert.equal(calls, 1, "the second read uses the five-minute cache")
  assert.equal((await app.request("/market/FWDI?range=all")).status, 400)
  assert.equal((await app.request("/market/OTHER")).status, 404)

  const failed = await appWith(join(dir, "missing.json"), async () => new Response("upstream failure", { status: 503 }))
  const unavailable = await failed.request("/market/FWDI")
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await json(unavailable), { error: "underlying stock market data is unavailable", code: "market_unavailable" })
})

const json = async (res: Response): Promise<any> => res.json()

test("GET /tape: every transparency field, rolling 24 h volume and end-of-day pool size", async () => {
  const app = await appWith()
  const res = await app.request("/tape?date=2026-09-25")
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("access-control-allow-origin"), null, "no origin means no CORS header")
  const body = await json(res)
  assert.equal(body.count, 2)
  const [buy, sell] = body.prints
  assert.deepEqual(
    [buy.pair, buy.symbol, buy.paired_symbol, buy.price_usd, buy.size_shares, buy.size_usdc, buy.time, buy.direction, buy.asset_in, buy.asset_out, buy.pool, buy.program],
    ["BWRS/USDC", "BWRS", "USDC", "25.000000", "40.000000", "1000.000000", "2026-09-25T01:00:00Z", "buy", "USDC", "BWRS", POOL, PROGRAM],
  )
  assert.equal(sell.direction, "sell")
  assert.equal(sell.asset_in, "BWRS")
  assert.equal(sell.daily_volume.shares, "50.000000")
  assert.equal(sell.daily_volume.usd, "1249.000000")
  assert.equal(sell.eod_pool_size.stock_tokens, "9970.000000")
  assert.equal(sell.eod_pool_size.usdc, "250751.000000")
  const [pair] = body.pairs
  assert.equal(pair.rolling_24h.shares, "50.000000")
  assert.equal(pair.rolling_24h.to, "2026-09-25T12:00:00Z")
  assert.equal(pair.last_price_usd, "24.900000")
  assert.equal(pair.eod_pool_size.date, "2026-09-25")
})

test("GET /tape filters by symbol and side, defaults to today, and validates", async () => {
  const app = await appWith()
  assert.deepEqual((await json(await app.request("/tape?side=sell"))).prints.map((p: { signature: string }) => p.signature), ["sell1"])
  assert.equal((await json(await app.request("/tape?symbol=bwrs"))).count, 2, "symbols are case-insensitive")
  assert.equal((await json(await app.request("/tape?symbol=FWDI"))).count, 0)
  const cases: [string, string][] = [
    ["/tape?date=2026-13-01", "invalid_query"],
    ["/tape?date=yesterday", "invalid_query"],
    ["/tape?side=short", "invalid_query"],
    ["/tape?symbol=%3Cscript%3E", "invalid_query"],
    ["/tape?date=2026-09-26", "date_in_future"],
    ["/tape?date=2026-01-01", "date_out_of_retention"],
  ]
  for (const [path, code] of cases) {
    const res = await app.request(path)
    assert.equal(res.status, 400, path)
    const body = await json(res)
    assert.equal(body.code, code, path)
    assert.equal(typeof body.error, "string")
    assert.deepEqual(Object.keys(body).sort(), ["code", "error"])
  }
  const missing = await app.request("/nope")
  assert.equal(missing.status, 404)
  assert.equal((await json(missing)).code, "not_found")
})

test("GET /symbols and /venue describe the pool, contract address and indexer health", async () => {
  const app = await appWith()
  const symbols = await json(await app.request("/symbols"))
  assert.equal(symbols.symbols[0].pair, "BWRS/USDC")
  assert.equal(symbols.symbols[0].fee_bps, 30)
  const venue = await json(await app.request("/venue"))
  assert.equal(venue.program, PROGRAM)
  assert.equal(venue.pools[0].contract_address, PROGRAM)
  assert.equal(venue.indexer.ws, "subscribed")
  assert.equal(venue.indexer.stale, false)
  assert.equal(venue.indexer.last_error, null)
  assert.match(venue.usd_method, /USDC/)
  const preflight = await app.request("/tape", { method: "OPTIONS", headers: { origin: "https://bellwether.larinova.com", "access-control-request-method": "GET" } })
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://bellwether.larinova.com")
  const local = await app.request("/tape", { headers: { origin: "http://localhost:5173" } })
  assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:5173")
  const denied = await app.request("/tape", { headers: { origin: "https://example.org" } })
  assert.equal(denied.headers.get("access-control-allow-origin"), null)
})

test("GET /halts: missing ledger is empty, the relay's state file is normalized, a corrupt one is a 503", async () => {
  const empty = await json(await (await appWith()).request("/halts"))
  assert.deepEqual([empty.halts, empty.source, empty.relay], [[], null, null])
  // Shaped like services/relay/ledger.ts writes it: { version, status, ledger: [camelCase entries] }.
  const ledger = join(dir, "relay.json")
  writeFileSync(ledger, JSON.stringify({
    version: 1,
    status: { lastPollAt: "2026-09-25T14:15:00.000Z", lastPollOk: true, consecutiveFailures: 0, lastHeartbeatAt: "2026-09-25T14:14:40.000Z", feedPublishedAt: null, lastSource: "nasdaq" },
    ledger: [
      { id: "FWDI|x", nasdaqSymbol: "FORD", ticker: "FWDI", symbolRecord: "S", reasonCode: "LUDP", nasdaqHaltTime: "2026-09-25T14:14:07.312Z", feedSeenAt: "2026-09-25T14:14:30.000Z", haltSignature: "5ig", haltConfirmedAt: "2026-09-25T14:14:31.000Z", haltSlot: "1", detectionMs: 22688, enforcementMs: 23688, resumedAt: null, resumeSeenAt: null, clearSignature: null, clearConfirmedAt: null, status: "halted" },
      { ticker: "AAPL", reason_code: "T1", nasdaq_halt_time: 1_790_300_000 },
      { reasonCode: "no symbol" },
    ],
  }))
  const body = await json(await (await appWith(ledger)).request("/halts?symbol=fwdi"))
  assert.equal(body.source, "Nasdaq Trader halt feed")
  assert.ok(!JSON.stringify(body).includes(dir), "public halt response contains no local file path")
  assert.equal(body.skipped, 1)
  assert.deepEqual(body.relay, { last_poll_at: "2026-09-25T14:15:00.000Z", last_poll_ok: true, consecutive_failures: 0, last_heartbeat_at: "2026-09-25T14:14:40.000Z", feed_published_at: null, source: "nasdaq" })
  assert.deepEqual(body.halts, [{
    symbol: "FWDI", reason_code: "LUDP", status: "halted", nasdaq_halt_time: "2026-09-25T14:14:07.312Z", feed_seen_at: "2026-09-25T14:14:30.000Z",
    tx_confirmed_at: "2026-09-25T14:14:31.000Z", tx_signature: "5ig", resumed_at: null, resume_confirmed_at: null, resume_signature: null,
    detection_ms: 22688, enforcement_ms: 23688,
  }])
  assert.equal((await json(await (await appWith(ledger)).request("/halts"))).halts[1].nasdaq_halt_time, "2026-09-25T01:33:20.000Z", "epoch seconds become ISO")
  const broken = join(dir, "broken.json")
  writeFileSync(broken, "{not json")
  const res = await (await appWith(broken)).request("/halts")
  assert.equal(res.status, 503)
  assert.deepEqual(await json(res), { error: "the halt ledger cannot be read right now", code: "halts_unavailable" })
})

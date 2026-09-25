/**
 * Offline tests for the tape: event decoding, log attribution, pricing and the store's windows.
 *   npx tsx --test services/indexer/*.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeTradeEvent, programDataFrom, tradeEventsFromLogs, type TradeEvent } from "./event.js"
import { openNodeSqlite } from "./node-sqlite.js"
import { formatUnits, poolSizeView, toPrint } from "./print.js"
import { SqlTapeStore } from "./sql-store.js"
import { ACCOUNT_ORD, isoTime, utcDayBounds, type TapePrint } from "./store.js"
import { OTHER, POOL, PROGRAM, STOCK, USDC, encodeEvent, sampleEvent } from "./test-fixtures.js"

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

test("BWTRADE1 decodes field by field; wrong tag, length or direction is not an event", () => {
  const e = sampleEvent({ direction: 1, ticker: "FWDI" })
  assert.deepEqual(decodeTradeEvent(encodeEvent(e)), e)
  const bad = encodeEvent(e)
  bad[0] = 0x58
  assert.equal(decodeTradeEvent(bad), null)
  assert.equal(decodeTradeEvent(encodeEvent(e).subarray(0, 227)), null)
  const dir = encodeEvent(e)
  dir[144] = 2
  assert.equal(decodeTradeEvent(dir), null)
})

test("only data the venue program itself logged counts; CPI frames and forgeries are ignored", () => {
  const real = b64(encodeEvent(sampleEvent()))
  const logs = [
    `Program ${OTHER} invoke [1]`,
    `Program data: ${real}`, // forged: same bytes, logged by another program
    `Program ${PROGRAM} invoke [2]`,
    "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [3]",
    "Program data: aGVsbG8=",
    "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success",
    `Program data: ${real}`,
    `Program ${PROGRAM} consumed 21000 of 200000 compute units`,
    `Program ${PROGRAM} success`,
    `Program ${OTHER} success`,
  ]
  const { payloads } = programDataFrom(logs, PROGRAM)
  assert.deepEqual(payloads, [[real]])
  const { events } = tradeEventsFromLogs(logs, PROGRAM)
  assert.equal(events.length, 1)
  assert.equal(events[0].pool, POOL)
  // An event that names a different program id inside its bytes is refused even from our frame.
  const spoof = b64(encodeEvent(sampleEvent({ program: OTHER })))
  assert.equal(tradeEventsFromLogs([`Program ${PROGRAM} invoke [1]`, `Program data: ${spoof}`, `Program ${PROGRAM} success`], PROGRAM).events.length, 0)
  const cut = tradeEventsFromLogs([`Program ${PROGRAM} invoke [1]`, "Log truncated", `Program data: ${real}`], PROGRAM)
  assert.equal(cut.truncated, true)
  assert.equal(cut.events.length, 0)
})

test("exact decimals: base units format without floating point", () => {
  assert.equal(formatUnits(25_074_625n, 6), "25.074625")
  assert.equal(formatUnits(5n, 6), "0.000005")
  assert.equal(formatUnits(0n, 6), "0.000000")
  assert.equal(formatUnits(18_446_744_073_709_551_615n, 6), "18446744073709.551615")
  assert.equal(formatUnits(42n, 0), "42")
  const view = poolSizeView({ pool: POOL, time: 0, slot: 1, ord: 0, reserveStock: 10_000_000_000n, reserveUsdc: 250_000_000_000n, source: "print" }, { stock: 6, usdc: 6 }, isoTime)
  assert.equal(view.usd, "500000.000000")
  assert.equal(view.stock_tokens, "10000.000000")
})

test("UTC day bounds reject impossible dates", () => {
  assert.deepEqual(utcDayBounds("2026-09-25"), { start: 1_790_294_400, end: 1_790_380_800 })
  assert.equal(utcDayBounds("2026-02-30"), null)
  assert.equal(utcDayBounds("2026-9-25"), null)
})

function print(i: number, over: Partial<TradeEvent>, slot = 100 + i): TapePrint {
  return toPrint(sampleEvent(over), { signature: `sig${i}`, eventIndex: 0, slot, indexedAt: 0 })
}

test("store: dedupe, date/symbol/side filters, rolling 24 h per print, end-of-day pool size, pruning", async () => {
  const store = await SqlTapeStore.open(openNodeSqlite(":memory:"))
  const day = utcDayBounds("2026-09-25")!
  const prev = print(1, { time: day.start - 3_600, shareUnits: 1_000_000n, usdcAmount: 25_000_000n, reserveStock: 1n, reserveUsdc: 2n })
  const old = print(0, { time: day.start + 3_600 - 86_400, shareUnits: 7_000_000n, usdcAmount: 1n }) // exactly 24 h before `a`
  const a = print(2, { time: day.start + 3_600, shareUnits: 2_000_000n, usdcAmount: 50_000_000n, reserveStock: 10n, reserveUsdc: 20n })
  const b = print(3, { time: day.start + 7_200, direction: 1, shareUnits: 3_000_000n, usdcAmount: 75_000_000n, reserveStock: 30n, reserveUsdc: 40n })
  const other = print(4, { time: day.start + 7_300, pool: STOCK, ticker: "FWDI", shareUnits: 9_000_000n })
  for (const p of [prev, old, a, b, other]) assert.equal(await store.insertPrint(p), true)
  assert.equal(await store.insertPrint(a), false, "same signature + event index is stored once")

  const all = await store.listPrints({ date: "2026-09-25" })
  assert.deepEqual(all.map((p) => p.signature), ["sig2", "sig3", "sig4"])
  // a: prev (1 h before midnight) is inside its window, `old` (exactly 24 h earlier) is not.
  assert.equal(all[0].rolling24h.shareUnits, 3_000_000n)
  assert.equal(all[1].rolling24h.shareUnits, 6_000_000n)
  assert.equal(all[1].rolling24h.usdcUnits, 150_000_000n)
  assert.equal(all[2].rolling24h.shareUnits, 9_000_000n, "each pair has its own window")
  assert.deepEqual((await store.listPrints({ date: "2026-09-25", side: "sell" })).map((p) => p.signature), ["sig3"])
  assert.deepEqual((await store.listPrints({ date: "2026-09-25", symbol: "FWDI" })).map((p) => p.signature), ["sig4"])
  assert.equal((await store.listPrints({ date: "2026-09-24" })).length, 2)

  const vol = await store.rolling24h(POOL, day.start + 7_200)
  assert.deepEqual(vol, { shareUnits: 6_000_000n, usdcUnits: 150_000_000n, trades: 3 })
  assert.equal((await store.rolling24h(POOL, day.end + 7_200)).trades, 0)

  const snap = (time: number, slot: number, ord: number, s: bigint, source: "print" | "account" = "print") =>
    store.insertSnapshot({ pool: POOL, time, slot, ord, reserveStock: s, reserveUsdc: s * 25n, source })
  await snap(day.start - 3_600, 10, 0, 100n)
  await snap(day.start + 3_600, 20, 0, 200n)
  await snap(day.start + 3_600, 20, ACCOUNT_ORD, 210n, "account") // same slot, read after the swap
  await snap(day.end + 60, 30, 0, 300n)
  assert.equal((await store.eodPoolSize(POOL, "2026-09-24", day.end + 1_000))!.reserveStock, 100n)
  assert.equal((await store.eodPoolSize(POOL, "2026-09-25", day.end + 1_000))!.reserveStock, 210n)
  assert.equal((await store.eodPoolSize(POOL, "2026-09-25", day.start + 60))!.reserveStock, 100n, "running day: as of now")
  assert.equal(await store.eodPoolSize(POOL, "2026-09-23", day.end), null)

  await store.upsertPool({ pool: POOL, program: PROGRAM, ticker: "BWRS", stockMint: STOCK, usdcMint: USDC, stockDecimals: 6, usdcDecimals: 6, symbolRecord: null, feeBps: 30, halted: false, active: true, updatedAt: 1 })
  await store.upsertPool({ pool: POOL, program: PROGRAM, ticker: "BWRS", stockMint: STOCK, usdcMint: USDC, stockDecimals: 6, usdcDecimals: 6, symbolRecord: null, feeBps: null, halted: null, active: null, updatedAt: 2 })
  const [pool] = await store.listPools()
  assert.equal(pool.feeBps, 30, "a partial upsert (from an event) keeps what an account read learned")
  assert.equal(pool.active, true)
  assert.equal((await store.lastPrint(POOL))!.signature, "sig3")

  // Retention: everything before `cutoff` goes, except each pool's latest snapshot.
  const cutoff = day.end + 3_600
  await store.prune(cutoff)
  assert.equal((await store.listPrints({ date: "2026-09-25" })).length, 0)
  assert.equal((await store.latestSnapshot(POOL))!.reserveStock, 300n)
  await store.prune(day.end + 10 * 86_400)
  assert.equal((await store.latestSnapshot(POOL))!.reserveStock, 300n, "the latest snapshot survives pruning")

  await store.setMeta("cursor", "abc")
  assert.equal(await store.getMeta("cursor"), "abc")
})

test("environment contract: defaults, derived websocket URLs and refusals", async () => {
  const { loadTapeConfig } = await import("./config.js")
  const c = loadTapeConfig({ BELLWETHER_PROGRAM_ID: PROGRAM })
  assert.deepEqual([c.cluster, c.rpcUrl, c.wsUrl, c.retentionDays, c.apiPort], ["mainnet", "https://api.mainnet-beta.solana.com", "wss://api.mainnet-beta.solana.com/", 35, 8787])
  assert.match(c.dbPath, /services\/indexer\/\.data\/tape\.sqlite$/)
  const local = loadTapeConfig({ BELLWETHER_PROGRAM_ID: PROGRAM, BELLWETHER_CLUSTER: "fork", BELLWETHER_RPC_URL: "http://127.0.0.1:8930" })
  assert.equal(local.wsUrl, "ws://127.0.0.1:8931/")
  assert.equal(loadTapeConfig({ BELLWETHER_PROGRAM_ID: PROGRAM, BELLWETHER_WS_URL: "off" }).wsUrl, undefined)
  assert.throws(() => loadTapeConfig({}), /BELLWETHER_PROGRAM_ID/)
  assert.throws(() => loadTapeConfig({ BELLWETHER_PROGRAM_ID: PROGRAM, BELLWETHER_TAPE_RETENTION_DAYS: "7" }), /RETENTION_DAYS/)
  assert.throws(() => loadTapeConfig({ BELLWETHER_PROGRAM_ID: "not-an-address" }), /base58/)
  assert.throws(() => loadTapeConfig({ BELLWETHER_PROGRAM_ID: PROGRAM, BELLWETHER_WS_URL: "http://x" }), /ws:\/\//)
})

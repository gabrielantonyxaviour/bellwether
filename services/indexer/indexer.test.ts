/**
 * The indexer against a scripted RPC: backfill order and cursor, websocket/backfill overlap,
 * failed transactions, a transaction the node cannot serve yet, and pool-account snapshots.
 *   npx tsx --test services/indexer/*.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { getAddressEncoder, type Address } from "@solana/kit"
import { TapeIndexer } from "./indexer.js"
import { openNodeSqlite } from "./node-sqlite.js"
import type { IndexerRpc, SignatureInfo, TransactionLogs } from "./rpc.js"
import { SqlTapeStore } from "./sql-store.js"
import { POOL, PROGRAM, encodeEvent, sampleEvent } from "./test-fixtures.js"

const SYMBOL_REC = "Sym1111111111111111111111111111111111111111"
const NOW_S = 1_790_330_100

function swapLogs(time: number, direction: 0 | 1 = 0): string[] {
  const data = Buffer.from(encodeEvent(sampleEvent({ time, direction }))).toString("base64")
  return [`Program ${PROGRAM} invoke [1]`, `Program data: ${data}`, `Program ${PROGRAM} success`]
}

class FakeRpc implements IndexerRpc {
  sigs: SignatureInfo[] = [] // newest first, like the node
  txs = new Map<string, TransactionLogs>()
  accounts = new Map<string, Uint8Array>()
  slot = 500
  add(signature: string, slot: number, logs: string[], err: unknown = null) {
    this.sigs.unshift({ signature, slot, err, blockTime: NOW_S })
    this.txs.set(signature, { slot, blockTime: NOW_S, err, logs })
  }
  async signaturesForAddress(_a: string, o: { before?: string; until?: string; limit: number }) {
    let list = this.sigs
    if (o.before) list = list.slice(list.findIndex((s) => s.signature === o.before) + 1)
    if (o.until) {
      const i = list.findIndex((s) => s.signature === o.until)
      if (i >= 0) list = list.slice(0, i)
    }
    return list.slice(0, o.limit)
  }
  async transactionLogs(signature: string) {
    return this.txs.get(signature) ?? null
  }
  async programAccounts() {
    return [...this.accounts].filter(([, d]) => d[0] === 3).map(([pubkey, data]) => ({ pubkey, data }))
  }
  async multipleAccounts(addresses: string[]) {
    return { slot: this.slot, accounts: addresses.map((a) => this.accounts.get(a) ?? null) }
  }
  async blockTime() {
    return NOW_S + 5
  }
}

function poolAccount(reserveStock: bigint, reserveUsdc: bigint): Uint8Array {
  const d = new Uint8Array(192)
  const v = new DataView(d.buffer)
  const enc = getAddressEncoder()
  d[0] = 3; d[2] = 6; d[3] = 6
  v.setUint16(4, 30, true)
  d.set(enc.encode(SYMBOL_REC as Address), 8)
  d.set(enc.encode(sampleEvent().stockMint as Address), 40)
  d.set(enc.encode(sampleEvent().usdcMint as Address), 72)
  v.setBigUint64(168, reserveStock, true)
  v.setBigUint64(176, reserveUsdc, true)
  return d
}

function symbolAccount(halted: boolean): Uint8Array {
  const d = new Uint8Array(168)
  d[0] = 2; d[2] = 1; d[3] = 1; d[4] = 1; d[5] = halted ? 1 : 0
  d.set(new TextEncoder().encode("BWRS"), 8)
  return d
}

async function setup(poolAccounts?: string[]) {
  const store = await SqlTapeStore.open(openNodeSqlite(":memory:"))
  const rpc = new FakeRpc()
  const indexer = new TapeIndexer({
    store, rpc, programId: PROGRAM, poolAccounts, pollMs: 60_000, poolRefreshMs: 60_000, retentionDays: 35, backfillMax: 100,
    now: () => NOW_S * 1000,
  })
  return { store, rpc, indexer }
}

test("backfill stores prints oldest first, skips failed transactions, and resumes from its cursor", async () => {
  const { store, rpc, indexer } = await setup()
  rpc.add("s1", 10, swapLogs(NOW_S - 60))
  rpc.add("s2", 11, swapLogs(NOW_S - 50), { InstructionError: [0, { Custom: 6006 }] })
  rpc.add("s3", 12, ["Program log: heartbeat", `Program ${PROGRAM} invoke [1]`, `Program ${PROGRAM} success`])
  rpc.add("s4", 13, swapLogs(NOW_S - 30, 1))
  assert.equal(await indexer.backfill(), 2)
  const prints = await store.listPrints({ date: "2026-09-25" })
  assert.deepEqual(prints.map((p) => [p.signature, p.side]), [["s1", "buy"], ["s4", "sell"]])
  assert.equal(await store.getMeta(`cursor:${PROGRAM}`), "s4")

  // The websocket already delivered s5; the next backfill sees it again and stores nothing twice.
  rpc.add("s5", 14, swapLogs(NOW_S - 10))
  assert.equal(await indexer.ingest({ signature: "s5", slot: 14, err: null, logs: rpc.txs.get("s5")!.logs }), 1)
  assert.equal(await indexer.backfill(), 0)
  assert.equal((await store.listPrints({ date: "2026-09-25" })).length, 3)
  assert.equal(await store.getMeta(`cursor:${PROGRAM}`), "s5")
})

test("a transaction the node cannot serve yet holds the cursor back until it can", async () => {
  const { store, rpc, indexer } = await setup()
  rpc.add("a", 10, swapLogs(NOW_S - 60))
  rpc.add("b", 11, swapLogs(NOW_S - 50))
  rpc.add("c", 12, swapLogs(NOW_S - 40))
  const b = rpc.txs.get("b")!
  rpc.txs.delete("b")
  assert.equal(await indexer.backfill(), 1)
  assert.equal(await store.getMeta(`cursor:${PROGRAM}`), "a")
  rpc.txs.set("b", b)
  assert.equal(await indexer.backfill(), 2)
  assert.equal(await store.getMeta(`cursor:${PROGRAM}`), "c")
})

test("pool refresh records fee and halt state, and snapshots reserves only when they change", async () => {
  const { store, rpc, indexer } = await setup()
  rpc.accounts.set(POOL, poolAccount(10_000_000_000n, 250_000_000_000n))
  rpc.accounts.set(SYMBOL_REC, symbolAccount(true))
  assert.equal(await indexer.refreshPools(), 1)
  assert.equal(await indexer.refreshPools(), 0, "unchanged reserves add no snapshot")
  const [pool] = await store.listPools()
  assert.deepEqual([pool.pool, pool.ticker, pool.feeBps, pool.halted, pool.active], [POOL, "BWRS", 30, true, true])
  rpc.slot = 600
  rpc.accounts.set(POOL, poolAccount(12_000_000_000n, 210_000_000_000n)) // a liquidity change: no event
  assert.equal(await indexer.refreshPools(), 1)
  const eod = await store.eodPoolSize(POOL, "2026-09-25", NOW_S + 10)
  assert.deepEqual([eod!.reserveStock, eod!.source, eod!.time], [12_000_000_000n, "account", NOW_S + 5])
})

test("known fork pool refreshes without getProgramAccounts and fails if the pool is absent", async () => {
  const { store, rpc, indexer } = await setup([POOL])
  rpc.programAccounts = async () => { throw new Error("program scan unavailable") }
  await assert.rejects(indexer.refreshPools(), /configured pool .* missing or invalid/)
  rpc.accounts.set(POOL, poolAccount(10_000_000_000n, 250_000_000_000n))
  rpc.accounts.set(SYMBOL_REC, symbolAccount(false))
  assert.equal(await indexer.refreshPools(), 1)
  assert.deepEqual((await store.listPools()).map((pool) => pool.pool), [POOL])
})

test("a backfill requested while one is walking queues exactly one more walk", async () => {
  const { store, rpc, indexer } = await setup()
  rpc.add("x1", 10, swapLogs(NOW_S - 60))
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const list = rpc.signaturesForAddress.bind(rpc)
  let calls = 0
  rpc.signaturesForAddress = async (a, o) => {
    const page = await list(a, o)
    if (++calls === 1) await gate // the first walk has listed signatures but not finished
    return page
  }
  const first = indexer.backfill()
  rpc.add("x2", 11, swapLogs(NOW_S - 50)) // lands after the first listing
  const second = indexer.backfill()
  release()
  assert.equal(await first, 2)
  assert.equal(await second, 2, "the queued request shares the same run")
  assert.deepEqual((await store.listPrints({ date: "2026-09-25" })).map((p) => p.signature), ["x1", "x2"])
})

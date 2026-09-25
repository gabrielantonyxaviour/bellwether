/**
 * Offline tests for the halt relay's seams — feed parsing, the 60 s poll gate, instruction bytes,
 * config and one relay cycle against a fake chain:
 *   npx tsx --test services/relay/relay.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { AccountRole, generateKeyPairSigner, type Address } from "@solana/kit"
import { parseRelayConfig } from "./config.js"
import { FeedUnavailable, haltStateFor, parseHaltFeed } from "./feed.js"
import { FIXTURE, readFixture } from "./fixtures/index.js"
import { memoryStore } from "./ledger.js"
import { parseNyseCurrent } from "./nyse.js"
import { SYMBOL_LEN, clearHaltInstruction, decodeSymbolRecord, heartbeatInstruction, setHaltInstruction } from "./program.js"
import { createRelay, type RelayChain } from "./relay.js"
import { MIN_POLL_INTERVAL_MS, PollGate, PollTooSoon, simulatedClock } from "./scheduler.js"

const HALT_AT = Date.parse("2026-09-25T14:14:07.312Z") // 10:14:07.312 EDT
const RESUME_AT = Date.parse("2026-09-25T14:19:12.000Z")

test("recorded Nasdaq feed: 17 items, Eastern → UTC, empty resumption means still halted", () => {
  const feed = parseHaltFeed(readFixture(FIXTURE.recorded))
  assert.equal(feed.items.length, 17)
  const kitt = feed.items.find((i) => i.symbol === "KITT")!
  assert.equal(new Date(kitt.haltAt).toISOString(), "2026-09-24T23:50:00.000Z")
  assert.equal(kitt.reasonCode, "T1")
  assert.equal(kitt.resumedAt, null)
  assert.equal(feed.items.find((i) => i.symbol === "BKKT.W")!.market, "NYSE")
  assert.equal(new Date(feed.items.find((i) => i.symbol === "SVA")!.haltAt).toISOString(), "2019-02-22T21:02:01.000Z")
  assert.equal(haltStateFor(feed.items, "FWDI", HALT_AT).halted, false, "no FWDI item → not halted")
  assert.equal(haltStateFor(feed.items, "SVA", HALT_AT).halted, true, "a years-old unresumed halt is still a halt")
})

test("synthetic LUDP pair: halted until the resumption trade time", () => {
  const halt = haltStateFor(parseHaltFeed(readFixture(FIXTURE.halt)).items, "FWDI", HALT_AT + 20_000)
  assert.equal(halt.halted, true)
  assert.equal(halt.item!.reasonCode, "LUDP")
  assert.equal(halt.item!.haltAt, HALT_AT)
  const resumeItems = parseHaltFeed(readFixture(FIXTURE.resume)).items
  assert.equal(haltStateFor(resumeItems, "FWDI", RESUME_AT - 1).halted, true, "scheduled resumption not reached yet")
  const resumed = haltStateFor(resumeItems, "FWDI", RESUME_AT)
  assert.equal(resumed.halted, false)
  assert.equal(resumed.item!.resumedAt, RESUME_AT)
})

test("a bot challenge, a non-RSS body or a truncated feed is a failed poll, never 'no halts'", () => {
  assert.throws(() => parseHaltFeed(readFixture(FIXTURE.challenge)), (e) => e instanceof FeedUnavailable && e.kind === "challenge")
  assert.throws(() => parseHaltFeed("{\"ok\":true}"), (e) => e instanceof FeedUnavailable && e.kind === "not-rss")
  const truncated = readFixture(FIXTURE.recorded).replace(/<item>[\s\S]*?<\/item>/, "")
  assert.throws(() => parseHaltFeed(truncated), (e) => e instanceof FeedUnavailable && e.kind === "malformed")
})

test("NYSE current halts JSON parses as a cross-check source", () => {
  const halts = parseNyseCurrent(JSON.parse(readFixture(FIXTURE.nyse)))
  assert.equal(halts.length, 15)
  const rpgl = halts.find((h) => h.symbol === "RPGL")!
  assert.equal(new Date(rpgl.haltAt).toISOString(), "2026-09-24T23:50:00.000Z")
  assert.equal(rpgl.resumedAt, null)
  assert.throws(() => parseNyseCurrent({ nope: 1 }))
})

test("poll gate: never twice within 60 s, and a failed poll still counts", () => {
  const gate = new PollGate()
  gate.acquire(1_000_000)
  assert.throws(() => gate.acquire(1_000_000 + MIN_POLL_INTERVAL_MS - 1), PollTooSoon)
  gate.acquire(1_000_000 + MIN_POLL_INTERVAL_MS)
  assert.throws(() => new PollGate(59_999), /at least 60000/)
  const resumed = new PollGate(MIN_POLL_INTERVAL_MS, 5_000_000)
  assert.throws(() => resumed.acquire(5_030_000), PollTooSoon, "a restart inherits the last poll time")
})

test("set_halt / clear_halt / heartbeat bytes and accounts match the program contract", async () => {
  const relay = await generateKeyPairSigner()
  const [programId, venue, symbol] = (await Promise.all([0, 1, 2].map(() => generateKeyPairSigner()))).map((s) => s.address)
  const base = { programId, relay, venue, symbol }
  const set = setHaltInstruction({ ...base, seq: 7n, reason: "LUDP", feedTs: 1_790_000_000n })
  assert.equal(set.programAddress, programId)
  assert.deepEqual([...set.data!.slice(0, 9)], [17, 7, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual([...set.data!.slice(9, 17)], [..."LUDP"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0]))
  assert.equal(Buffer.from(set.data!.slice(17, 25)).readBigInt64LE(), 1_790_000_000n)
  assert.equal(set.data!.length, 25)
  assert.deepEqual(set.accounts!.map((a) => [a.address, a.role]), [
    [relay.address, AccountRole.READONLY_SIGNER], [venue, AccountRole.READONLY], [symbol, AccountRole.WRITABLE],
  ])
  assert.deepEqual([...clearHaltInstruction({ ...base, seq: 8n }).data!], [18, 8, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual([...heartbeatInstruction({ ...base, seq: 258n }).data!], [19, 2, 1, 0, 0, 0, 0, 0, 0])
  assert.throws(() => setHaltInstruction({ ...base, seq: 1n, reason: "TOOLONGCODE", feedTs: 0n }))
})

test("config: poll interval below 60 s is refused; symbol map is validated", () => {
  const env = {
    RELAY_RPC_URL: "http://127.0.0.1:8910", RELAY_KEYPAIR_PATH: "/tmp/relay.json",
    RELAY_PROGRAM_ID: "11111111111111111111111111111112", RELAY_VENUE: "11111111111111111111111111111113",
    RELAY_SYMBOL_MAP: JSON.stringify([{ nasdaq: "FWDI", stockMint: "11111111111111111111111111111114", ticker: "BWRS" }]),
  }
  const config = parseRelayConfig(env)
  assert.equal(config.pollIntervalMs, 60_000)
  assert.equal(config.symbols[0].nasdaq, "FWDI")
  assert.throws(() => parseRelayConfig({ ...env, RELAY_POLL_INTERVAL_MS: "30000" }), /60000/)
  assert.throws(() => parseRelayConfig({ ...env, RELAY_SYMBOL_MAP: "[{\"nasdaq\":\"\"}]" }))
})

/** A fake chain holding one SymbolRecord that applies relay instructions like the program does. */
function fakeChain(symbol: Address) {
  const record = new Uint8Array(SYMBOL_LEN)
  record[0] = 2
  const view = new DataView(record.buffer)
  record.set(new TextEncoder().encode("BWRS"), 8)
  const sent: { disc: number; seq: bigint }[] = []
  const chain: RelayChain = {
    async getAccount(address) { return address === symbol ? record.slice() : null },
    async send(instructions) {
      for (const ix of instructions) {
        const d = ix.data!
        const seq = Buffer.from(d.slice(1, 9)).readBigUInt64LE()
        if (seq <= view.getBigUint64(144, true)) throw new Error("custom program error: 0x177d (StaleSequence)")
        view.setBigUint64(144, seq, true)
        if (d[0] === 17) { record[5] = 1; record.set(d.slice(9, 17), 16); view.setBigInt64(160, Buffer.from(d.slice(17, 25)).readBigInt64LE(), true) }
        if (d[0] === 18) { record[5] = 0; record.fill(0, 16, 24); view.setBigInt64(160, 0n, true) }
        sent.push({ disc: d[0], seq })
      }
      return { signature: `sig${sent.length}`, slot: BigInt(sent.length) }
    },
  }

  return { chain, sent, record }
}

test("relay cycle: challenge sends nothing; halt → set_halt once; resumption → clear_halt; ledger timestamps", async () => {
  const relay = await generateKeyPairSigner()
  const [programId, venue, symbol, mint] = (await Promise.all([0, 1, 2, 3].map(() => generateKeyPairSigner()))).map((s) => s.address)
  const { chain, sent, record } = fakeChain(symbol)
  const clock = simulatedClock(HALT_AT + 20_000)
  const feeds = [FIXTURE.challenge, FIXTURE.halt, FIXTURE.halt, FIXTURE.resume, FIXTURE.recorded]
  const store = memoryStore()
  const r = createRelay({
    programId, venue, relay, chain, store, clock,
    symbols: [{ nasdaq: "FWDI", ticker: "BWRS", stockMint: mint, symbolRecord: symbol }],
    fetchFeed: async () => readFixture(feeds.shift()!),
  })
  const first = await r.cycle()
  assert.equal(first.ok, false)
  assert.equal(sent.length, 0, "a challenged poll sends no heartbeat")
  await assert.rejects(r.cycle(), PollTooSoon)
  clock.advance(60_000)
  assert.deepEqual((await r.cycle()).actions.map((a) => a.action), ["set_halt"])
  assert.equal(decodeSymbolRecord(record).halted, true)
  assert.equal(decodeSymbolRecord(record).haltReason, "LUDP")
  clock.advance(60_000)
  assert.deepEqual((await r.cycle()).actions.map((a) => a.action), ["heartbeat"], "the same halt is not re-sent")
  clock.advance(240_000)
  assert.deepEqual((await r.cycle()).actions.map((a) => a.action), ["clear_halt"])
  clock.advance(60_000)
  assert.deepEqual((await r.cycle()).actions.map((a) => a.action), ["heartbeat"])
  assert.deepEqual(sent.map((s) => s.seq), [1n, 2n, 3n, 4n])
  const state = await store.load()
  assert.equal(state.ledger.length, 1)
  const entry = state.ledger[0]
  assert.equal(entry.nasdaqHaltTime, new Date(HALT_AT).toISOString())
  assert.equal(entry.feedSeenAt, new Date(HALT_AT + 80_000).toISOString())
  assert.ok(entry.haltConfirmedAt && Date.parse(entry.haltConfirmedAt) >= Date.parse(entry.feedSeenAt))
  assert.equal(entry.resumedAt, new Date(RESUME_AT).toISOString())
  assert.equal(entry.status, "resumed")
  assert.equal(state.status.consecutiveFailures, 0)
  assert.equal(state.status.lastPollOk, true)
})

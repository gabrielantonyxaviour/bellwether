/**
 * Accept check for blk_halt_relay:
 *   npx tsx checks/halt-relay.ts           halt → TradingHalted, resumption clears, polls ≥ 60 s apart
 *   npx tsx checks/halt-relay.ts --stale   relay stops → HaltDataStale after heartbeat_max_age
 *
 * Starts its own Surfpool surfnet on 127.0.0.1:8910 (ws 8911), writes the prebuilt venue program
 * (programs/venue/target/deploy/bellwether_venue.so; never builds it), stands up a BWRS market
 * with throwaway keypairs funded by cheatcodes, and runs the real relay against the recorded
 * Nasdaq feed fixture (plus a synthetic FWDI LUDP halt/resume pair) on a simulated clock.
 * The surfnet it started is stopped by pid at the end. Exits non-zero on any failed assertion.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRpcChain, describeError } from "../services/relay/chain.js"
import { FIXTURE, SYNTHETIC_LUDP, readFixture, type FixtureName } from "../services/relay/fixtures/index.js"
import { readLedger, readRelayStatus } from "../services/relay/index.js"
import { jsonFileStore } from "../services/relay/ledger.js"
import { decodeSymbolRecord } from "../services/relay/program.js"
import { createRelay, type CycleResult } from "../services/relay/relay.js"
import { MIN_POLL_INTERVAL_MS, PollGate, PollTooSoon, runLoop, simulatedClock } from "../services/relay/scheduler.js"
import { clockUnix, startSurfnet, timeTravelTo, type Surfnet } from "../services/relay/testing/fork.js"
import { setupMarket, type TestMarket } from "../services/relay/testing/market.js"

const HEARTBEAT_MAX_AGE = 180n // the production value; --stale reaches it with surfnet_timeTravel
const failures: string[] = []
const out = (s: string) => process.stdout.write(s + "\n")
function expect(ok: boolean, what: string, detail?: unknown) {
  if (!ok) failures.push(what)
  out(`${ok ? "  ok  " : "  FAIL"} ${what}${ok || detail === undefined ? "" : ` — got ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`}`)
}

interface Harness {
  market: TestMarket
  relay: ReturnType<typeof createRelay>
  clock: ReturnType<typeof simulatedClock>
  polls: number[]
  serve(name: FixtureName): void
  cycle(name: FixtureName, advanceMs: number): Promise<CycleResult>
  symbol(): Promise<ReturnType<typeof decodeSymbolRecord>>
  dataDir: string
}

async function harness(net: Surfnet, startMs: number): Promise<Harness> {
  const market = await setupMarket(net, { heartbeatMaxAge: HEARTBEAT_MAX_AGE })
  const clock = simulatedClock(startMs)
  const dataDir = mkdtempSync(join(tmpdir(), "bellwether-relay-ledger-"))
  const chain = createRpcChain(net.rpcUrl, market.relay)
  const polls: number[] = []
  let serving: FixtureName = FIXTURE.recorded
  const relay = createRelay({
    programId: market.programId, venue: market.accounts.venue, relay: market.relay, chain, clock,
    store: jsonFileStore(dataDir), gate: new PollGate(MIN_POLL_INTERVAL_MS),
    symbols: [{ nasdaq: "FWDI", ticker: "BWRS", stockMint: market.accounts.stockMint, symbolRecord: market.accounts.symbol }],
    fetchFeed: async () => { polls.push(clock.now()); return readFixture(serving) },
  })
  const serve = (name: FixtureName) => { serving = name }
  return {
    market, relay, clock, polls, serve, dataDir,
    async cycle(name, advanceMs) { clock.advance(advanceMs); serve(name); return relay.cycle() },
    async symbol() { return decodeSymbolRecord((await chain.getAccount(market.accounts.symbol))!) },
  }
}

const actions = (r: CycleResult) => r.actions.map((a) => a.error ? `${a.action}: ${a.error}` : a.action).join(",")

async function haltScenario(net: Surfnet) {
  out("\nhalt relay: recorded Nasdaq feed + synthetic FWDI LUDP pause → BWRS on the surfnet")
  const h = await harness(net, SYNTHETIC_LUDP.haltAt - 100_000) // 10:12:27 ET, before the pause
  const { market } = h

  let r = await h.cycle(FIXTURE.recorded, 0)
  expect(r.ok && actions(r) === "heartbeat", "recorded feed (17 real halts, none for FWDI) → heartbeat only", r)
  expect((await market.trySwap()) === "ok", "BWRS swap succeeds while FWDI trades")

  const before = h.polls.length
  h.clock.advance(30_000)
  let refused = false
  try { await h.relay.cycle() } catch (e) { refused = e instanceof PollTooSoon }
  expect(refused && h.polls.length === before, "a poll 30 s after the last is refused before any request is made")

  r = await h.cycle(FIXTURE.halt, 90_000) // 20 s after the halt instant
  const halted = await h.symbol()
  expect(actions(r) === "set_halt", "new FWDI LUDP halt in the feed → set_halt", r)
  expect(halted.halted && halted.haltReason === "LUDP", "SymbolRecord BWRS is halted with reason LUDP", halted)
  expect(halted.haltedAt === BigInt(Math.floor(SYNTHETIC_LUDP.haltAt / 1000)), "halted_at carries Nasdaq's halt instant", halted.haltedAt)
  expect((await market.trySwap()) === "TradingHalted", "next swap fails TradingHalted (6001)")

  r = await h.cycle(FIXTURE.halt, 60_000)
  expect(actions(r) === "heartbeat", "the same halt on the next poll is not re-sent (heartbeat)", r)
  expect((await market.trySwap()) === "TradingHalted", "swap still fails TradingHalted")

  r = await h.cycle(FIXTURE.resume, 60_000) // resumption published for 10:19:12 ET, now 10:16:27 ET
  expect(actions(r) === "heartbeat" && (await h.symbol()).halted, "a resumption time not yet reached keeps the halt", r)

  r = await h.cycle(FIXTURE.resume, 180_000) // 10:19:27 ET
  const cleared = await h.symbol()
  expect(actions(r) === "clear_halt" && !cleared.halted && cleared.haltReason === "", "resumption reached → clear_halt; BWRS not halted", r)
  expect((await market.trySwap()) === "ok", "swap succeeds after the resumption")

  const seq = (await h.symbol()).seq
  r = await h.cycle(FIXTURE.challenge, 60_000)
  expect(!r.ok && (await h.symbol()).seq === seq, "a bot-challenge response is a failed poll: nothing sent, no heartbeat", r.error)
  r = await h.cycle(FIXTURE.recorded, 60_000)
  expect(r.ok && actions(r) === "heartbeat", "next good poll heartbeats again", r)

  // The long-running loop on the same simulated clock: sleeps advance time, cycles hit the surfnet.
  const abort = new AbortController()
  let loops = 0
  await runLoop({
    gate: h.relay.gate, clock: h.clock, intervalMs: 1_000 /* asks for 1 s; the gate holds it to 60 s */, signal: abort.signal,
    sleep: async (ms) => h.clock.advance(ms),
    cycle: async () => { h.serve(FIXTURE.recorded); await h.relay.cycle(); if (++loops === 3) abort.abort() },
    onError: (e) => failures.push(`loop cycle threw: ${describeError(e)}`),
  })
  const gaps = h.polls.slice(1).map((t, i) => t - h.polls[i])
  expect(loops === 3 && h.polls.length === 10, `relay loop ran 3 more cycles (${h.polls.length} polls in total)`, { loops, polls: h.polls.length })
  expect(gaps.every((g) => g >= MIN_POLL_INTERVAL_MS), `every poll ≥ 60 s after the previous (min gap ${Math.min(...gaps) / 1000} s, simulated clock)`, gaps)
  let tooFast = false
  try { new PollGate(30_000) } catch { tooFast = true }
  expect(tooFast, "a poll interval under 60 s cannot be configured")

  const ledger = readLedger(h.dataDir)
  const e = ledger[0]
  expect(ledger.length === 1 && e.nasdaqSymbol === "FWDI" && e.ticker === "BWRS" && e.reasonCode === "LUDP", "latency ledger holds the FWDI→BWRS LUDP halt", ledger)
  expect(e?.nasdaqHaltTime === new Date(SYNTHETIC_LUDP.haltAt).toISOString() && e.feedSeenAt === new Date(SYNTHETIC_LUDP.haltAt + 20_000).toISOString(), "ledger: Nasdaq halt time and feed-seen time", e)
  expect(!!e?.haltSignature && !!e.haltConfirmedAt && e.enforcementMs !== null && e.enforcementMs >= e.detectionMs, "ledger: set_halt signature and confirmed-enforcement time", e)
  expect(e?.status === "resumed" && e.resumedAt === new Date(SYNTHETIC_LUDP.resumedAt).toISOString() && !!e.clearSignature, "ledger: resumption time and clear_halt", e)
  const status = readRelayStatus(h.dataDir)
  expect(status?.lastPollOk === true && status.symbols.FWDI?.halted === false && status.relay === market.relay.address, "relay status readable for the API", status)
  if (e) out(`  ledger: halt ${e.nasdaqHaltTime} · seen ${e.feedSeenAt} (+${e.detectionMs / 1000} s) · enforced ${e.haltConfirmedAt} (+${(e.enforcementMs ?? 0) / 1000} s, simulated clock) · resumed ${e.resumedAt}`)
  rmSync(h.dataDir, { recursive: true, force: true })
}

async function staleScenario(net: Surfnet) {
  out(`\nstale relay: heartbeat_max_age ${HEARTBEAT_MAX_AGE} s, reached with surfnet_timeTravel`)
  const h = await harness(net, SYNTHETIC_LUDP.haltAt - 3_600_000)
  const { market } = h
  let r = await h.cycle(FIXTURE.recorded, 0)
  const beat = (await h.symbol()).lastHeartbeat
  expect(r.ok && actions(r) === "heartbeat", "relay heartbeats (recorded feed)", r)
  expect((await market.trySwap()) === "ok", "swap succeeds right after the heartbeat")

  // The relay stops here: no more cycles.
  await timeTravelTo(net, Number(beat) + Number(HEARTBEAT_MAX_AGE) - 40)
  expect((await market.trySwap()) === "ok", `relay silent ${Number(HEARTBEAT_MAX_AGE) - 40} s: swap still succeeds (within heartbeat_max_age)`)
  await timeTravelTo(net, Number(beat) + Number(HEARTBEAT_MAX_AGE) + 5)
  const age = (await clockUnix(net)) - Number(beat)
  expect((await market.trySwap()) === "HaltDataStale", `relay silent ${age} s > ${HEARTBEAT_MAX_AGE} s: swap fails HaltDataStale (6002)`)

  r = await h.cycle(FIXTURE.challenge, 3_600_000)
  expect(!r.ok && (await h.symbol()).lastHeartbeat === beat, "relay back but Nasdaq challenges it: no heartbeat is sent")
  expect((await market.trySwap()) === "HaltDataStale", "swap still fails HaltDataStale (fails closed on a bad feed)")

  r = await h.cycle(FIXTURE.recorded, 60_000)
  expect(r.ok && actions(r) === "heartbeat" && (await h.symbol()).lastHeartbeat > beat, "a good poll heartbeats again", r)
  expect((await market.trySwap()) === "ok", "swap succeeds once the heartbeat is fresh")
  rmSync(h.dataDir, { recursive: true, force: true })
}

async function main() {
  const stale = process.argv.includes("--stale")
  const net = await startSurfnet()
  out(`surfnet started on ${net.rpcUrl} (pid ${net.pid}, ${process.env.RELAY_CHECK_DATASOURCE ?? "offline"})`)
  try {
    if (stale) await staleScenario(net)
    else await haltScenario(net)
  } finally {
    await net.stop()
    out(`surfnet pid ${net.pid} stopped`)
  }
  out(failures.length === 0 ? `\nPASS blk_halt_relay${stale ? " --stale" : ""}` : `\nFAIL (${failures.length}):\n- ${failures.join("\n- ")}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`halt-relay check failed: ${describeError(error)}\n`)
  process.exit(1)
})

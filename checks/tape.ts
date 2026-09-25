/**
 * Accept check for blk_tape:
 *   npx tsx checks/tape.ts
 *
 * Starts its own Surfpool mainnet fork on 127.0.0.1:8930 (ws 8931), deploys the prebuilt
 * programs/venue/target/deploy/bellwether_venue.so at a throwaway program id, and stands a market
 * up with throwaway keys (rehearsal stock vs the fork's real USDC, membership credential). Then:
 *  1. a buy lands BEFORE the indexer runs, so it must arrive through the signature backfill;
 *  2. the indexer and API start as their own processes (services/indexer/main.ts, services/api/main.ts);
 *  3. a sell lands while they run and must be in GET /tape within 10 seconds (websocket path);
 *  4. every print is checked against balances and accounts read independently from the fork:
 *     symbols, USD price, size, UTC time at the pool, direction, pool and contract address,
 *     rolling 24-hour pair volume and end-of-day pool size; plus /symbols, /venue, /halts,
 *     validation errors in {error, code} form, CORS and the 30-day window.
 * Kills only the processes it started, by pid. Exits non-zero on any mismatch.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateKeyPairSigner, type Address, type Signature } from "@solana/kit"
import { startOrReuseSurfpool } from "../scripts/assets/surfpool.js"
import { createChain, errorText, type Chain } from "../scripts/assets/tx.js"
import { decodePool } from "../services/indexer/accounts.js"
import { REPO_ROOT } from "../services/indexer/config.js"
import { bootstrapForkVenue, deployProgram, type ForkVenue } from "../services/indexer/fork-venue.js"
import { formatUnits } from "../services/indexer/print.js"
import { DAY_S, isoTime, utcDate } from "../services/indexer/store.js"
import { BUY, SELL } from "../services/indexer/venue-ix.js"

const RPC_URL = "http://127.0.0.1:8930"
const WS_URL = "ws://127.0.0.1:8931"
const SO_PATH = join(REPO_ROOT, "programs", "venue", "target", "deploy", "bellwether_venue.so")
const PUBLISH_LIMIT_MS = 10_000

const failures: string[] = []
function expect(ok: boolean, what: string, detail?: unknown) {
  if (!ok) failures.push(`${what}${detail === undefined ? "" : ` — got ${JSON.stringify(detail)}`}`)
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${what}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}\n`)
}
const note = (line: string) => process.stdout.write(`       ${line}\n`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- processes this check starts
const started: { name: string; child: ChildProcess; tail: string }[] = []

function spawnService(name: string, entry: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", entry], {
    cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  })
  const entryRef = { name, child, tail: "" }
  const keep = (chunk: Buffer) => { entryRef.tail = (entryRef.tail + chunk.toString()).slice(-6_000) }
  child.stdout?.on("data", keep)
  child.stderr?.on("data", keep)
  started.push(entryRef)
  return entryRef
}

function treeOf(pid: number): number[] {
  try {
    const kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number)
    return [...kids.flatMap(treeOf), pid]
  } catch {
    return [pid]
  }
}

function killStartedSync() {
  for (const { child } of started) {
    if (!child.pid || child.exitCode !== null) continue
    for (const pid of treeOf(child.pid)) { try { process.kill(pid, "SIGKILL") } catch { /* gone */ } }
  }
}

async function stopStarted() {
  for (const { child } of started) {
    if (!child.pid || child.exitCode !== null) continue
    const tree = treeOf(child.pid)
    for (const pid of tree) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    const deadline = Date.now() + 3_000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100)
  }
  killStartedSync()
}
process.once("SIGINT", killStartedSync)
process.once("SIGTERM", killStartedSync)
process.once("exit", killStartedSync)

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer().once("error", reject)
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number }
    srv.close(() => resolve(port))
  })
})

// ---------------------------------------------------------------- independent chain reads
async function tokenAmount(chain: Chain, account: Address): Promise<bigint> {
  const { value } = await chain.rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send()
  return BigInt(value.amount)
}

async function traderBalances(chain: Chain, venue: ForkVenue) {
  return { stock: await tokenAmount(chain, venue.trader.stock), usdc: await tokenAmount(chain, venue.trader.usdc) }
}

async function blockTimeOf(chain: Chain, signature: Signature): Promise<number> {
  const tx = await chain.rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send()
  if (!tx?.blockTime) throw new Error(`no blockTime for ${signature}`)
  return Number(tx.blockTime)
}

type Json = any

async function getJson(url: string): Promise<{ status: number; headers: Headers; body: Json }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  return { status: res.status, headers: res.headers, body: await res.json() }
}

async function waitForPrint(api: string, signature: string, date: string, limitMs: number): Promise<{ print: Json; ms: number } | null> {
  const t0 = Date.now()
  while (Date.now() - t0 <= limitMs) {
    try {
      const { body } = await getJson(`${api}/tape?date=${date}&symbol=BWRS`)
      const print = body.prints?.find((p: Json) => p.signature === signature)
      if (print) return { print, ms: Date.now() - t0 }
    } catch { /* API still starting */ }
    await sleep(200)
  }
  return null
}

async function waitUntil(what: string, limitMs: number, probe: () => Promise<boolean>): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 <= limitMs) {
    try { if (await probe()) return true } catch { /* not yet */ }
    await sleep(250)
  }
  note(`timed out after ${limitMs} ms waiting for ${what}`)
  return false
}

// ---------------------------------------------------------------- assertions for one print
interface Expected {
  signature: string
  side: "buy" | "sell"
  stock: bigint
  usdc: bigint
  fee: string
  blockTime: number
}

function checkPrint(label: string, p: Json, e: Expected, venue: ForkVenue) {
  const price = formatUnits((e.usdc * 1_000_000n) / e.stock, 6)
  expect(p.pair === "BWRS/USDC" && p.symbol === "BWRS" && p.paired_symbol === "USDC", `${label}: symbols BWRS/USDC`, [p.pair, p.symbol, p.paired_symbol])
  expect(p.price_usd === price, `${label}: USD price ${price} (USDC leg ÷ shares from balance deltas)`, p.price_usd)
  expect(p.size_shares === formatUnits(e.stock, 6) && p.size_tokens === formatUnits(e.stock, 6), `${label}: size ${formatUnits(e.stock, 6)} shares`, [p.size_shares, p.size_tokens])
  expect(p.size_usdc === formatUnits(e.usdc, 6) && p.notional_usd === formatUnits(e.usdc, 6), `${label}: paired size ${formatUnits(e.usdc, 6)} USDC`, p.size_usdc)
  expect(typeof p.time === "string" && p.time.endsWith("Z") && Date.parse(p.time) / 1000 === p.unix_time, `${label}: UTC time at the pool (${p.time})`, p.time)
  expect(Math.abs(p.unix_time - e.blockTime) <= 2, `${label}: time at the pool matches the block time ${isoTime(e.blockTime)}`, p.unix_time)
  const inOut = e.side === "buy" ? ["USDC", "BWRS"] : ["BWRS", "USDC"]
  expect(p.direction === e.side && p.asset_in === inOut[0] && p.asset_out === inOut[1], `${label}: direction ${e.side} (${inOut[0]} in, ${inOut[1]} out)`, [p.direction, p.asset_in, p.asset_out])
  expect(p.pool === venue.pool, `${label}: pool address ${venue.pool}`, p.pool)
  expect(p.program === venue.program, `${label}: contract address ${venue.program}`, p.program)
  expect(p.stock_mint === venue.stockMint && p.usdc_mint === venue.usdcMint, `${label}: stock and USDC mints`, [p.stock_mint, p.usdc_mint])
  expect(p.fee?.amount === e.fee, `${label}: fee ${e.fee} ${p.fee?.asset}`, p.fee)
  expect(p.signature === e.signature, `${label}: signature`, p.signature)
}

async function main() {
  if (!existsSync(SO_PATH)) {
    throw new Error(`missing ${SO_PATH}: build the venue program first (npm run program:build); this check deploys the prebuilt .so and never runs cargo`)
  }
  const fork = await startOrReuseSurfpool({ rpcUrl: RPC_URL, readyTimeoutMs: 90_000 })
  note(`surfpool ${fork.reused ? "reused (already listening on 8930)" : `started, pid ${fork.pid}`} at ${fork.rpcUrl}`)
  const tmp = mkdtempSync(join(tmpdir(), "bellwether-tape-check-"))
  try {
    await run(createChain(fork.rpcUrl), tmp)
  } finally {
    await stopStarted()
    await fork.stop()
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function run(chain: Chain, tmp: string) {
  const programKey = await generateKeyPairSigner()
  await deployProgram(chain.rpcUrl, programKey.address, readFileSync(SO_PATH))
  const programAccount = await chain.rpc.getAccountInfo(programKey.address, { encoding: "base64" }).send()
  expect(programAccount.value?.executable === true, `venue program deployed at ${programKey.address}`, programAccount.value)
  const venue = await bootstrapForkVenue(chain, { program: programKey.address })
  note(`market ready: pool ${venue.pool}, stock ${venue.stockMint}, venue ${venue.venue}`)

  // 1. A buy before the indexer exists: only the signature backfill can find it.
  const b0 = await traderBalances(chain, venue)
  const sig1 = await venue.swap(BUY, 1_000_000_000n)
  const b1 = await traderBalances(chain, venue)
  const buy: Expected = { signature: sig1, side: "buy", stock: b1.stock - b0.stock, usdc: b0.usdc - b1.usdc, fee: "3.000000", blockTime: await blockTimeOf(chain, sig1) }
  note(`buy ${sig1}: ${formatUnits(buy.usdc, 6)} USDC → ${formatUnits(buy.stock, 6)} BWRS`)

  // 2. Indexer and API as their own processes, sharing one SQLite file.
  const port = await freePort()
  const api = `http://127.0.0.1:${port}`
  const env = {
    BELLWETHER_PROGRAM_ID: venue.program, BELLWETHER_CLUSTER: "fork", BELLWETHER_RPC_URL: chain.rpcUrl, BELLWETHER_WS_URL: WS_URL,
    BELLWETHER_TAPE_DB: join(tmp, "tape.sqlite"), BELLWETHER_API_HOST: "127.0.0.1", BELLWETHER_API_PORT: String(port),
    // A slow safety-net poll: a print inside 10 s after this point can only have come over the websocket.
    BELLWETHER_TAPE_POLL_MS: "60000", BELLWETHER_TAPE_POOL_REFRESH_MS: "5000", BELLWETHER_HALT_LEDGER: join(tmp, "no-ledger.json"),
  }
  const indexer = spawnService("indexer", "services/indexer/main.ts", env)
  const apiProc = spawnService("api", "services/api/main.ts", env)
  const apiUp = await waitUntil("the API", 30_000, async () => (await fetch(`${api}/venue`)).ok)
  expect(apiUp, `API answers on ${api}`)
  const p1 = await waitForPrint(api, sig1, utcDate(buy.blockTime), 30_000)
  expect(p1 !== null, `pre-existing buy reached GET /tape through the backfill${p1 ? ` (${p1.ms} ms after start)` : ""}`)
  const subscribed = await waitUntil("logsSubscribe", 20_000, async () => (await getJson(`${api}/venue`)).body.indexer?.ws === "subscribed")
  expect(subscribed, "indexer is subscribed to program logs over the websocket")

  // 3. A sell while the indexer runs: it must be on the tape within 10 seconds.
  const t0 = Date.now()
  const sig2 = await venue.swap(SELL, 10_000_000n)
  const confirmedMs = Date.now() - t0
  const b2 = await traderBalances(chain, venue)
  const sell: Expected = { signature: sig2, side: "sell", stock: b1.stock - b2.stock, usdc: b2.usdc - b1.usdc, fee: "0.030000", blockTime: await blockTimeOf(chain, sig2) }
  const seen = await waitForPrint(api, sig2, utcDate(sell.blockTime), PUBLISH_LIMIT_MS - (Date.now() - t0))
  const totalMs = Date.now() - t0
  expect(seen !== null && totalMs <= PUBLISH_LIMIT_MS, `live sell on GET /tape ${totalMs} ms after submission (confirmed at ${confirmedMs} ms; limit ${PUBLISH_LIMIT_MS} ms)`)
  if (!p1 || !seen) {
    note(`indexer output:\n${indexer.tail}\napi output:\n${apiProc.tail}`)
    return
  }

  // 4. Field-by-field against independent reads.
  const date = utcDate(sell.blockTime)
  const { status, headers, body } = await getJson(`${api}/tape?date=${date}&symbol=BWRS`)
  expect(status === 200 && (headers.get("content-type") ?? "").includes("application/json"), "GET /tape is 200 application/json", status)
  expect(headers.get("access-control-allow-origin") === "*", "GET /tape is CORS-open", headers.get("access-control-allow-origin"))
  const print1 = body.prints.find((p: Json) => p.signature === sig1)
  const print2 = body.prints.find((p: Json) => p.signature === sig2)
  if (utcDate(buy.blockTime) === date) checkPrint("buy", print1, buy, venue)
  else checkPrint("buy", p1.print, buy, venue)
  checkPrint("sell", print2, sell, venue)

  const volShares = formatUnits(buy.stock + sell.stock, 6)
  const volUsd = formatUnits(buy.usdc + sell.usdc, 6)
  expect(print2.daily_volume.shares === volShares && print2.daily_volume.usd === volUsd && print2.daily_volume.trades === 2,
    `rolling 24 h pair volume at the sell: ${volShares} shares / $${volUsd} over 2 trades`, print2.daily_volume)
  const pair = body.pairs.find((p: Json) => p.pool === venue.pool)
  expect(pair?.rolling_24h.shares === volShares && pair?.rolling_24h.usd === volUsd && pair?.rolling_24h.trades === 2,
    `rolling 24 h pair volume at publication: ${volShares} shares`, pair?.rolling_24h)

  const poolInfo = await chain.rpc.getAccountInfo(venue.pool, { encoding: "base64", commitment: "confirmed" }).send()
  const pool = decodePool(Buffer.from(poolInfo.value!.data[0], "base64"))!
  const [vaultStock, vaultUsdc] = [await tokenAmount(chain, venue.stockVault), await tokenAmount(chain, venue.usdcVault)]
  expect(pool.reserveStock === vaultStock && pool.reserveUsdc === vaultUsdc, "pool account reserves equal the vault balances", [pool.reserveStock.toString(), vaultStock.toString()])
  const eod = pair?.eod_pool_size
  const want = { stock: formatUnits(pool.reserveStock, 6), usdc: formatUnits(pool.reserveUsdc, 6), usd: formatUnits(pool.reserveUsdc * 2n, 6) }
  expect(eod?.date === date && eod?.stock_tokens === want.stock && eod?.usdc === want.usdc && eod?.usd === want.usd,
    `end-of-day pool size ${want.stock} BWRS + ${want.usdc} USDC ($${want.usd}) matches the pool account`, eod)
  expect(JSON.stringify(print2.eod_pool_size) === JSON.stringify(eod), "each print carries its pair's end-of-day pool size", print2.eod_pool_size)
  expect(print2.pool_after.stock_tokens === want.stock && print2.pool_after.usdc === want.usdc, "the sell's pool_after equals the reserves after it", print2.pool_after)
  const lag = (p: Json, e: Expected) => `${((Date.parse(p.published_at) - e.blockTime * 1000) / 1000).toFixed(1)} s`
  note(`published after the block: buy ${lag(print1 ?? p1.print, buy)} (backfilled), sell ${lag(print2, sell)} (live)`)

  const side = await getJson(`${api}/tape?date=${date}&side=sell`)
  expect(side.body.prints.every((p: Json) => p.direction === "sell") && side.body.prints.some((p: Json) => p.signature === sig2), "side=sell filters the tape", side.body.count)

  const symbols = await getJson(`${api}/symbols`)
  const sym = symbols.body.symbols?.find((s: Json) => s.pool === venue.pool)
  expect(sym?.symbol === "BWRS" && sym?.fee_bps === 30 && sym?.active === true && sym?.halted === false, "GET /symbols lists BWRS/USDC with fee, active and halt state from chain", sym)
  const venueRes = await getJson(`${api}/venue`)
  const v = venueRes.body
  expect(v.program === venue.program && v.pools?.[0]?.contract_address === venue.program, "GET /venue names the contract address", v.program)
  expect(v.retention_days >= 30 && /USDC/.test(v.usd_method) && v.indexer?.stale === false, "GET /venue discloses the USD method, ≥30-day retention and a fresh indexer", [v.retention_days, v.indexer?.stale])
  const halts = await getJson(`${api}/halts`)
  expect(halts.status === 200 && Array.isArray(halts.body.halts), "GET /halts serves the ledger (empty without a relay ledger)", halts.body)

  const edge = await getJson(`${api}/tape?date=${utcDate(Math.floor(Date.now() / 1000) - 29 * DAY_S)}`)
  expect(edge.status === 200 && Array.isArray(edge.body.prints), "a date 29 days back is inside the served window", edge.status)
  for (const [path, code] of [["/tape?date=2026-02-30", "invalid_query"], ["/tape?side=short", "invalid_query"], ["/tape?date=2999-01-01", "date_in_future"]]) {
    const bad = await getJson(`${api}${path}`)
    expect(bad.status === 400 && bad.body.code === code && typeof bad.body.error === "string" && Object.keys(bad.body).length === 2, `GET ${path} → 400 {error, code: ${code}}`, bad.body)
  }
}

main()
  .catch((error) => {
    failures.push(errorText(error))
    process.stdout.write(`  FAIL ${errorText(error)}\n`)
  })
  .finally(() => {
    if (failures.length) {
      process.stdout.write(`\ntape check FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join("\n")}\n`)
      process.exit(1)
    }
    process.stdout.write("\ntape check passed\n")
    process.exit(0)
  })

/**
 * A private Surfpool surfnet for the relay checks: started on its own port (default RPC 8910,
 * websocket 8911 — never 8899, which other builders use), bound to 127.0.0.1, no datasource by
 * default (nothing in these checks needs mainnet state, so they cannot flake on a public RPC;
 * RELAY_CHECK_DATASOURCE=mainnet forks mainnet instead). Stopped by its own pid and descendants,
 * never by a name pattern. Includes the cheatcodes the checks use.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { generateKeyPairSigner, type Address } from "@solana/kit"

export interface Surfnet {
  rpcUrl: string
  pid: number
  stop(): Promise<void>
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[] = [], timeoutMs = 30_000): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
  })
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
}

async function answering(rpcUrl: string): Promise<boolean> {
  try { await rpcCall(rpcUrl, "getVersion", [], 1_500); return true } catch { return false }
}

export function surfpoolBinary(): string {
  if (process.env.SURFPOOL_BIN) return process.env.SURFPOOL_BIN
  const installed = join(homedir(), ".local", "bin", "surfpool")
  if (existsSync(installed)) return installed
  throw new Error(`surfpool not found at ${installed} (install: curl -sL https://run.surfpool.run/ | bash, or set SURFPOOL_BIN)`)
}

function descendants(pid: number): number[] {
  try {
    const kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number)
    return kids.flatMap((k) => [k, ...descendants(k)])
  } catch { return [] }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid) return
  const tree = [...descendants(pid), pid]
  for (const p of tree) { try { process.kill(p, "SIGTERM") } catch { /* gone */ } }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && tree.some(alive)) await sleep(100)
  for (const p of tree.filter(alive)) { try { process.kill(p, "SIGKILL") } catch { /* gone */ } }
}

export async function startSurfnet(options: { port?: number; busyWaitMs?: number; readyTimeoutMs?: number } = {}): Promise<Surfnet> {
  const port = options.port ?? Number(process.env.RELAY_CHECK_RPC_PORT ?? 8910)
  const rpcUrl = `http://127.0.0.1:${port}`
  const busyUntil = Date.now() + (options.busyWaitMs ?? 180_000)
  while (await answering(rpcUrl)) {
    if (Date.now() > busyUntil) throw new Error(`port ${port} is already served by another process; the relay check needs its own surfnet there`)
    await sleep(2_000)
  }
  const datasource = process.env.RELAY_CHECK_DATASOURCE
  const source = !datasource || datasource === "offline" ? ["--offline"] : datasource === "mainnet" ? ["--network", "mainnet"] : ["--rpc-url", datasource]
  const args = [
    "start", ...source, "--ci", "--no-tui", "--no-studio", "--no-deploy", "-y",
    "--host", "127.0.0.1", "--port", String(port), "--ws-port", String(port + 1), "--airdrop-amount", "0",
  ]
  const workdir = mkdtempSync(join(tmpdir(), "bellwether-relay-surfnet-"))
  const child = spawn(surfpoolBinary(), args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SURFPOOL_DATASOURCE_RPC_URL: undefined } })
  let tail = ""
  const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-4_000) }
  child.stdout?.on("data", keep)
  child.stderr?.on("data", keep)
  let spawnError: Error | null = null
  child.once("error", (e) => { spawnError = e })

  let stopped = false
  const onSignal = () => { void stop().finally(() => process.exit(130)) }
  async function stop() {
    if (stopped) return
    stopped = true
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    await killTree(child)
    rmSync(workdir, { recursive: true, force: true })
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000)
  while (Date.now() < deadline) {
    if (spawnError) { await stop(); throw new Error(`could not start surfpool: ${(spawnError as Error).message}`) }
    if (child.exitCode !== null) { await stop(); throw new Error(`surfpool exited with ${child.exitCode}: ${tail}`) }
    if (await answering(rpcUrl)) {
      return { rpcUrl, pid: child.pid!, stop, call: (method, params) => rpcCall(rpcUrl, method, params) }
    }
    await sleep(250)
  }
  await stop()
  throw new Error(`surfpool did not answer on ${rpcUrl} within the timeout: ${tail}`)
}

export const VENUE_SO = "programs/venue/target/deploy/bellwether_venue.so"

/** Writes the prebuilt venue program to a fresh throwaway program id (cheatcode; no cargo, no CLI). */
export async function deployVenueProgram(net: Surfnet, soPath = VENUE_SO): Promise<Address> {
  if (!existsSync(soPath)) {
    throw new Error(`${soPath} is missing: build the venue program first (npm run program:build); this check never runs cargo`)
  }
  const programId = (await generateKeyPairSigner()).address
  await net.call("surfnet_writeProgram", [programId, readFileSync(soPath).toString("hex"), 0])
  const info = await net.call<{ value: { executable: boolean } | null }>("getAccountInfo", [programId, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])
  if (!info.value?.executable) throw new Error(`program ${programId} is not executable after surfnet_writeProgram`)
  return programId
}

export async function setLamports(net: Surfnet, target: Address, lamports: bigint): Promise<void> {
  await net.call("surfnet_setAccount", [target, { lamports: Number(lamports) }])
}

/** The Clock sysvar's unix_timestamp (seconds). */
export async function clockUnix(net: Surfnet): Promise<number> {
  const info = await net.call<{ value: { data: { parsed: { info: { unixTimestamp: number } } } } }>(
    "getAccountInfo", ["SysvarC1ock11111111111111111111111111111111", { encoding: "jsonParsed" }])
  return info.value.data.parsed.info.unixTimestamp
}

/** Moves the surfnet clock forward to `unixSeconds` (surfnet_timeTravel takes milliseconds). */
export async function timeTravelTo(net: Surfnet, unixSeconds: number): Promise<void> {
  await net.call("surfnet_timeTravel", [{ absoluteTimestamp: unixSeconds * 1000 }])
}

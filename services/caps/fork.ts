/**
 * Test support for the caps check: a Surfpool mainnet fork this process starts and owns (never a
 * reused one), plus the cheatcodes the check needs — deploy a prebuilt .so, fund a key, and place
 * a bare Token-2022 mint. The fork binds 127.0.0.1 only; it is stopped by its own pid and its
 * descendants, never by a name pattern.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const VENUE_SO = join(REPO, "programs", "venue", "target", "deploy", "bellwether_venue.so")
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

export interface OwnFork { rpcUrl: string; pid: number; stop(): Promise<void> }

export async function rpcCall<T = unknown>(rpcUrl: string, method: string, params: unknown[] = [], timeoutMs = 30_000): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
  })
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
}

async function answers(rpcUrl: string): Promise<string | null> {
  try {
    const v = await rpcCall<Record<string, unknown>>(rpcUrl, "getVersion", [], 1_000)
    return JSON.stringify(v)
  } catch {
    return null
  }
}

function descendants(pid: number): number[] {
  try {
    const kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number)
    return kids.flatMap((k) => [k, ...descendants(k)])
  } catch {
    return []
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid || child.exitCode !== null) return
  const tree = [...descendants(pid), pid]
  for (const p of tree) { try { process.kill(p, "SIGTERM") } catch { /* gone */ } }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && tree.some(alive)) await new Promise((r) => setTimeout(r, 100))
  for (const p of tree.filter(alive)) { try { process.kill(p, "SIGKILL") } catch { /* gone */ } }
}

export async function startOwnSurfpool(o: { port: number; wsPort: number; readyTimeoutMs?: number }): Promise<OwnFork> {
  const rpcUrl = `http://127.0.0.1:${o.port}`
  const busy = await answers(rpcUrl)
  if (busy) throw new Error(`port ${o.port} is already answered by an RPC (${busy.slice(0, 120)}); this check starts its own fork there — stop that process first`)
  const bin = process.env.SURFPOOL_BIN ?? join(homedir(), ".local", "bin", "surfpool")
  if (!process.env.SURFPOOL_BIN && !existsSync(bin)) throw new Error(`surfpool not found at ${bin}`)
  const datasource = process.env.SURFPOOL_DATASOURCE_RPC_URL
  const args = [
    "start", "--no-tui", "--no-studio", "--no-deploy", "-y", ...(datasource ? ["--rpc-url", datasource] : ["--network", "mainnet"]),
    "--host", "127.0.0.1", "--port", String(o.port), "--ws-port", String(o.wsPort), "--airdrop-amount", "0",
  ]
  const workdir = mkdtempSync(join(tmpdir(), "bellwether-caps-surfpool-"))
  const child = spawn(bin, args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SURFPOOL_DATASOURCE_RPC_URL: undefined } })
  let tail = ""
  const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-3_000) }
  child.stdout?.on("data", keep)
  child.stderr?.on("data", keep)
  let spawnError: Error | null = null
  child.once("error", (e) => { spawnError = e })

  let stopped = false
  const onSignal = () => { void stop().finally(() => process.exit(130)) }
  const stop = async () => {
    if (stopped) return
    stopped = true
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    await killTree(child)
    rmSync(workdir, { recursive: true, force: true })
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  const deadline = Date.now() + (o.readyTimeoutMs ?? 60_000)
  while (Date.now() < deadline) {
    if (spawnError) { await stop(); throw new Error(`could not start surfpool (${bin}): ${(spawnError as Error).message}`) }
    if (child.exitCode !== null) { await stop(); throw new Error(`surfpool exited with ${child.exitCode}: ${tail}`) }
    if (await answers(rpcUrl)) return { rpcUrl, pid: child.pid!, stop }
    await new Promise((r) => setTimeout(r, 250))
  }
  await stop()
  throw new Error(`surfpool did not answer on ${rpcUrl} within the timeout: ${tail}`)
}

/** Cheatcode deploy: writes the ELF as an upgradeable-loader program at `programId`. */
export async function deployProgram(rpcUrl: string, programId: string, so: Uint8Array): Promise<void> {
  await rpcCall(rpcUrl, "surfnet_writeProgram", [programId, Buffer.from(so).toString("hex"), 0])
  const info = await rpcCall<{ value: { executable: boolean } | null }>(rpcUrl, "getAccountInfo", [programId, { encoding: "base64" }])
  if (!info.value?.executable) throw new Error(`program ${programId} is not executable after surfnet_writeProgram`)
}

export async function fundSol(rpcUrl: string, target: string, lamports: bigint): Promise<void> {
  await rpcCall(rpcUrl, "surfnet_setAccount", [target, { lamports: Number(lamports) }])
}

/** A bare, initialised 82-byte Token-2022 mint (no authorities, no extensions). */
export async function setMintAccount(rpcUrl: string, mint: string, decimals: number): Promise<void> {
  const data = new Uint8Array(82)
  data[44] = decimals
  data[45] = 1
  await rpcCall(rpcUrl, "surfnet_setAccount", [mint, { lamports: 1_461_600, owner: TOKEN_2022, executable: false, data: Buffer.from(data).toString("hex") }])
}

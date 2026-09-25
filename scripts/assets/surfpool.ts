/**
 * Start a local Surfpool mainnet fork for a check, or reuse one already listening.
 *
 * The fork binds 127.0.0.1 only and is never tunnelled: its surfnet_* cheatcodes are callable
 * by anyone who can reach the RPC. A fork this module started is stopped by its own pid (plus
 * any children), never by a process-name pattern.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export interface ForkHandle {
  rpcUrl: string
  reused: boolean
  pid: number | null
  stop(): Promise<void>
}

type Probe = { kind: "down" } | { kind: "surfpool"; version: string } | { kind: "other"; detail: string }

export async function probeRpc(rpcUrl: string, timeoutMs = 2_000): Promise<Probe> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await response.json()) as { result?: Record<string, unknown> }
    const version = body.result?.["surfnet-version"]
    if (typeof version === "string") return { kind: "surfpool", version }
    return { kind: "other", detail: JSON.stringify(body).slice(0, 200) }
  } catch {
    return { kind: "down" }
  }
}

function surfpoolBinary(): string {
  if (process.env.SURFPOOL_BIN) return process.env.SURFPOOL_BIN
  const installed = join(homedir(), ".local", "bin", "surfpool")
  return existsSync(installed) ? installed : "surfpool"
}

function descendants(pid: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
    const kids = out.split(/\s+/).filter(Boolean).map(Number)
    return kids.flatMap((kid) => [kid, ...descendants(kid)])
  } catch {
    return []
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid || child.exitCode !== null) return
  const tree = [...descendants(pid), pid]
  for (const p of tree) { try { process.kill(p, "SIGTERM") } catch { /* already gone */ } }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && tree.some(alive)) await new Promise((r) => setTimeout(r, 100))
  for (const p of tree.filter(alive)) { try { process.kill(p, "SIGKILL") } catch { /* already gone */ } }
}

export async function startOrReuseSurfpool(options: { rpcUrl?: string; readyTimeoutMs?: number; datasourceRpcUrl?: string } = {}): Promise<ForkHandle> {
  const rpcUrl = options.rpcUrl ?? "http://127.0.0.1:8899"
  const url = new URL(rpcUrl)
  const probe = await probeRpc(rpcUrl)
  if (probe.kind === "surfpool") return { rpcUrl, reused: true, pid: null, stop: async () => {} }
  if (probe.kind === "other") throw new Error(`${rpcUrl} is answered by something that is not Surfpool: ${probe.detail}`)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(`refusing to start a fork on non-local host ${url.hostname}`)

  const port = Number(url.port || 8899)
  const datasource = options.datasourceRpcUrl ?? process.env.SURFPOOL_DATASOURCE_RPC_URL
  const args = [
    "start", ...(datasource ? ["--rpc-url", datasource] : ["--network", "mainnet"]),
    "--ci", "--no-tui", "--no-studio", "--no-deploy", "-y",
    "--host", "127.0.0.1", "--port", String(port), "--ws-port", String(port + 1),
    "--airdrop-amount", "0",
  ]
  const workdir = mkdtempSync(join(tmpdir(), "bellwether-surfpool-"))
  const child = spawn(surfpoolBinary(), args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SURFPOOL_DATASOURCE_RPC_URL: undefined } })
  let tail = ""
  const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-4_000) }
  child.stdout?.on("data", keep)
  child.stderr?.on("data", keep)
  const spawnError = new Promise<Error>((resolve) => child.once("error", resolve))

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    await killTree(child)
    rmSync(workdir, { recursive: true, force: true })
  }
  const onSignal = () => { void stop().finally(() => process.exit(130)) }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000)
  while (Date.now() < deadline) {
    const early = await Promise.race([spawnError, new Promise<null>((r) => setTimeout(() => r(null), 250))])
    if (early) { await stop(); throw new Error(`could not start surfpool (${surfpoolBinary()}): ${early.message}`) }
    if (child.exitCode !== null) { await stop(); throw new Error(`surfpool exited with ${child.exitCode}: ${tail}`) }
    if ((await probeRpc(rpcUrl, 1_000)).kind === "surfpool") return { rpcUrl, reused: false, pid: child.pid ?? null, stop }
  }
  await stop()
  throw new Error(`surfpool did not answer on ${rpcUrl} within the timeout: ${tail}`)
}

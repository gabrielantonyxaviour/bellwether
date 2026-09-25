/**
 * The check's own Surfpool mainnet fork on a dedicated port (never 8899, never reused), plus
 * the cheatcodes it needs. Bound to 127.0.0.1 only; stopped by its own pid and descendants.
 */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { Address } from "@solana/kit"
import { probeRpc } from "../../../scripts/assets/surfpool.js"

export interface OwnFork {
  rpcUrl: string
  pid: number
  stop(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

function tree(pid: number): number[] {
  try {
    const kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number)
    return kids.flatMap((k) => [...tree(k), k])
  } catch {
    return []
  }
}

export async function startOwnFork(opts: { port: number; wsPort: number; studioPort: number; readyTimeoutMs?: number }): Promise<OwnFork> {
  const rpcUrl = `http://127.0.0.1:${opts.port}`
  const probe = await probeRpc(rpcUrl, 1_500)
  if (probe.kind !== "down") {
    throw new Error(`${rpcUrl} is already answering (${probe.kind}); this check starts its own fork there — stop that process first`)
  }
  const bin = process.env.SURFPOOL_BIN ?? join(homedir(), ".local", "bin", "surfpool")
  if (!existsSync(bin)) throw new Error(`surfpool not found at ${bin} (install: curl -sL https://run.surfpool.run/ | bash)`)
  const datasource = process.env.SURFPOOL_DATASOURCE_RPC_URL
  const args = [
    "start", ...(datasource ? ["--rpc-url", datasource] : ["--network", "mainnet"]),
    "--no-tui", "--ci", "--no-studio", "--studio-port", String(opts.studioPort), "--no-deploy", "-y",
    "--host", "127.0.0.1", "--port", String(opts.port), "--ws-port", String(opts.wsPort), "--airdrop-amount", "0",
  ]
  const workdir = mkdtempSync(join(tmpdir(), "bellwether-credentials-fork-"))
  const child = spawn(bin, args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SURFPOOL_DATASOURCE_RPC_URL: undefined } })
  if (!child.pid) throw new Error(`could not spawn ${bin}`)
  const pid: number = child.pid
  let tail = ""
  const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-3_000) }
  child.stdout?.on("data", keep)
  child.stderr?.on("data", keep)

  let stopped = false
  const killNow = () => { for (const p of [...tree(pid), pid]) { try { process.kill(p, "SIGKILL") } catch { /* gone */ } } }
  const onExit = () => { if (!stopped) killNow() }
  const onSignal = () => { void stop().finally(() => process.exit(130)) }
  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    process.off("exit", onExit)
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    const pids = [...tree(pid), pid]
    for (const p of pids) { try { process.kill(p, "SIGTERM") } catch { /* gone */ } }
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && pids.some(alive)) await sleep(100)
    for (const p of pids.filter(alive)) { try { process.kill(p, "SIGKILL") } catch { /* gone */ } }
    rmSync(workdir, { recursive: true, force: true })
  }
  process.on("exit", onExit)
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 90_000)
  while (Date.now() < deadline) {
    if (child.exitCode !== null) { await stop(); throw new Error(`surfpool exited with ${child.exitCode}: ${tail}`) }
    if ((await probeRpc(rpcUrl, 1_000)).kind === "surfpool") return { rpcUrl, pid, stop }
    await sleep(300)
  }
  await stop()
  throw new Error(`surfpool did not answer on ${rpcUrl} in time: ${tail}`)
}

export async function rpcCall<T = unknown>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
  return body.result as T
}

/** Writes the ELF as an upgradeable program at `programId` (hex data, one chunk). */
export async function deployProgram(rpcUrl: string, programId: Address, so: Uint8Array): Promise<void> {
  await rpcCall(rpcUrl, "surfnet_writeProgram", [programId, Buffer.from(so).toString("hex"), 0])
  const info = await rpcCall<{ value: { executable: boolean } | null }>(rpcUrl, "getAccountInfo", [programId, { encoding: "base64" }])
  if (!info.value?.executable) throw new Error(`program ${programId} is not executable after surfnet_writeProgram`)
}

/** Writes the owner's associated token account with a balance, thawed (fork-only USDC funding). */
export async function setTokenBalance(rpcUrl: string, owner: Address, mint: Address, amount: bigint, tokenProgram: Address): Promise<void> {
  await rpcCall(rpcUrl, "surfnet_setTokenAccount", [owner, mint, { amount: Number(amount), state: "initialized" }, tokenProgram])
}

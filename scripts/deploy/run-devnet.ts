/** Supervise the four live services and the daily caps job under launchd. */
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
process.chdir(root)
const env: NodeJS.ProcessEnv = { ...process.env }
for (const line of readFileSync("services/.env.devnet", "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue
  const delimiter = line.indexOf("=")
  if (delimiter < 1) throw new Error("malformed devnet service env")
  env[line.slice(0, delimiter)] = line.slice(delimiter + 1)
}
env.CREDENTIAL_CORS_ORIGIN = "https://bellwether.larinova.com,http://localhost:5173,http://127.0.0.1:5173"

const logDir = join(homedir(), "Library/Logs/bellwether")
mkdirSync(logDir, { recursive: true, mode: 0o700 })
const pidFile = join(logDir, "devnet-pids.json")
const services = new Map<string, ChildProcess>()
const awake = spawn("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" })
let caps: ChildProcess | null = null
let timer: NodeJS.Timeout | null = null
let stopping = false

function record() {
  writeFileSync(pidFile, JSON.stringify({ supervisor: process.pid,
    services: Object.fromEntries([...services].map(([name, child]) => [name, child.pid])),
    caps: caps?.pid ?? null, awake: awake.pid, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 })
  chmodSync(pidFile, 0o600)
}

function start(name: string, entry: string): ChildProcess {
  const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), entry], {
    cwd: root, env, stdio: "inherit", detached: true,
  })
  child.on("error", (error) => process.stderr.write(`${name} spawn error: ${error.message}\n`))
  process.stdout.write(`${name}: pid ${child.pid}\n`)
  return child
}

function stop(code: number) {
  if (stopping) return
  stopping = true
  if (timer) clearTimeout(timer)
  if (awake.exitCode === null) awake.kill("SIGTERM")
  for (const child of services.values()) if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGTERM")
  if (caps?.exitCode === null && caps?.pid) process.kill(-caps.pid, "SIGTERM")
  record()
  setTimeout(() => process.exit(code), 3_000).unref()
}

function nextCapsDelay(): number {
  const now = new Date()
  const next = new Date(now)
  next.setUTCHours(7, 30, 0, 0)
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

function scheduleCaps() {
  timer = setTimeout(() => {
    if (stopping) return
    caps = start("caps", "services/caps/run.ts")
    record()
    caps.once("exit", (code) => {
      process.stdout.write(`caps exited ${code}\n`)
      caps = null
      record()
      scheduleCaps()
    })
  }, nextCapsDelay())
}

for (const [name, entry] of [
  ["indexer", "services/indexer/main.ts"],
  ["api", "services/api/main.ts"],
  ["credential", "services/credential/server.ts"],
  ["relay", "services/relay/run.ts"],
]) {
  const child = start(name, entry)
  services.set(name, child)
  child.once("exit", (code, signal) => {
    process.stderr.write(`${name} exited ${code ?? signal}\n`)
    if (!stopping) stop(1)
  })
}
record()
scheduleCaps()
process.once("SIGINT", () => stop(0))
process.once("SIGTERM", () => stop(0))

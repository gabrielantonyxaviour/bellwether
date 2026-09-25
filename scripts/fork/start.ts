/** Start an owned, private mainnet fork; run the full BWRS/SAS go-live flow and keep it alive. */
import { spawn } from "node:child_process"
import { existsSync, renameSync } from "node:fs"
import { z } from "zod"
import { probeRpc, startOrReuseSurfpool } from "../assets/surfpool.js"
import { deploymentPath } from "../deploy/state.js"

const portSchema = z.coerce.number().int().min(1024).max(65534)
function parse(argv: string[]) {
  let port = 8899
  let services = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = portSchema.parse(argv[++i])
    else if (argv[i] === "--services") services = true
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  return { port, services }
}

async function child(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const process = spawn(command, args, { env, stdio: "inherit" })
    process.once("error", reject)
    process.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
  })
}

async function main() {
  const { port, services } = parse(process.argv.slice(2))
  const rpcUrl = `http://127.0.0.1:${port}`
  const probe = await probeRpc(rpcUrl)
  if (probe.kind !== "down") throw new Error(`${rpcUrl} already answers; refusing to reuse another fork's state`)
  process.env.BELLWETHER_FORK_PORT = String(port)
  const prior = deploymentPath("fork")
  if (existsSync(prior)) renameSync(prior, prior.replace(/\.json$/, `.${Date.now()}.previous.json`))
  const fork = await startOrReuseSurfpool({ rpcUrl, readyTimeoutMs: 90_000 })
  if (fork.reused || !fork.pid) throw new Error("fork process was not owned by this command")
  const env = { ...process.env, BELLWETHER_FORK_RPC_URL: rpcUrl, BELLWETHER_FORK_PORT: String(port) }
  process.stdout.write(`private Surfpool mainnet fork pid ${fork.pid} at ${rpcUrl}\n`)
  try {
    await child("npx", ["tsx", "scripts/deploy/go-live.ts", "--cluster", "fork"], env)
    const suffix = port === 8899 ? "fork" : `fork-${port}`
    process.stdout.write(`fork ready; journal scripts/deploy/deployments/${suffix}.json; browser config scripts/deploy/deployments/${suffix}.web.json\n`)
    if (services) await child("npx", ["tsx", "scripts/deploy/start-services.ts", "--cluster", "fork", "--port", String(port)], env)
    else await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve) })
  } finally {
    await fork.stop()
    process.stdout.write(`fork pid ${fork.pid} stopped\n`)
  }
}

main().catch((error) => { process.stderr.write(`fork start failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })

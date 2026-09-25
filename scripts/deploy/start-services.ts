/** Start relay, tape indexer, API and credential issuer against one deployed cluster. */
import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { z } from "zod"

const clusterSchema = z.enum(["fork", "devnet", "mainnet"])
function options(argv: string[]) {
  let cluster: z.infer<typeof clusterSchema> | null = null
  let port = 8899
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cluster") cluster = clusterSchema.parse(argv[++i])
    else if (argv[i] === "--port") port = z.coerce.number().int().min(1024).max(65530).parse(argv[++i])
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (!cluster) throw new Error("--cluster is required")
  return { cluster, port }
}

async function waitFor(url: string, name: string, children: ChildProcess[]) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (children.some((c) => c.exitCode !== null)) throw new Error(`${name}: a service exited before readiness`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${name} did not answer ${url} within 60 seconds`)
}

async function main() {
  const { cluster, port } = options(process.argv.slice(2))
  const suffix = cluster === "fork" && port !== 8899 ? `fork-${port}` : cluster
  const envFile = `services/.env.${suffix}`
  const env = { ...process.env }
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue
    const index = line.indexOf("=")
    if (index < 1) throw new Error(`malformed line in ${envFile}`)
    env[line.slice(0, index)] = line.slice(index + 1)
  }
  const children: ChildProcess[] = []
  const launch = (name: string, path: string) => {
    const child = spawn("npx", ["tsx", path], { env, stdio: "inherit" })
    child.once("error", (error) => process.stderr.write(`${name} spawn failed: ${error.message}\n`))
    children.push(child)
    process.stdout.write(`${name}: pid ${child.pid}\n`)
  }
  const stop = () => { for (const child of children) if (child.exitCode === null) child.kill("SIGTERM") }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    launch("indexer", "services/indexer/main.ts")
    launch("api", "services/api/main.ts")
    launch("credential", "services/credential/server.ts")
    launch("relay", "services/relay/run.ts")
    await waitFor(`http://127.0.0.1:${env.BELLWETHER_API_PORT ?? 8787}/`, "api", children)
    await waitFor(`http://127.0.0.1:${env.CREDENTIAL_PORT ?? 8790}/health`, "credential", children)
    process.stdout.write(`services ready on ${cluster}: API ${env.BELLWETHER_API_PORT ?? 8787}, credential ${env.CREDENTIAL_PORT ?? 8790}\n`)
    await new Promise<void>((resolve, reject) => {
      for (const child of children) child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`service pid ${child.pid} exited ${code}`)))
    })
  } finally {
    stop()
  }
}

main().catch((error) => { process.stderr.write(`services failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })

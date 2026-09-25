/**
 * Fork, services and wallet for tests/e2e/operator.spec.ts.
 * The assigned pair 8980/8981 was already serving another session's fork, so this check uses 8990/8991.
 */
import { spawn, execFile } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { AccountRole, address, type Address, type Instruction, type KeyPairSigner } from "@solana/kit"
import { loadKeypairSigner } from "../../scripts/assets/tx"
import { startOwnFork } from "../../services/notice/fork/env"

const run = promisify(execFile)
export const PORT = 8990
export const RPC = `http://127.0.0.1:${PORT}`
export const WEB = "http://127.0.0.1:5294"
export const API = `http://127.0.0.1:${PORT + 2}`
export const ISSUER = `http://127.0.0.1:${PORT + 3}`
const root = process.cwd()
const lockDir = join(tmpdir(), `bellwether-operator-${PORT}.lock`)
const solanaBin = `${process.env.HOME}/.local/share/solana/install/active_release/bin`
type ProcessHandle = ReturnType<typeof spawn>

export interface OperatorStack {
  deployment: { programId: Address; venue: Address; stockMint: Address; usdcMint: Address; symbol: Address; pool: Address }
  operatorToken: string
  admin: KeyPairSigner
  relay: KeyPairSigner
  stop(): Promise<void>
}

let fork: Awaited<ReturnType<typeof startOwnFork>> | undefined
const processes: ProcessHandle[] = []
const processLogs: string[] = []
let ownsLock = false

export async function startOperatorStack(): Promise<OperatorStack> {
  await lockForkPort()
  try {
    await assertFreeWebPort()
    for (const file of [
      `scripts/deploy/deployments/fork-${PORT}.json`, `scripts/deploy/deployments/fork-${PORT}.web.json`,
      `services/.env.fork-${PORT}`, `services/indexer/.data/fork-${PORT}.sqlite`,
      `services/indexer/.data/fork-${PORT}.sqlite-wal`, `services/indexer/.data/fork-${PORT}.sqlite-shm`,
      "evidence/operator-workbench.webm",
    ]) rmSync(file, { force: true })
    for (const dir of [`services/credential/data/fork-${PORT}`, `services/relay/data/fork-${PORT}`]) rmSync(dir, { recursive: true, force: true })
    process.env.SURFPOOL_DATASOURCE_RPC_URL = datasourceRpcUrl()
    fork = await startOwnFork(PORT)
    const env = { ...process.env, PATH: `${solanaBin}:${process.env.PATH}`, BELLWETHER_FORK_PORT: String(PORT), BELLWETHER_FORK_RPC_URL: RPC }
    let goLiveError: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await run("npx", ["tsx", "scripts/deploy/go-live.ts", "--cluster", "fork", "--seed-usdc", "10"], { cwd: root, env, timeout: 480_000, maxBuffer: 2_000_000 })
        goLiveError = undefined
        break
      } catch (error) {
        goLiveError = error
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
    }
    if (goLiveError) {
      throw goLiveError
    }
    const saved = JSON.parse(readFileSync(`scripts/deploy/deployments/fork-${PORT}.json`, "utf8")) as Record<string, string>
    const deployment = Object.fromEntries(["programId", "venue", "stockMint", "usdcMint", "symbol", "pool"].map((key) => [key, address(saved[key])])) as OperatorStack["deployment"]
    const serviceEnv = loadEnv(`services/.env.fork-${PORT}`)
    serviceEnv.BELLWETHER_WS_URL = "off"
    serviceEnv.BELLWETHER_TAPE_POLL_MS = "1000"
    serviceEnv.BELLWETHER_TAPE_POOL_REFRESH_MS = "1000"
    launch("npx", ["tsx", "services/indexer/main.ts"], serviceEnv)
    launch("npx", ["tsx", "services/api/main.ts"], serviceEnv)
    launch("npx", ["tsx", "services/credential/server.ts"], serviceEnv)
    await Promise.all([ready(`${API}/symbols`, (body) => (body as { symbols?: unknown[] }).symbols?.length === 1), ready(`${ISSUER}/health`)])
    const browserConfig = JSON.parse(readFileSync(`scripts/deploy/deployments/fork-${PORT}.web.json`, "utf8")) as Record<string, string>
    launch("pnpm", ["-C", "web", "dev", "--host", "127.0.0.1", "--port", "5294", "--strictPort"], {
      ...env, VITE_CLUSTER: "fork", VITE_RPC_URL: browserConfig.rpcUrl, VITE_WS_URL: browserConfig.wsUrl,
      VITE_PROGRAM_ID: browserConfig.programId, VITE_VENUE: browserConfig.venue, VITE_BWRS_MINT: browserConfig.bwrsMint,
      VITE_API_BASE_URL: browserConfig.apiBaseUrl, VITE_CREDENTIAL_API_URL: browserConfig.credentialApiUrl,
    })
    await ready(`${WEB}/config.json`)
    const home = process.env.HOME ?? ""
    return {
      deployment,
      operatorToken: serviceEnv.CREDENTIAL_OPERATOR_TOKEN ?? "",
      admin: await loadKeypairSigner(`${home}/.config/solana/bellwether/fork/venue-admin.json`),
      relay: await loadKeypairSigner(`${home}/.config/solana/bellwether/fork/relay.json`),
      stop: stopStack,
    }
  } catch (error) {
    await stopStack()
    throw error
  }
}

async function assertFreeWebPort(): Promise<void> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(5294, "127.0.0.1", resolve)
    })
  } catch (error) {
    throw new Error(`Operator web port 5294 is occupied: ${String(error)}`)
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function stopStack() {
  for (const child of processes.reverse()) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM") } catch { /* this run's process group already exited */ }
    }
  }
  processes.length = 0
  try { await fork?.stop() } finally {
    fork = undefined
    if (ownsLock) { rmSync(lockDir, { recursive: true, force: true }); ownsLock = false }
  }
}

export function walletFromSigner(signer: KeyPairSigner, file: string) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[])
  const seed = secret.subarray(0, 32)
  const publicBytes = secret.subarray(32, 64)
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]).toString("base64")
  return { address: signer.address, pkcs8, publicBytes: Buffer.from(publicBytes).toString("base64") }
}

export async function installWallet(page: import("@playwright/test").Page, wallet: ReturnType<typeof walletFromSigner>) {
  await page.addInitScript(({ walletAddress, pkcs8, publicBytes }) => {
    const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
    const key = crypto.subtle.importKey("pkcs8", decode(pkcs8), { name: "Ed25519" }, false, ["sign"])
    const account = { address: walletAddress, publicKey: decode(publicBytes), chains: ["solana:mainnet"], features: ["solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction"] }
    const sign = async (message: Uint8Array) => new Uint8Array(await crypto.subtle.sign("Ed25519", await key, message))
    const walletObject = {
      version: "1.0.0", name: "Bellwether fork signer", chains: ["solana:mainnet"],
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
      accounts: [account],
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
        "solana:signMessage": { version: "1.0.0", supportedTransactionVersions: [0], signMessage: async ({ message }: { message: Uint8Array }) => [{ signature: await sign(message) }] },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: [0], signTransaction: async (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(async ({ transaction }) => {
          const wire = new Uint8Array(transaction)
          if (wire[0] !== 1) throw new Error("Fork signer expects one transaction signature")
          wire.set(await sign(wire.subarray(65)), 1)
          return { signedTransaction: wire }
        })) },
        "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: [0], signAndSendTransaction: async () => { throw new Error("Fork signer never broadcasts through a wallet RPC") } },
      },
    }
    window.addEventListener("wallet-standard:app-ready", (event) => {
      (event as Event & { detail: { register: (value: unknown) => void } }).detail.register(walletObject)
    })
  }, { walletAddress: wallet.address, pkcs8: wallet.pkcs8, publicBytes: wallet.publicBytes })
}

export function rule(programId: Address, who: KeyPairSigner, venue: Address, symbol: Address, data: Uint8Array): Instruction {
  return { programAddress: programId, accounts: [
    { address: who.address, role: AccountRole.READONLY_SIGNER, signer: who },
    { address: venue, role: AccountRole.READONLY },
    { address: symbol, role: AccountRole.WRITABLE },
  ], data }
}

export function u64(value: bigint): Uint8Array {
  const data = new Uint8Array(8)
  new DataView(data.buffer).setBigUint64(0, value, true)
  return data
}

export function i64(value: bigint): Uint8Array {
  const data = new Uint8Array(8)
  new DataView(data.buffer).setBigInt64(0, value, true)
  return data
}

export function shortAddress(value: string): string {
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

async function lockForkPort() {
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir)
      ownsLock = true
      writeFileSync(join(lockDir, "pid"), String(process.pid))
      return
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
    }
    try {
      if (Date.now() - statSync(lockDir).mtimeMs > 5_000) {
        let pid = 0
        try { pid = Number(readFileSync(join(lockDir, "pid"), "utf8")) } catch { /* owner exited */ }
        try { if (!pid) throw new Error("missing lock owner"); process.kill(pid, 0) }
        catch { rmSync(lockDir, { recursive: true, force: true }) }
      }
    } catch { /* owner is creating or releasing the lock */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Another operator fork check kept port ${PORT} busy for ten minutes`)
}

function launch(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (data: Buffer) => {
    processLogs.push(data.toString().trim())
    if (processLogs.length > 40) processLogs.shift()
  })
  processes.push(child)
  return child
}

async function ready(url: string, check: (body: unknown) => boolean = () => true) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.ok && check(await res.json())) return } catch { /* service still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Service did not become ready at ${url}\n${processLogs.join("\n")}`)
}

function loadEnv(file: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const split = line.indexOf("=")
    if (split > 0) env[line.slice(0, split)] = line.slice(split + 1)
  }
  return env
}

/** Mainnet Surfpool upstream: the local Alchemy devnet URL with the cluster host swapped. Never logged. */
function datasourceRpcUrl(): string {
  let upstream: string | undefined
  try {
    upstream = loadEnv("services/.env.devnet").RPC_UPSTREAM_URL_ALCHEMY?.trim().replace(/^["']|["']$/g, "")
  } catch { /* missing env file fails below */ }
  if (!upstream?.includes("solana-devnet")) {
    throw new Error("Operator fork needs RPC_UPSTREAM_URL_ALCHEMY in services/.env.devnet, with a solana-devnet host, so it can derive the mainnet datasource")
  }
  return upstream.replace("solana-devnet", "solana-mainnet")
}

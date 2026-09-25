import { spawn, execFile } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { test, expect } from "@playwright/test"
import { AccountRole, address, createKeyPairSignerFromBytes, getBase58Decoder, type Address, type Instruction, type KeyPairSigner } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token"
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda as stockAta } from "@solana-program/token-2022"
import { createChain, errorText, loadKeypairSigner } from "../../scripts/assets/tx"
import { setTokenBalance } from "../../services/credential/fork/surfnet"
import { chainNow, startOwnFork, timeTravelTo } from "../../services/notice/fork/env"
import { heartbeatIx, setCapIx, swapIx, symbolPda, type PoolKeys } from "../../services/credential/venue-ix"

const run = promisify(execFile)
const PORT = 8970
const RPC = `http://127.0.0.1:${PORT}`
const WEB = "http://127.0.0.1:5193"
const API = `http://127.0.0.1:${PORT + 2}`
const ISSUER = `http://127.0.0.1:${PORT + 3}`
const root = process.cwd()
const lockDir = join(tmpdir(), `bellwether-participant-${PORT}.lock`)
const webDist = join(tmpdir(), `bellwether-participant-${PORT}-web`)
const solanaBin = `${process.env.HOME}/.local/share/solana/install/active_release/bin`
type ProcessHandle = ReturnType<typeof spawn>
let fork: Awaited<ReturnType<typeof startOwnFork>> | undefined
const processes: ProcessHandle[] = []
const processLogs: string[] = []
let deployment: { programId: Address; venue: Address; stockMint: Address; usdcMint: Address; symbol: Address; pool: Address; stockVault: Address; usdcVault: Address }
let serviceEnv: NodeJS.ProcessEnv
let browserConfig: Record<string, string>
let ownsLock = false
async function lockForkPort() {
  const deadline = Date.now() + 240_000
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
      const age = Date.now() - statSync(lockDir).mtimeMs
      if (age > 5_000) {
        let pid = 0
        try { pid = Number(readFileSync(join(lockDir, "pid"), "utf8")) } catch { /* owner exited before writing */ }
        try { if (!pid) throw new Error("missing lock owner"); process.kill(pid, 0) }
        catch { rmSync(lockDir, { recursive: true, force: true }) }
      }
    } catch { /* the owner may be creating or releasing the lock */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Another participant fork check kept port ${PORT} busy for four minutes`)
}

function launch(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data: Buffer) => {
    processLogs.push(`${args.at(-1)}: ${data.toString().trim()}`)
    if (processLogs.length > 40) processLogs.shift()
  })
  processes.push(child)
  return child
}
async function ready(url: string, check: (body: unknown) => boolean = () => true) {
  const deadline = Date.now() + 90_000
  let last = "no response"
  while (Date.now() < deadline) {
    try { const res = await fetch(url); const body = await res.json(); if (res.ok && check(body)) return; last = `${res.status} ${JSON.stringify(body)}` }
    catch (error) { last = error instanceof Error ? error.message : String(error) }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Service did not become ready at ${url}: ${last}\n${processLogs.join("\n")}`)
}
function loadEnv(file: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const split = line.indexOf("=")
    if (split > 0) env[line.slice(0, split)] = line.slice(split + 1)
  }
  return env
}
function ephemeralWallet() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" })
  const publicBytes = publicKey.export({ type: "spki", format: "der" }).subarray(-32)
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url")
  const bytes = Uint8Array.from([...seed, ...publicBytes])
  return { address: address(getBase58Decoder().decode(publicBytes)), pkcs8: pkcs8.toString("base64"), publicBytes: publicBytes.toString("base64"), bytes }
}
async function installWallet(page: import("@playwright/test").Page, wallet: ReturnType<typeof ephemeralWallet>) {
  await page.addInitScript(({ walletAddress, pkcs8, publicBytes }) => {
    const decode = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const key = crypto.subtle.importKey("pkcs8", decode(pkcs8), { name: "Ed25519" }, false, ["sign"])
    const account = { address: walletAddress, publicKey: decode(publicBytes), chains: ["solana:mainnet"],
      features: ["solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction"] }
    const sign = async (message: Uint8Array) => new Uint8Array(await crypto.subtle.sign("Ed25519", await key, message))
    const walletObject = { version: "1.0.0", name: "Bellwether fork signer", chains: ["solana:mainnet"],
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz48L3N2Zz4=",
      accounts: [account], features: {
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
      } }
    window.addEventListener("wallet-standard:app-ready", (event) => {
      (event as Event & { detail: { register: (wallet: unknown) => void } }).detail.register(walletObject)
    })
  }, { walletAddress: wallet.address, pkcs8: wallet.pkcs8, publicBytes: wallet.publicBytes })
}
function rule(programId: Address, who: KeyPairSigner, venue: Address, symbol: Address, disc: number, payload: Uint8Array): Instruction {
  return { programAddress: programId, accounts: [
    { address: who.address, role: AccountRole.READONLY_SIGNER, signer: who },
    { address: venue, role: AccountRole.READONLY }, { address: symbol, role: AccountRole.WRITABLE },
  ], data: Uint8Array.from([disc, ...payload]) }
}
function u64(value: bigint): Uint8Array { const data = new Uint8Array(8); new DataView(data.buffer).setBigUint64(0, value, true); return data }
function i64(value: bigint): Uint8Array { const data = new Uint8Array(8); new DataView(data.buffer).setBigInt64(0, value, true); return data }
function errorCode(error: unknown) {
  const match = errorText(error).match(/custom program error: 0x([0-9a-f]+)/i)
  return match ? Number.parseInt(match[1], 16) : null
}

test.describe.configure({ mode: "serial" })
test.beforeAll(async () => {
  test.setTimeout(600_000)
  await lockForkPort()
  // This port belongs to this test. A fresh fork must never reuse its prior journal or tape.
  for (const file of [
    `scripts/deploy/deployments/fork-${PORT}.json`, `scripts/deploy/deployments/fork-${PORT}.web.json`,
    `services/.env.fork-${PORT}`, `services/indexer/.data/fork-${PORT}.sqlite`,
    `services/indexer/.data/fork-${PORT}.sqlite-wal`, `services/indexer/.data/fork-${PORT}.sqlite-shm`,
  ]) rmSync(file, { force: true })
  for (const dir of [`services/credential/data/fork-${PORT}`, `services/relay/data/fork-${PORT}`]) rmSync(dir, { recursive: true, force: true })
  fork = await startOwnFork(PORT)
  const env = { ...process.env, PATH: `${solanaBin}:${process.env.PATH}`, BELLWETHER_FORK_PORT: String(PORT), BELLWETHER_FORK_RPC_URL: RPC }
  await run("npx", ["tsx", "scripts/deploy/go-live.ts", "--cluster", "fork", "--seed-usdc", "10"], { cwd: root, env, timeout: 480_000, maxBuffer: 2_000_000 })
  const saved = JSON.parse(readFileSync(`scripts/deploy/deployments/fork-${PORT}.json`, "utf8"))
  deployment = Object.fromEntries(["programId", "venue", "stockMint", "usdcMint", "symbol", "pool", "stockVault", "usdcVault"].map((key) => [key, address(saved[key])])) as typeof deployment
  serviceEnv = loadEnv(`services/.env.fork-${PORT}`)
  serviceEnv.BELLWETHER_WS_URL = "off"
  serviceEnv.BELLWETHER_TAPE_POLL_MS = "1000"
  serviceEnv.BELLWETHER_TAPE_POOL_REFRESH_MS = "1000"
  launch("npx", ["tsx", "services/indexer/main.ts"], serviceEnv)
  launch("npx", ["tsx", "services/api/main.ts"], serviceEnv)
  launch("npx", ["tsx", "services/credential/server.ts"], serviceEnv)
  await Promise.all([ready(`${API}/symbols`, (body) => (body as { symbols?: unknown[] }).symbols?.length === 1), ready(`${ISSUER}/health` )])
  browserConfig = JSON.parse(readFileSync(`scripts/deploy/deployments/fork-${PORT}.web.json`, "utf8"))
  const webEnv = {
    ...env, VITE_CLUSTER: "fork", VITE_RPC_URL: browserConfig.rpcUrl, VITE_WS_URL: browserConfig.wsUrl,
    VITE_PROGRAM_ID: browserConfig.programId, VITE_VENUE: browserConfig.venue, VITE_BWRS_MINT: browserConfig.bwrsMint,
    VITE_API_BASE_URL: browserConfig.apiBaseUrl, VITE_CREDENTIAL_API_URL: browserConfig.credentialApiUrl,
  }
  rmSync(webDist, { recursive: true, force: true })
  await run("pnpm", ["-C", "web", "exec", "vite", "build", "--outDir", webDist, "--emptyOutDir"], { cwd: root, env: webEnv, timeout: 90_000 })
  launch("pnpm", ["-C", "web", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", "5193", "--outDir", webDist], webEnv)
  await ready(`${WEB}/config.json`)
})
test.afterAll(async () => {
  for (const child of processes.reverse()) { if (child.pid) { try { process.kill(child.pid, "SIGTERM") } catch { /* already exited */ } } }
  try { await fork?.stop() }
  finally { rmSync(webDist, { recursive: true, force: true }); if (ownsLock) rmSync(lockDir, { recursive: true, force: true }) }
})
test("admit, trade, LP, tape and real venue refusals on an isolated fork", async ({ browser }) => {
  test.setTimeout(900_000)
  const wallet = ephemeralWallet()
  const signer = await createKeyPairSignerFromBytes(wallet.bytes)
  const chain = createChain(RPC)
  await chain.fundSol(wallet.address, 2_000_000_000n)
  await setTokenBalance(RPC, wallet.address, deployment.usdcMint, 5_000_000n, TOKEN_PROGRAM_ADDRESS)
  const [ownerStock] = await stockAta({ owner: wallet.address, mint: deployment.stockMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const [ownerUsdc] = await findAssociatedTokenPda({ owner: wallet.address, mint: deployment.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on("response", (response) => {
    if (!response.url().startsWith(RPC)) return
    void response.json().then((body: { error?: unknown }) => { if (body.error) processLogs.push(`rpc error: ${JSON.stringify(body.error)}`) }).catch(() => {})
  })
  page.on("requestfailed", (request) => { if (request.url().startsWith(RPC)) processLogs.push(`rpc request failed: ${request.failure()?.errorText}`) })
  await page.route("**/config.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(browserConfig) }))
  await installWallet(page, wallet)
  const market: PoolKeys = { venue: deployment.venue, symbol: deployment.symbol, pool: deployment.pool,
    stockMint: deployment.stockMint, usdcMint: deployment.usdcMint, stockVault: deployment.stockVault, usdcVault: deployment.usdcVault }
  try {
    await page.goto(`${WEB}/app/onboard`)
    await expect(page.getByRole("heading", { name: "Get admitted" })).toBeVisible()
    await page.getByRole("button", { name: "Connect wallet" }).last().click()
    await page.getByRole("button", { name: "Bellwether fork signer" }).click()
    await expect(page.getByText("Bellwether fork signer")).toBeVisible()
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole("button", { name: attempt ? "Retry admission" : "Sign challenge and get admitted" }).click()
      try { await expect.poll(async () => {
        const text = await page.locator("main").innerText()
        return /Your credential is onchain|Admission did not finish|Screening unavailable|Admission refused/.test(text) ? text : null
      }, { timeout: 240_000 }).not.toBeNull() } catch { throw new Error(`Admission screen: ${await page.locator("main").innerText()}\nServices:\n${processLogs.join("\n")}`) }
      const screen = await page.locator("main").innerText()
      if (screen.includes("Your credential is onchain")) break
      if (!screen.includes("the admission transaction failed")) throw new Error(`Admission screen: ${screen}`)
    }
    expect(await page.locator("main").innerText()).toContain("Your credential is onchain")
    const credential = await (await fetch(`${ISSUER}/credential/${wallet.address}`)).json() as { status: string; credential: { address: Address }; stockAccount: { state: string } }
    expect(credential.status).toBe("admitted")
    expect(credential.stockAccount.state).toBe("thawed")
    const relay = await loadKeypairSigner(`${process.env.HOME}/.config/solana/bellwether/fork/relay.json`)
    let sequence = 2n
    await chain.send([heartbeatIx(deployment.programId, relay, deployment.venue, deployment.symbol, sequence++)], relay)
    await page.goto(`${WEB}/app/trade/BWRS`)
    await expect(page.getByRole("heading", { name: "BWRS / USDC" })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText("Budget used")).toBeVisible()
    await expect(page.getByRole("region", { name: "Tokenized stock info" }).getByText("Mint authority")).toBeVisible()
    await page.getByRole("tab", { name: "1M" }).click()
    await expect(page.getByRole("tab", { name: "1M" })).toHaveAttribute("aria-selected", "true")
    for (const name of ["Liquidity", "Positions", "Orders", "Trades"]) await page.getByRole("tab", { name, exact: true }).click()
    await expect(page.getByRole("tab", { name: "Trades", exact: true })).toHaveAttribute("aria-selected", "true")
    await page.getByRole("textbox", { name: "You pay · USDC" }).fill("0.5")
    await expect(page.getByText("Shares counted toward daily budget")).toBeVisible()
    await page.getByRole("button", { name: "Review buy" }).click()
    await page.getByRole("button", { name: "Confirm swap" }).click()
    try { await expect.poll(async () => {
      const text = await page.locator("main").innerText()
      return text.includes("Swap confirmed.") || await page.locator("main [role=alert]").count() > 0 ? text : null
    }, { timeout: 90_000 }).not.toBeNull() } catch { throw new Error(`Trade screen: ${await page.locator("main").innerText()}\nServices:\n${processLogs.join("\n")}`) }
    expect(await page.locator("main").innerText()).toContain("Swap confirmed.")
    await expect(page.getByRole("link", { name: "Check the public explorer →" })).toHaveAttribute("href", "/explorer")
    await expect.poll(async () => (await (await fetch(`${API}/tape?symbol=BWRS`)).json() as { count: number }).count, { timeout: 60_000 }).toBeGreaterThan(0)
    const tape = await (await fetch(`${API}/tape?symbol=BWRS`)).json() as { prints: { signature: string; symbol: string }[] }
    expect(tape.prints[0].symbol).toBe("BWRS")
    await page.goto(`${WEB}/app/liquidity/BWRS`)
    await expect(page.getByRole("heading", { name: "Provide liquidity" })).toBeVisible()
    await page.getByRole("textbox", { name: "BWRS amount" }).fill("0.001")
    let deposited = false
    for (let attempt = 0; attempt < 3 && !deposited; attempt++) {
      await page.getByRole("button", { name: "Review deposit" }).click()
      await page.getByRole("button", { name: "Confirm deposit" }).click()
      await expect.poll(async () => {
        const screen = await page.locator("main").innerText()
        return screen.includes("Liquidity deposit confirmed on chain.") || await page.locator("main [role=alert]").count() > 0 ? screen : null
      }, { timeout: 120_000 }).not.toBeNull()
      const screen = await page.locator("main").innerText()
      deposited = screen.includes("Liquidity deposit confirmed on chain.")
      if (!deposited && !screen.includes("The network did not confirm submission.")) throw new Error(`Deposit screen state: ${screen}\nServices:\n${processLogs.join("\n")}`)
    }
    expect(deposited, `Deposit screen state: ${await page.locator("main").innerText()}`).toBe(true)
    const dataAuthority = await loadKeypairSigner(`${process.env.HOME}/.config/solana/bellwether/fork/data-authority.json`)
    const assertRefusal = async (expected: number) => {
      try { await chain.send([swapIx(deployment.programId, market, signer, ownerStock, ownerUsdc, credential.credential.address, 0, 10_000n, 1n)], signer); throw new Error("swap unexpectedly succeeded") }
      catch (cause) { expect(errorCode(cause)).toBe(expected) }
    }
    await chain.send([rule(deployment.programId, relay, deployment.venue, deployment.symbol, 17,
      Uint8Array.from([...u64(sequence++), ...new TextEncoder().encode("LUDP\0\0\0\0"), ...i64(BigInt(await chainNow(RPC)))]))], relay)
    await page.reload()
    await expect(page.getByText("Halted: withdraw only.")).toBeVisible()
    await assertRefusal(6001)
    await page.getByRole("tab", { name: "Withdraw" }).click()
    await page.getByRole("button", { name: "Review withdrawal" }).click()
    await page.getByRole("button", { name: "Confirm withdraw" }).click()
    await expect(page.getByText("Liquidity withdraw confirmed on chain.")).toBeVisible({ timeout: 90_000 })
    await chain.send([rule(deployment.programId, relay, deployment.venue, deployment.symbol, 18, u64(sequence++))], relay)
    await timeTravelTo(RPC, (await chainNow(RPC)) + 200)
    await page.goto(`${WEB}/app/trade/BWRS`)
    await expect(page.getByRole("region", { name: "Venue status" }).getByText("Halt data stale")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("button", { name: "Halt data stale" })).toBeDisabled()
    await assertRefusal(6002)
    await chain.send([heartbeatIx(deployment.programId, relay, deployment.venue, deployment.symbol, sequence++)], relay)
    await chain.send([setCapIx(deployment.programId, dataAuthority, deployment.venue, deployment.symbol, 1n, 1000n, 1, 1)], dataAuthority)
    await page.reload()
    await expect(page.getByRole("region", { name: "Venue status" }).getByText("Daily cap reached")).toBeVisible()
    await expect(page.getByRole("button", { name: "Daily cap reached" })).toBeDisabled()
    await assertRefusal(6005)
    await chain.send([setCapIx(deployment.programId, dataAuthority, deployment.venue, deployment.symbol, 100_000_000n, 1_000_000_000n, 1, 1)], dataAuthority)
    for (let count = 0; count < 2; count++) await chain.send([rule(deployment.programId, dataAuthority, deployment.venue, deployment.symbol, 20, i64(0n))], dataAuthority)
    await page.reload()
    await expect(page.getByRole("region", { name: "Venue status" }).getByText("Paused after second breach")).toBeVisible()
    await assertRefusal(6004)
    const revoke = await fetch(`${ISSUER}/revoke`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serviceEnv.CREDENTIAL_OPERATOR_TOKEN}` }, body: JSON.stringify({ wallet: wallet.address }) })
    expect(revoke.ok, `Revocation response ${revoke.status}: ${await revoke.text()}\nServices:\n${processLogs.join("\n")}`).toBe(true)
    await page.reload()
    await expect(page.getByRole("region", { name: "Venue status" }).getByText("Not admitted · Get admitted")).toBeVisible()
    await assertRefusal(6000)
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const route of ["/app/onboard", "/app/trade/BWRS", "/app/liquidity/BWRS"]) {
        await page.goto(`${WEB}${route}`)
        await expect(page.locator("main")).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${route} overflows at ${width}px`).toBe(true)
      }
    }
  } finally {
    await context.close()
  }
})

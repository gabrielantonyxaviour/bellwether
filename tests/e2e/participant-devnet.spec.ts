import { spawn, type ChildProcess } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { readFileSync } from "node:fs"
import { test, expect } from "@playwright/test"
import { address, getBase58Decoder } from "@solana/kit"
import { key, ensureKey } from "../../scripts/deploy/state"
import { installWallet, walletFromSigner } from "./operator-harness"

const WEB = "http://127.0.0.1:5195"
const API = "https://bellwether-api.larinova.com"
const RPC = `${API}/rpc`
const deployment = JSON.parse(readFileSync("scripts/deploy/deployments/devnet.json", "utf8")) as {
  rpcUrl: string; programId: string; venue: string; stockMint: string; pool: string
}
let server: ChildProcess

test.beforeEach(async ({ page }) => {
  const config = JSON.parse(readFileSync("scripts/deploy/deployments/devnet.web.json", "utf8")) as Record<string, string>
  await page.route("**/config.json", (route) => route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ ...config, apiBaseUrl: API, credentialApiUrl: API, rpcUrl: RPC }) }))
})

test.beforeAll(async () => {
  test.setTimeout(90_000)
  server = spawn("pnpm", ["-C", "web", "dev", "--host", "127.0.0.1", "--port", "5195", "--strictPort"], {
    cwd: process.cwd(), env: process.env, stdio: "ignore",
  })
  for (let tries = 0; tries < 100; tries++) {
    try { if ((await fetch(`${WEB}/config.json`)).ok) return } catch { /* Vite is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("Devnet web preview did not start")
})
test.afterAll(() => { if (server?.pid) server.kill("SIGTERM") })

test("participant screens read the deployed devnet program and live market services", async ({ page }) => {
  test.setTimeout(120_000)
  const pairs = await (await fetch(`${API}/symbols`)).json() as {
    symbols: { pool: string; stock_mint: string; program: string; symbol: string }[]
  }
  expect(pairs.symbols).toContainEqual(expect.objectContaining({
    pool: deployment.pool, stock_mint: deployment.stockMint, program: deployment.programId, symbol: "BWRS",
  }))
  const rpc = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo",
      params: [deployment.venue, { encoding: "base64", commitment: "confirmed" }] }) })
  expect((await rpc.json() as { result: { value: unknown } }).result.value).toBeTruthy()
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const route of ["/app/onboard", "/app/trade/BWRS", "/app/liquidity/BWRS"]) {
      await page.goto(`${WEB}${route}`)
      await expect(page.locator("main"), `${route} at ${width}px`).toBeVisible()
      if (route.includes("trade")) {
        await expect(page.getByRole("heading", { name: "BWRS / USDC" })).toBeVisible({ timeout: 30_000 })
        await expect(page.getByText("Budget used")).toBeVisible()
        await expect(page.getByRole("region", { name: "Tokenized stock info" })).toBeVisible()
      }
      if (route.includes("trade") || route.includes("liquidity")) {
        await expect(page.getByText("Chain data unavailable")).toHaveCount(0)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${route} overflows on devnet at ${width}px`).toBe(true)
    }
  }
})

const admittedWallet = async () => walletFromSigner(await key("devnet", "public-smoke-trader"), ensureKey("devnet", "public-smoke-trader"))
const journeyWallet = async () => {
  const path = ensureKey("devnet", "participant-ui-flow")
  return walletFromSigner(await key("devnet", "participant-ui-flow"), path)
}
function freshWallet() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicBytes = publicKey.export({ type: "spki", format: "der" }).subarray(-32)
  return { address: address(getBase58Decoder().decode(publicBytes)),
    pkcs8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), publicBytes: publicBytes.toString("base64") }
}
async function connect(page: import("@playwright/test").Page, wallet: Awaited<ReturnType<typeof admittedWallet>>) {
  await installWallet(page, wallet)
  await page.goto(`${WEB}/app/onboard`)
  await expect(page.getByRole("heading", { name: "Get admitted" })).toBeVisible()
  await page.getByRole("button", { name: "Connect wallet" }).last().click()
  await page.getByRole("button", { name: "Bellwether fork signer" }).click()
  await page.getByRole("link", { name: "Trade", exact: true }).click()
  return page.getByRole("region", { name: "Venue status" })
}
async function proxyCredential(page: import("@playwright/test").Page, unavailable: () => boolean = () => false) {
  await page.route("**/credential/*", async (route) => {
    if (unavailable()) return route.abort()
    try {
      const response = await fetch(route.request().url(), { signal: AbortSignal.timeout(10_000) })
      await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text(),
        headers: { "access-control-allow-origin": "*" } })
    } catch { await route.abort() }
  })
}

async function proxyAdmission(page: import("@playwright/test").Page) {
  await page.route("**/admit**", async (route) => {
    const request = route.request()
    const response = await fetch(request.url(), { method: request.method(), body: request.postData() || undefined,
      headers: { "content-type": "application/json", origin: "https://bellwether.larinova.com" }, signal: AbortSignal.timeout(120_000) })
    await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text(),
      headers: { "access-control-allow-origin": "*" } })
  })
}

async function installDevnetWallet(page: import("@playwright/test").Page, wallet: Awaited<ReturnType<typeof journeyWallet>>) {
  await page.addInitScript(({ walletAddress, pkcs8, publicBytes, rpcUrl }) => {
    const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
    const key = crypto.subtle.importKey("pkcs8", decode(pkcs8), { name: "Ed25519" }, false, ["sign"])
    const account = { address: walletAddress, publicKey: decode(publicBytes), chains: ["solana:devnet"],
      features: ["solana:signMessage", "solana:signAndSendTransaction"] }
    const sign = async (message: Uint8Array) => new Uint8Array(await crypto.subtle.sign("Ed25519", await key, message))
    const walletObject = { version: "1.0.0", name: "Bellwether devnet signer", chains: ["solana:devnet"],
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz48L3N2Zz4=",
      accounts: [account], features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
        "solana:signMessage": { version: "1.0.0", signMessage: async ({ message }: { message: Uint8Array }) => [{ signature: await sign(message) }] },
        "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: [0],
          signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(async ({ transaction }) => {
            const wire = new Uint8Array(transaction)
            if (wire[0] !== 1) throw new Error("Devnet signer expects one transaction signature")
            wire.set(await sign(wire.subarray(65)), 1)
            const base64 = btoa(Array.from(wire, (byte) => String.fromCharCode(byte)).join(""))
            const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [base64, { encoding: "base64" }] }) })
            const body = await response.json() as { result?: string; error?: { message: string } }
            if (!response.ok || body.error || !body.result) throw new Error(body.error?.message ?? `RPC HTTP ${response.status}`)
            return { signature: wire.slice(1, 65) }
          })) },
      } }
    window.addEventListener("wallet-standard:app-ready", (event) => {
      (event as Event & { detail: { register: (value: unknown) => void } }).detail.register(walletObject)
    })
  }, { walletAddress: wallet.address, pkcs8: wallet.pkcs8, publicBytes: wallet.publicBytes, rpcUrl: RPC })
}

test("fresh devnet wallet admits, buys, deposits and withdraws through the UI", async ({ page }) => {
  test.setTimeout(360_000)
  let broadcasts = 0
  const rpcEvents: string[] = []
  page.on("request", (request) => {
    if (request.url() === RPC && request.method() === "POST" && request.postDataJSON()?.method === "sendTransaction") broadcasts++
  })
  page.on("response", (response) => {
    if (response.url() !== RPC) return
    const method = response.request().postDataJSON()?.method
    void response.json().then((body: { error?: { message?: string } }) => {
      rpcEvents.push(`${method}: HTTP ${response.status()}${body.error ? ` ${body.error.message}` : ""}`)
    }).catch(() => { rpcEvents.push(`${method}: unreadable HTTP ${response.status()}`) })
  })
  page.on("requestfailed", (request) => {
    if (request.url() === RPC) rpcEvents.push(`${request.postDataJSON()?.method}: ${request.failure()?.errorText}`)
  })
  await proxyAdmission(page)
  await proxyCredential(page)
  const wallet = await journeyWallet()
  const before = await (await fetch(`${API}/credential/${wallet.address}`)).json() as { status: string }
  await installDevnetWallet(page, wallet)
  await page.goto(`${WEB}/app/onboard`)
  await page.getByRole("button", { name: "Connect wallet" }).last().click()
  await page.getByRole("button", { name: "Bellwether devnet signer" }).click()
  if (before.status !== "admitted") await page.getByRole("button", { name: "Sign challenge and get admitted" }).click()
  await expect(page.getByText("Your credential is onchain")).toBeVisible({ timeout: 120_000 })
  await page.getByRole("link", { name: "Trade", exact: true }).click()
  await expect(page.getByRole("region", { name: "Venue status" }).getByText("admitted", { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole("textbox", { name: "You pay · USDC" }).fill("0.05")
  await page.getByRole("button", { name: "Review buy" }).click()
  await page.getByRole("button", { name: "Confirm swap" }).click()
  try { await expect(page.getByText("Swap confirmed.")).toBeVisible({ timeout: 90_000 }) }
  catch { throw new Error(`Signed swap broadcasts: ${broadcasts}\nRPC: ${rpcEvents.join("; ")}\nTrade screen: ${await page.locator("main").innerText()}`) }
  expect(broadcasts, "browser wallet must submit a signed swap through the RPC gateway").toBeGreaterThan(0)
  const swapUrl = await page.getByRole("link", { name: "View transaction ↗" }).getAttribute("href")
  const swapSignature = swapUrl ? new URL(swapUrl).pathname.split("/").at(-1) : null
  expect(swapSignature).toBeTruthy()
  await expect.poll(async () => {
    const tape = await (await fetch(`${API}/tape?symbol=BWRS`)).json() as { prints: { signature: string }[] }
    return tape.prints.some((print) => print.signature === swapSignature)
  }, { timeout: 60_000 }).toBe(true)
  await page.goto(`${WEB}/app/liquidity/BWRS`)
  await expect(page.getByRole("heading", { name: "Provide liquidity" })).toBeVisible()
  await page.getByRole("textbox", { name: "BWRS amount" }).fill("0.001")
  await page.getByRole("button", { name: "Review deposit" }).click()
  await page.getByRole("button", { name: "Confirm deposit" }).click()
  try { await expect(page.getByText("Liquidity deposit confirmed on chain.")).toBeVisible({ timeout: 90_000 }) }
  catch { throw new Error(`Deposit screen: ${await page.locator("main").innerText()}`) }
  await page.getByRole("tab", { name: "Withdraw" }).click()
  await page.getByRole("button", { name: "MAX" }).click()
  await page.getByRole("button", { name: "Review withdrawal" }).click()
  await page.getByRole("button", { name: "Confirm withdraw" }).click()
  try { await expect(page.getByText("Liquidity withdraw confirmed on chain.")).toBeVisible({ timeout: 90_000 }) }
  catch { throw new Error(`Withdrawal screen: ${await page.locator("main").innerText()}`) }
})

test("connected admitted devnet wallet resolves its credential", async ({ page }) => {
  await proxyCredential(page)
  const status = await connect(page, await admittedWallet())
  await expect(status.getByText("admitted", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(status.getByText("Checking…")).toHaveCount(0)
})

test("connected fresh devnet wallet resolves as not admitted", async ({ page }) => {
  await proxyCredential(page)
  const status = await connect(page, freshWallet())
  await expect(status.getByText("not_admitted", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(status.getByText("Checking…")).toHaveCount(0)
})

test("issuer failure resolves to error and can retry", async ({ page }) => {
  let unavailable = true
  await proxyCredential(page, () => unavailable)
  const status = await connect(page, await admittedWallet())
  await expect(status.getByText("Issuer unavailable")).toBeVisible({ timeout: 30_000 })
  unavailable = false
  await status.getByRole("button", { name: "Retry credential check" }).click()
  await expect(status.getByText("admitted", { exact: true })).toBeVisible({ timeout: 30_000 })
})

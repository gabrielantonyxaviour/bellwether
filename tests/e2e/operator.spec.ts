import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { test, expect } from "@playwright/test"
import {
  appendTransactionMessageInstructions, createTransactionMessage, generateKeyPairSigner, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, getAddressEncoder, type Address, type Instruction, type KeyPairSigner,
} from "@solana/kit"
import { createChain, type Chain } from "../../scripts/assets/tx"
import { chainNow, timeTravelTo } from "../../services/notice/fork/env"
import { API, installWallet, ISSUER, i64, PORT, RPC, rule, shortAddress, startOperatorStack, u64, walletFromSigner, WEB, type OperatorStack } from "./operator-harness"
import { operatorSingleFlight } from "./operator-flight"

test.describe.configure({ mode: "serial", retries: 0 })
test.use({ actionTimeout: 20_000, navigationTimeout: 20_000 })

test("operator workbench on an isolated fork", async ({ browser }) => {
  test.setTimeout(540_000)
  await operatorSingleFlight(async () => {
    const stack = await startOperatorStack()
    const chain = createChain(RPC)
    await chain.fundSol(stack.admin.address, 3_000_000_000n)
    const demoMint = await plantMint(stack.admin.address)
    const objectedMint = await plantMint(stack.admin.address)
    const home = process.env.HOME ?? ""
    const wallet = walletFromSigner(stack.admin, `${home}/.config/solana/bellwether/fork/venue-admin.json`)
    mkdirSync("evidence", { recursive: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: "evidence", size: { width: 1440, height: 900 } } })
    const page = await context.newPage()
    await page.route("**/config.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }))
    const video = page.video()
    let complete = false
    await installWallet(page, wallet)
    const seenUrls: string[] = []
    page.on("request", (req) => { if (/halts|symbols|notice/.test(req.url())) seenUrls.push(req.url()) })
    try {
      await page.goto(`${WEB}/operator`)
      await connectAdmin(page, stack.admin.address)
      await expect(page.getByRole("heading", { name: "Operator overview" })).toBeVisible()
      await expect(page.getByRole("meter").first(), await page.locator("main").innerText()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(/\d+s ago/).first()).toBeVisible()

      const seq = (await symbolField(stack.deployment.symbol, 144)) + 1n
      const now = await chainNow(RPC)
      const reason = new Uint8Array(8)
      reason.set(new TextEncoder().encode("LUDP"))
      const signature = await sendVisible(chain, [rule(stack.deployment.programId, stack.relay, stack.deployment.venue, stack.deployment.symbol, Uint8Array.from([17, ...u64(seq), ...reason, ...i64(BigInt(now))]))], stack.relay)
      const seen = new Date().toISOString()
      mkdirSync(`services/relay/data/fork-${PORT}`, { recursive: true })
      const ledgerFile = `services/relay/data/fork-${PORT}/relay.json`
      writeFileSync(ledgerFile, JSON.stringify({
        version: 1,
        status: { lastPollAt: seen, lastPollOk: true, lastPollError: null, lastSource: "nasdaq", feedPublishedAt: seen, consecutiveFailures: 0, lastHeartbeatAt: seen, lastHeartbeatSignature: null, lastTxError: null, crossCheck: null, symbols: {} },
        ledger: [{ id: "bwrs-halt", nasdaqSymbol: "FWDI", ticker: "BWRS", symbolRecord: stack.deployment.symbol, reasonCode: "LUDP", nasdaqHaltTime: seen, feedSeenAt: seen, haltSignature: signature, haltConfirmedAt: seen, haltSlot: null, detectionMs: 1200, enforcementMs: 800, resumedAt: null, resumeSeenAt: null, clearSignature: null, clearConfirmedAt: null, status: "halted" }],
      }))
      const served = await (await fetch(`${API}/halts`)).text()
      expect(served, served).toContain("LUDP")
      await page.goto(`${WEB}/operator/halts`)
      await expect(page.getByRole("heading", { name: "Halts and latency" })).toBeVisible()
      await expect.poll(async () => `${seenUrls.join(" | ")}\n${await page.locator("main").innerText()}`, { timeout: 20_000 }).toContain("LUDP")
      const venueRequests = seenUrls.map((value) => new URL(value)).filter((url) => /^\/(halts|symbols|notice)(\/|$)/.test(url.pathname))
      expect(venueRequests.length).toBeGreaterThan(0)
      expect(venueRequests.every((url) => url.port === "8992"), seenUrls.join(" | ")).toBe(true)
      const haltsText = await page.locator("main").innerText()
      expect(haltsText).toContain("1200 ms")

      await page.goto(`${WEB}/operator/symbols`)
      await connectAdmin(page, stack.admin.address)
      await expect(page.getByRole("heading", { name: "BWRS" })).toBeVisible({ timeout: 30_000 })
      await register(page, "DEMO", demoMint)
      const demo = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "DEMO", exact: true }) })
      await expect(demo.getByText("Notice not recorded")).toBeVisible({ timeout: 20_000 })
      await demo.getByRole("button", { name: "Record receipt at chain time" }).click()
      await page.getByRole("button", { name: "Confirm notice" }).click()
      await expect(page.getByText("Confirmed").first()).toBeVisible({ timeout: 90_000 })
      await expect(demo.getByText(/Notice clock/)).toBeVisible({ timeout: 20_000 })
      await demo.getByRole("button", { name: "Review activation" }).click()
      await page.getByRole("button", { name: "Confirm activation" }).click()
      await expect(page.getByRole("alert").filter({ hasText: "Issuer notice window still open" })).toBeVisible({ timeout: 90_000 })

      await register(page, "OBJ", objectedMint)
      const objected = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "OBJ", exact: true }) })
      await objected.getByRole("button", { name: "Review objection" }).click()
      await page.getByRole("button", { name: "Confirm objection" }).click()
      await expect(page.getByText("Confirmed").first()).toBeVisible({ timeout: 90_000 })
      await expect(objected.getByText("Issuer objected")).toBeVisible({ timeout: 20_000 })
      await objected.getByRole("button", { name: "Review activation" }).click()
      await page.getByRole("button", { name: "Confirm activation" }).click()
      await expect(page.getByRole("alert").filter({ hasText: "Issuer objected" })).toBeVisible({ timeout: 90_000 })

      await timeTravelTo(RPC, (await chainNow(RPC)) + 30 * 86_400 + 120)
      await page.getByRole("link", { name: "Overview" }).click()
      await page.getByRole("link", { name: "Symbols" }).click()
      await expect(demo.getByText("Eligible to activate")).toBeVisible({ timeout: 30_000 })
      await demo.getByRole("button", { name: "Review activation" }).click()
      await page.getByRole("button", { name: "Confirm activation" }).click()
      await expect(page.getByText("Confirmed").first()).toBeVisible({ timeout: 90_000 })
      await expect(demo.getByText("Active")).toBeVisible({ timeout: 20_000 })

    const subject = (await generateKeyPairSigner()).address
    await page.goto(`${WEB}/operator/participants`)
    await expect(page.getByText("No wallet selected")).toBeVisible()
    await expect(page.getByText("Reading credential…")).toHaveCount(0)
    await page.getByLabel("Operator token").fill(stack.operatorToken)
      await page.getByRole("button", { name: "Save token" }).click()
      await page.getByLabel("Participant wallet").fill(subject)
      await page.getByRole("button", { name: "Review issue" }).click()
      await page.getByRole("button", { name: "Confirm issue" }).click()
      await expect.poll(async () => page.locator("main").innerText(), { timeout: 90_000 }).toMatch(/Issued|unavailable|OFAC|Screening/)
      const admission = await page.locator("main").innerText()
      if (admission.includes("Issued")) {
        await expect(page.getByRole("table", { name: "Screening log" })).toContainText("admitted")
        await page.getByRole("button", { name: "Review revoke" }).click()
        await page.getByRole("button", { name: "Confirm revoke" }).click()
        await expect(page.getByText(/^Revoked /)).toBeVisible({ timeout: 90_000 })
        await expect(page.getByText("revoked", { exact: true })).toBeVisible({ timeout: 20_000 })
        const revoked = await (await fetch(`${ISSUER}/credential/${subject}`)).json() as { status: string }
        expect(revoked.status).toBe("revoked")
      } else {
        expect(admission).toMatch(/unavailable|OFAC|Screening/)
      }

      const draft = await fetch(`${API}/notice/draft`)
      expect(draft.ok, await draft.text()).toBe(true)
      await page.goto(`${WEB}/operator/public-notice`)
      const authorities = page.getByRole("region", { name: "Chain-read authorities" })
      await expect(authorities).toBeVisible({ timeout: 90_000 })
      await expect(authorities.getByText("Upgrade authority")).toBeVisible()
      await expect(authorities.getByRole("link").first()).toBeVisible()

      const report = await fetch(`${API}/rehearsal/fwdi`)
      expect(report.ok, await report.text()).toBe(true)
    await page.goto(`${WEB}/operator/rehearsal/fwdi`)
    await expect(page.getByRole("heading", { name: "FWDI launch rehearsal" })).toBeVisible()
    await expect(page.getByText("Tier 2").first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/frozen/i).first()).toBeVisible()
    const fwdiAccounts = await page.locator('main a[href^="https://solscan.io/account/"]').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))
    expect(fwdiAccounts.length).toBeGreaterThan(0)
    expect(fwdiAccounts.every((href) => !new URL(href).searchParams.has("cluster")), fwdiAccounts.join(" | ")).toBe(true)

      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        for (const route of ["/operator", "/operator/symbols", "/operator/halts", "/operator/participants", "/operator/public-notice", "/operator/rehearsal/fwdi"]) {
          await page.goto(`${WEB}${route}`)
          await expect(page.locator("main")).toBeVisible()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${route} overflows at ${width}px`).toBe(true)
      }
    }
    const devnetConfig = JSON.parse(readFileSync("scripts/deploy/deployments/devnet.web.json", "utf8")) as Record<string, string>
    await page.unroute("**/config.json")
    await page.route("**/config.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ...devnetConfig, apiBaseUrl: "https://bellwether-api.larinova.com", credentialApiUrl: "https://bellwether-api.larinova.com", rpcUrl: "https://bellwether-api.larinova.com/rpc",
    }) }))
    await page.goto(`${WEB}/operator/symbols`)
    await expect(page.getByRole("heading", { name: "BWRS" })).toBeVisible({ timeout: 30_000 })
    const devnetAccounts = await page.locator('main a[href^="https://solscan.io/account/"]').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))
    expect(devnetAccounts.length).toBeGreaterThan(0)
    expect(devnetAccounts.every((href) => new URL(href).searchParams.get("cluster") === "devnet"), devnetAccounts.join(" | ")).toBe(true)
    complete = true
    } finally {
      await context.close()
      await stack.stop()
      if (video) {
        const recorded = await video.path()
        if (complete) renameSync(recorded, "evidence/operator-workbench.webm")
        else rmSync(recorded, { force: true })
      }
    }
  })
})

/** A Token-2022 mint written with surfnet_setAccount. 82-byte base, initialized at byte 45. */
async function plantMint(authority: Address): Promise<Address> {
  const mint = (await generateKeyPairSigner()).address
  const data = Buffer.alloc(82)
  const key = Buffer.from(getAddressEncoder().encode(authority))
  data.writeUInt32LE(1, 0)
  data.set(key, 4)
  data[44] = 6
  data[45] = 1
  data.writeUInt32LE(1, 46)
  data.set(key, 50)
  const response = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_setAccount", params: [mint, { lamports: 2_000_000, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: data.toString("hex") }] }),
  })
  const body = await response.json() as { error?: unknown }
  if (body.error) throw new Error(`surfnet_setAccount: ${JSON.stringify(body.error)}`)
  return mint
}

async function sendVisible(chain: Chain, instructions: Instruction[], payer: KeyPairSigner) {
  const { value: blockhash } = await chain.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  let body: { error?: unknown; result?: string } = {}
  let responseStatus = 0
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(chain.rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [getBase64EncodedWireTransaction(signed), { encoding: "base64", skipPreflight: true }] }),
    })
    responseStatus = response.status
    body = await response.json() as { error?: unknown; result?: string }
    if (body.result && !body.error) break
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))
  }
  if (body.error || !body.result) throw new Error(`sendTransaction HTTP ${responseStatus}: ${JSON.stringify(body.error ?? body)}`)
  const signature = getSignatureFromTransaction(signed)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const { value } = await chain.rpc.getSignatureStatuses([signature]).send()
    const status = value[0]
    if (status?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return signature
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`transaction ${signature} was not confirmed`)
}

async function connectAdmin(page: import("@playwright/test").Page, admin: string) {
  const connected = page.getByRole("button", { name: shortAddress(admin) })
  const connect = page.getByRole("button", { name: "Connect wallet" })
  await expect(connected.or(connect)).toBeVisible()
  if (await connect.isVisible()) await connect.click()
  await expect(connected).toBeVisible()
}

async function register(page: import("@playwright/test").Page, ticker: string, mint: string) {
  await page.getByLabel("Ticker").fill(ticker)
  await page.getByLabel("Stock mint").fill(mint)
  await page.getByLabel("Tier").selectOption("2")
  const review = page.getByRole("button", { name: "Review registration" })
  await expect(review).toBeEnabled()
  await review.click()
  await page.getByRole("button", { name: "Confirm registration" }).click()
  await expect.poll(async () => page.locator("main").innerText(), { timeout: 60_000 }).toContain("Confirmed")
  await expect(page.getByRole("heading", { name: ticker, exact: true })).toBeVisible({ timeout: 20_000 })
}

async function symbolField(pubkey: string, offset: number): Promise<bigint> {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pubkey, { encoding: "base64" }] }) })
  const body = await response.json() as { result: { value: { data: [string, string] } } }
  const data = Buffer.from(body.result.value.data[0], "base64")
  return data.readBigUInt64LE(offset)
}

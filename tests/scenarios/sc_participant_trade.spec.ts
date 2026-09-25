/** ABEL SCENARIO — generated. Fill in selectors and assertions; do not rename step ids.
 *  scenario:   sc_participant_trade
 *  mapping:    2
 *  definition: 50ff49793311f056c25b4974c30419743118130134055d0236bea2a1aee0b6e7
 *
 *  Regenerate with: npm run graph -- scenario-spec --product <id>
 *  Your code between the `>>> abel:<id>` markers is preserved across regeneration.
 */
import { readFileSync } from "node:fs"
import { address, createSolanaRpc, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token"
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda as stockAta } from "@solana-program/token-2022"
import { fetchRaw } from "../../services/credential/backend"
import { attestationAddress } from "../../services/credential/sas"
import { swapIx, BUY, type PoolKeys } from "../../services/credential/venue-ix"
import { venueErrorIn } from "../../services/relay/program"
import { createDeploymentChain } from "../../scripts/deploy/chain"
import { errorText } from "../../scripts/assets/tx"
import { installDevnetWallet } from "./devnet-wallet"
import { scenario, step, expect, test } from "./_abel"

const WEB = "https://bellwether.larinova.com"
const API = "https://bellwether-api.larinova.com"
const d = JSON.parse(readFileSync("scripts/deploy/deployments/devnet.json", "utf8")) as {
  rpcUrl: string; programId: string; venue: string; symbol: string; pool: string; stockMint: string;
  usdcMint: string; stockVault: string; usdcVault: string; sasCredential: string; sasSchema: string
}
const rpc = createSolanaRpc(d.rpcUrl)
const raw = async (id: string) => {
  const account = await fetchRaw(rpc, address(id))
  if (!account) throw new Error(`Missing devnet account ${id}`)
  return new DataView(account.data.buffer, account.data.byteOffset)
}
const market: PoolKeys = { venue: address(d.venue), symbol: address(d.symbol), pool: address(d.pool),
  stockMint: address(d.stockMint), usdcMint: address(d.usdcMint), stockVault: address(d.stockVault), usdcVault: address(d.usdcVault) }
const credentialFor = (wallet: KeyPairSigner) => attestationAddress({ issuer: wallet.address,
  credential: address(d.sasCredential), schema: address(d.sasSchema) }, wallet.address)
const fixtureWallet = "541aeWinzDzjjHFRaC7bvid4xWTQCdYSmXpgHPTdbz7r"

scenario("sc_participant_trade", "participant", () => {
  let wallet: KeyPairSigner
  let swapSignature = ""
  let reservesBefore: { stock: bigint; usdc: bigint; shares: bigint }
  step("connect", "Connect wallet", async ({ page }) => {
    // action:   Open /app/onboard and connect the wallet
    // expected: Wallet address shown; admission not yet granted
    // >>> abel:connect
    test.setTimeout(480_000)
    wallet = await installDevnetWallet(page)
    await page.goto(`${WEB}/app/onboard`)
    await expect(page.getByRole("heading", { name: "Get admitted" })).toBeVisible()
    await page.getByRole("button", { name: "Connect wallet" }).last().click()
    await page.getByRole("button", { name: "Bellwether journey signer" }).click()
    await expect(page.getByText("Bellwether journey signer")).toBeVisible()
    const status = await (await fetch(`${API}/credential/${wallet.address}`)).json() as { status: string }
    expect(status.status).toBe("not_admitted")
    // <<< abel:connect
  })
  step("admit", "Get admitted", async ({ page }) => {
    // action:   Request admission
    // expected: OFAC screening passes, a test-admission attestation is issued and the rehearsal-stock account is thawed
    // >>> abel:admit
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole("button", { name: attempt ? "Retry admission" : "Sign challenge and get admitted" }).click()
      await expect.poll(async () => {
        const body = await page.locator("main").innerText()
        return body.includes("Your credential is onchain") || body.includes("Admission did not finish")
      }, { timeout: 180_000 }).toBe(true)
      if ((await page.locator("main").innerText()).includes("Your credential is onchain")) break
      if (attempt === 2) throw new Error(`Admission failed: ${await page.locator("main").innerText()}`)
    }
    const status = await (await fetch(`${API}/credential/${wallet.address}`)).json() as {
      status: string; stockAccount: { state: string }; expiresAt: string
    }
    expect(status.status).toBe("admitted")
    expect(status.stockAccount.state).toBe("thawed")
    expect(Date.parse(status.expiresAt)).toBeGreaterThan(Date.now())

    const line = readFileSync("services/.env.devnet", "utf8").split(/\r?\n/)
      .find((entry) => entry.startsWith("CREDENTIAL_OPERATOR_TOKEN="))
    if (!line) throw new Error("Credential operator token is unavailable for the SDN fixture check")
    const refused = await fetch(`${API}/admit`, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${line.slice("CREDENTIAL_OPERATOR_TOKEN=".length)}` },
      body: JSON.stringify({ wallet: fixtureWallet }) })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual(expect.objectContaining({ code: "SANCTIONED" }))
    // <<< abel:admit
  })
  step("swap", "Swap USDC for rehearsal stock", async ({ page }) => {
    // action:   Open /app/trade/<symbol>, enter an amount, confirm
    // expected: Swap confirms; reserves move per x·y=k net of fee; today's share count increases
    // >>> abel:swap
    const poolBefore = await raw(d.pool)
    const symbolBefore = await raw(d.symbol)
    reservesBefore = { stock: poolBefore.getBigUint64(168, true), usdc: poolBefore.getBigUint64(176, true),
      shares: symbolBefore.getBigUint64(120, true) }
    await page.goto(`${WEB}/app/trade/BWRS`)
    await expect(page.getByRole("heading", { name: "BWRS / USDC" })).toBeVisible({ timeout: 30_000 })
    await page.getByRole("textbox", { name: "You pay · USDC" }).fill("0.05")
    await page.getByRole("button", { name: "Review buy" }).click()
    await page.getByRole("button", { name: "Confirm swap" }).click()
    await expect(page.getByText("Swap confirmed.", { exact: false })).toBeVisible({ timeout: 120_000 })
    const href = await page.getByRole("link", { name: /View transaction/ }).getAttribute("href")
    swapSignature = href?.match(/\/tx\/([^?]+)/)?.[1] ?? ""
    expect(swapSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,100}$/)
    const poolAfter = await raw(d.pool)
    const symbolAfter = await raw(d.symbol)
    expect(poolAfter.getBigUint64(168, true)).toBeLessThan(reservesBefore.stock)
    expect(poolAfter.getBigUint64(176, true)).toBeGreaterThan(reservesBefore.usdc)
    expect(symbolAfter.getBigUint64(120, true)).toBeGreaterThan(reservesBefore.shares)

    const unadmitted = await generateKeyPairSigner()
    const [stock] = await stockAta({ owner: unadmitted.address, mint: market.stockMint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    const [usdc] = await findAssociatedTokenPda({ owner: unadmitted.address, mint: market.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS })
    try {
      const signature = await createDeploymentChain(d.rpcUrl).send([swapIx(address(d.programId), market,
        unadmitted, stock, usdc, await credentialFor(unadmitted), BUY, 1_000n, 1n)], wallet)
      throw new Error(`Unadmitted swap unexpectedly confirmed ${signature}`)
    } catch (cause) {
      const detail = errorText(cause)
      if (detail.includes("unexpectedly confirmed")) throw cause
      expect(venueErrorIn(detail)).toBe("NotAdmitted")
    }
    // <<< abel:swap
  })
  step("tape", "See the print", async ({ page }) => {
    // action:   Open /explorer
    // expected: The trade appears with symbols, price, size, UTC time, direction, pool and program
    // >>> abel:tape
    await expect.poll(async () => {
      const tape = await (await fetch(`${API}/tape?symbol=BWRS`)).json() as {
        prints: { signature: string; pair: string; time: string; direction: string; pool: string; program: string }[]
      }
      return tape.prints.find((print) => print.signature === swapSignature)
    }, { timeout: 90_000 }).toEqual(expect.objectContaining({ pair: "BWRS/USDC", direction: "buy",
      pool: d.pool, program: d.programId, time: expect.any(String) }))
    await page.goto(`${WEB}/explorer?date=${new Date().toISOString().slice(0, 10)}`)
    await expect(page.locator(`a[href*="${swapSignature}"]`).first()).toBeVisible({ timeout: 30_000 })
    // <<< abel:tape
  })
})

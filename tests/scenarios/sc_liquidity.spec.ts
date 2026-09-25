/** ABEL SCENARIO — generated. Fill in selectors and assertions; do not rename step ids.
 *  scenario:   sc_liquidity
 *  mapping:    1
 *  definition: 9ded51b7e1c9e267c4123f92d56bb097d6001bd099451054b26da96bb86a5a48
 *
 *  Regenerate with: npm run graph -- scenario-spec --product <id>
 *  Your code between the `>>> abel:<id>` markers is preserved across regeneration.
 */
import { readFileSync } from "node:fs"
import { address, createSolanaRpc, type KeyPairSigner } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token"
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda as stockAta } from "@solana-program/token-2022"
import { fetchRaw, chainNow } from "../../services/credential/backend"
import { attestationAddress } from "../../services/credential/sas"
import { addLiquidityIx, lpPda, type PoolKeys } from "../../services/credential/venue-ix"
import { clearHaltInstruction, decodeSymbolRecord, setHaltInstruction, venueErrorIn } from "../../services/relay/program"
import { createDeploymentChain } from "../../scripts/deploy/chain"
import { key } from "../../scripts/deploy/state"
import { errorText } from "../../scripts/assets/tx"
import { installDevnetWallet } from "./devnet-wallet"
import { scenario, step, expect, test } from "./_abel"

const WEB = "https://bellwether.larinova.com"
const d = JSON.parse(readFileSync("scripts/deploy/deployments/devnet.json", "utf8")) as {
  rpcUrl: string; programId: string; venue: string; symbol: string; pool: string; stockMint: string;
  usdcMint: string; stockVault: string; usdcVault: string; sasCredential: string; sasSchema: string
}
const market: PoolKeys = { venue: address(d.venue), symbol: address(d.symbol), pool: address(d.pool),
  stockMint: address(d.stockMint), usdcMint: address(d.usdcMint), stockVault: address(d.stockVault), usdcVault: address(d.usdcVault) }
const programId = address(d.programId)
const rpc = createSolanaRpc(d.rpcUrl)
const chain = createDeploymentChain(d.rpcUrl)
const account = async (id: string) => {
  const data = await fetchRaw(rpc, address(id))
  if (!data) throw new Error(`Missing devnet account ${id}`)
  return data.data
}

scenario("sc_liquidity", "covered_firm", () => {
  let wallet: KeyPairSigner
  let position: string
  step("add", "Add liquidity", async ({ page }) => {
    // action:   Open /app/liquidity/<symbol> and deposit
    // expected: Position recorded as non-transferable
    // >>> abel:add
    test.setTimeout(480_000)
    wallet = await installDevnetWallet(page)
    await page.goto(`${WEB}/app/onboard`)
    await page.getByRole("button", { name: "Connect wallet" }).last().click()
    await page.getByRole("button", { name: "Bellwether journey signer" }).click()
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole("button", { name: attempt ? "Retry admission" : "Sign challenge and get admitted" }).click()
      await expect.poll(async () => {
        const body = await page.locator("main").innerText()
        return body.includes("Your credential is onchain") || body.includes("Admission did not finish")
      }, { timeout: 180_000 }).toBe(true)
      if ((await page.locator("main").innerText()).includes("Your credential is onchain")) break
      if (attempt === 2) throw new Error(`Admission failed: ${await page.locator("main").innerText()}`)
    }
    await page.goto(`${WEB}/app/trade/BWRS`)
    await page.getByRole("textbox", { name: "You pay · USDC" }).fill("0.05")
    await page.getByRole("button", { name: "Review buy" }).click()
    await page.getByRole("button", { name: "Confirm swap" }).click()
    await expect(page.getByText("Swap confirmed.", { exact: false })).toBeVisible({ timeout: 120_000 })
    await page.goto(`${WEB}/app/liquidity/BWRS`)
    await expect(page.getByRole("heading", { name: "Provide liquidity" })).toBeVisible()
    await page.getByRole("textbox", { name: "BWRS amount" }).fill("0.001")
    await page.getByRole("button", { name: "Review deposit" }).click()
    await page.getByRole("button", { name: "Confirm deposit" }).click()
    await expect(page.getByText("Liquidity deposit confirmed on chain.", { exact: false })).toBeVisible({ timeout: 120_000 })
    position = await lpPda(programId, market.pool, wallet.address)
    const lp = new DataView((await account(position)).buffer)
    expect(lp.getBigUint64(72, true)).toBeGreaterThan(0n)
    await expect(page.getByText("Non-transferable", { exact: true })).toBeVisible()
    // <<< abel:add
  })
  step("withdraw_halted", "Withdraw while halted", async ({ page }) => {
    // action:   Symbol halted; attempt add, then withdraw
    // expected: Add fails TradingHalted; withdraw succeeds; page reads 'Halted: withdraw only'
    // >>> abel:withdraw_halted
    if (process.env.BELLWETHER_HALT_WINDOW !== "BWRS") {
      throw new Error("Coordinate a devnet BWRS halt window, then set BELLWETHER_HALT_WINDOW=BWRS")
    }
    const relay = await key("devnet", "relay")
    const initial = decodeSymbolRecord(await account(d.symbol))
    if (initial.halted) throw new Error("BWRS was already halted; this test will not clear another halt")
    let ownsHalt = false
    try {
      await chain.send([setHaltInstruction({ programId, relay, venue: market.venue,
        symbol: market.symbol, seq: initial.seq + 1n, reason: "LUDP", feedTs: await chainNow(rpc) })], relay)
      ownsHalt = true
      await page.reload()
      await expect(page.getByText("Halted: withdraw only.")).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole("button", { name: "Halted: withdraw only" })).toBeDisabled()

      const [stock] = await stockAta({ owner: wallet.address, mint: market.stockMint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
      const [usdc] = await findAssociatedTokenPda({ owner: wallet.address, mint: market.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS })
      const credential = await attestationAddress({ issuer: wallet.address,
        credential: address(d.sasCredential), schema: address(d.sasSchema) }, wallet.address)
      try {
        const signature = await chain.send([await addLiquidityIx(programId, market, wallet,
          stock, usdc, credential, 100n, 1_000n, 1n)], wallet)
        throw new Error(`Halted deposit unexpectedly confirmed ${signature}`)
      } catch (cause) {
        const detail = errorText(cause)
        if (detail.includes("unexpectedly confirmed")) throw cause
        expect(venueErrorIn(detail)).toBe("TradingHalted")
      }
      await page.getByRole("tab", { name: "Withdraw" }).click()
      await page.getByRole("button", { name: "MAX" }).click()
      await page.getByRole("button", { name: "Review withdrawal" }).click()
      await page.getByRole("button", { name: "Confirm withdraw" }).click()
      await expect(page.getByText("Liquidity withdraw confirmed on chain.", { exact: false })).toBeVisible({ timeout: 120_000 })
      const lp = await fetchRaw(rpc, address(position))
      const shares = lp ? new DataView(lp.data.buffer, lp.data.byteOffset).getBigUint64(72, true) : 0n
      expect(shares).toBe(0n)
    } finally {
      if (ownsHalt) {
        const state = decodeSymbolRecord(await account(d.symbol))
        if (state.halted) await chain.send([clearHaltInstruction({ programId, relay, venue: market.venue,
          symbol: market.symbol, seq: state.seq + 1n })], relay)
        expect(decodeSymbolRecord(await account(d.symbol)).halted).toBe(false)
      }
    }
    // <<< abel:withdraw_halted
  })
})

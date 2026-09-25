/** ABEL SCENARIO — generated. Fill in selectors and assertions; do not rename step ids.
 *  scenario:   sc_public_verify
 *  mapping:    3
 *  definition: 825f4db5975a21f5f1d66dac859b5315bee80500604d3c98a71a0d3f43126605
 *
 *  Regenerate with: npm run graph -- scenario-spec --product <id>
 *  Your code between the `>>> abel:<id>` markers is preserved across regeneration.
 */
import { readFileSync } from "node:fs"
import { scenario, step, expect, test } from "./_abel"

const WEB = "https://bellwether.larinova.com"
const API = "https://bellwether-api.larinova.com"
const deployment = JSON.parse(readFileSync("scripts/deploy/deployments/devnet.json", "utf8")) as {
  rpcUrl: string; programId: string; signatures: Record<string, string>
}

scenario("sc_public_verify", "public", () => {
  step("home", "Open home", async ({ page }) => {
    // action:   Open /
    // expected: Explains Bellwether and links to trade, explorer and About on devnet
    // >>> abel:home
    test.setTimeout(120_000)
    await page.goto(WEB)
    await expect(page.getByRole("heading", { name: /Permissioned pools for tokenized US stocks/ })).toBeVisible()
    await expect(page.getByRole("link", { name: /Open trade/ })).toHaveAttribute("href", "/app/trade/BWRS")
    await expect(page.getByRole("link", { name: /Open explorer/ })).toHaveAttribute("href", "/explorer")
    await expect(page.getByRole("link", { name: /See what runs where/ })).toHaveAttribute("href", "/about")
    await expect(page.getByText("No open halt", { exact: false })).toBeVisible({ timeout: 15_000 })
    // <<< abel:home
  })
  step("tape", "Read the tape", async ({ page }) => {
    // action:   Open /explorer
    // expected: Prints listed with required fields
    // >>> abel:tape
    await page.goto(`${WEB}/explorer`)
    await expect(page.getByRole("heading", { name: /Explorer/ })).toBeVisible()
    const tape = await (await fetch(`${API}/tape?symbol=BWRS`)).json() as {
      prints: { signature: string; pair: string; pool: string; program: string; time: string }[]
    }
    const print = tape.prints[0]
    expect(print, "Public tape needs a real confirmed print").toBeTruthy()
    expect(print.pair).toBe("BWRS/USDC")
    expect(print.program).toBe(deployment.programId)
    expect(Date.parse(print.time)).not.toBeNaN()
    await expect(page.locator(`a[href*="${print.signature}"]`).first()).toBeVisible()
    await expect(page.locator(`a[href*="${print.pool}"]`).first()).toBeVisible()
    // <<< abel:tape
  })
  step("proof", "Verify on-chain", async ({ page }) => {
    // action:   Open /about and follow explorer links
    // expected: Devnet program id executable; recorded devnet signatures resolve on Solscan
    // >>> abel:proof
    await page.goto(`${WEB}/about`)
    await expect(page.getByRole("heading", { name: "Where it runs" })).toBeVisible()
    await expect(page.getByText("Mainnet is not deployed", { exact: true })).toBeVisible()
    const programLink = page.locator(`a[href*="/account/${deployment.programId}"]`).first()
    await expect(programLink).toBeVisible()
    expect(await programLink.getAttribute("href")).toContain("cluster=devnet")
    const signature = deployment.signatures.publicFreshSwap
    const txLink = page.locator(`a[href*="/tx/${signature}"]`).first()
    await expect(txLink).toBeVisible()
    expect(await txLink.getAttribute("href")).toContain("cluster=devnet")
    const rpc = async (method: string, params: unknown[]) => {
      const response = await fetch(deployment.rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
      expect(response.ok).toBe(true)
      return response.json() as Promise<{ result: { value: unknown } }>
    }
    const program = await rpc("getAccountInfo", [deployment.programId, { encoding: "base64", commitment: "confirmed" }])
    expect(program.result.value).toEqual(expect.objectContaining({ executable: true }))
    const tx = await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])
    expect(tx.result.value).toEqual([expect.objectContaining({ err: null, confirmationStatus: "finalized" })])
    // <<< abel:proof
  })
})

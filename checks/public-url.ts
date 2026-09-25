/** Circuit blk_web_deploy: live HTTPS routes, devnet data and responsive rendered pages. */
import assert from "node:assert/strict"
import { chromium } from "@playwright/test"
import { z } from "zod"
import { loadDeployment } from "../scripts/deploy/state.js"

const web = "https://bellwether.larinova.com"
const api = "https://bellwether-api.larinova.com"
const routes = ["/", "/explorer", "/explorer?date=2026-09-25", "/about",
  "/app/onboard", "/app/trade/BWRS", "/app/liquidity/BWRS"]
const widths = [375, 768, 1440]

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}`)
  return response.json()
}

async function main() {
  const deployment = loadDeployment("devnet")
  assert(deployment?.programId && deployment.signatures.publicFreshSwap, "missing devnet public proof")
  const config = z.object({ cluster: z.literal("devnet"), programId: z.string(),
    apiBaseUrl: z.literal(api), credentialApiUrl: z.literal(api), rpcUrl: z.literal(`${api}/rpc`) })
    .passthrough().parse(await json(`${web}/config.json`))
  assert.equal(config.programId, deployment.programId)
  z.object({ ok: z.literal(true), cluster: z.literal("devnet") }).passthrough().parse(await json(`${api}/health`))
  const venue = z.object({ cluster: z.literal("devnet"), program: z.string(),
    indexer: z.object({ stale: z.literal(false) }).passthrough() }).passthrough().parse(await json(`${api}/venue`))
  assert.equal(venue.program, deployment.programId)
  const tape = z.object({ prints: z.array(z.object({ signature: z.string() }).passthrough()) })
    .passthrough().parse(await json(`${api}/tape?date=2026-09-25`))
  assert(tape.prints.some((print) => print.signature === deployment.signatures.publicFreshSwap),
    "fresh-wallet signature missing from public API tape")

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    for (const route of [...routes, "/operator"]) {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 })
        const response = await page.goto(`${web}${route}`, { waitUntil: "domcontentloaded", timeout: 20_000 })
        assert.equal(response?.status(), 200, `${route} at ${width}px did not serve HTTP 200`)
        await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 15_000 })
        const body = await page.locator("body").innerText()
        assert(!/coming soon|\bTODO\b/i.test(body), `${route} at ${width}px contains unfinished content`)
        const layout = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }))
        assert(layout.scroll <= layout.viewport + 1, `${route} overflows horizontally at ${width}px: ${layout.scroll}px`)
        if (route.includes("date=2026-09-25")) {
          await page.locator(`a[href*="${deployment.signatures.publicFreshSwap}"]:visible`).first()
            .waitFor({ state: "visible", timeout: 15_000 })
        }
        process.stdout.write(`${route} ${width}px: HTTP 200, rendered, no overflow\n`)
      }
    }
  } finally {
    await browser.close()
  }
  process.stdout.write(`public URL acceptance passed: ${deployment.signatures.publicFreshSwap}\n`)
}

main().catch((error) => { process.stderr.write(`public URL acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })

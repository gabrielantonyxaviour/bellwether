import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

const WEB = "http://127.0.0.1:5195"
const LOCAL_API = "http://127.0.0.1:8787"
const root = process.cwd()
const devnet = JSON.parse(readFileSync("scripts/deploy/deployments/devnet.json", "utf8")) as {
  programId: string
  venue: string
  signatures: Record<string, string>
}
const fork = JSON.parse(readFileSync("scripts/fork/out/fork-scenario.json", "utf8")) as { signatures: Record<string, string> }
const webConfig = JSON.parse(readFileSync("scripts/deploy/deployments/devnet.web.json", "utf8")) as Record<string, string>
const lockDir = join(tmpdir(), "bellwether-public-5195.lock")
let web: ChildProcess | undefined
let ownsLock = false
let apiBase = LOCAL_API

async function lockPort() {
  const deadline = Date.now() + 120_000
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
        const pid = Number(readFileSync(join(lockDir, "pid"), "utf8"))
        try { process.kill(pid, 0) } catch { rmSync(lockDir, { recursive: true, force: true }) }
      }
    } catch { /* owner is creating or releasing the lock */ }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error("Another public-screen check kept port 5195 busy")
}

async function ready(url: string) {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch { /* server still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`Web did not become ready at ${url}`)
}

async function resolveApi(): Promise<string> {
  for (const base of [LOCAL_API, "https://bellwether-api.larinova.com"]) {
    try {
      const res = await fetch(`${base}/venue`)
      const body = await res.json() as { program?: string }
      if (res.ok && body.program === devnet.programId) return base
    } catch { /* try the next venue API */ }
  }
  throw new Error("Neither the local venue API nor bellwether-api.larinova.com is serving the devnet program")
}

test.describe.configure({ mode: "serial" })
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await lockPort()
  apiBase = await resolveApi()
  web = spawn("pnpm", ["-C", "web", "dev", "--host", "127.0.0.1", "--port", "5195", "--strictPort"], {
    cwd: root, stdio: "ignore", env: process.env, detached: true,
  })
  await ready(`${WEB}/config.json`)
})
test.afterAll(async () => {
  if (web?.pid) { try { process.kill(-web.pid, "SIGTERM") } catch { try { process.kill(web.pid, "SIGTERM") } catch { /* already exited */ } } }
  if (ownsLock) rmSync(lockDir, { recursive: true, force: true })
})

test("home, explorer and about render live devnet state", async ({ page }) => {
  test.setTimeout(180_000)
  const config = { ...webConfig, apiBaseUrl: apiBase, credentialApiUrl: apiBase }
  await page.route("**/config.json", (route) => route.fulfill({ json: config }))
  const notice = await (await fetch(`${apiBase}/notice/draft`)).json() as { chain: { program: { upgradeAuthority: string | null } } }
  const upgradeAuthority = notice.chain.program.upgradeAuthority
  expect(upgradeAuthority).toBeTruthy()

  let releaseVenue: () => void = () => {}
  const venueGate = new Promise<void>((resolve) => { releaseVenue = resolve })
  await page.route("**/venue", async (route) => { await venueGate; await route.continue() })
  await page.goto(WEB)
  await expect(page.getByText("Loading venue status")).toBeVisible()
  releaseVenue()
  await page.unroute("**/venue")

  await page.route("**/venue", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Indexer down", code: "unavailable" }),
  }))
  await page.goto(WEB)
  await expect(page.getByRole("alert")).toContainText("Venue status is unavailable", { timeout: 20_000 })
  await expect(page.getByRole("alert")).toContainText("Indexer down")
  await page.unroute("**/venue")

  await page.goto(WEB)
  await expect(page.getByRole("heading", { name: /Permissioned pools for tokenized US stocks/ })).toBeVisible()
  await expect(page.getByLabel("Live venue status").locator(`a[href*="${devnet.programId}"]`)).toBeVisible()
  await expect(page.getByLabel("Live venue status")).toContainText("devnet")
  await expect(page.getByRole("link", { name: "Explorer" }).first()).toBeVisible()
  await page.getByRole("tab", { name: /Swap/ }).click()
  await expect(page.getByRole("tabpanel")).toContainText("0.30%")

  const proofDate = "2026-09-25"
  const proofSignature = devnet.signatures.publicFreshSwap
  expect(proofSignature).toBeTruthy()
  await page.goto(`${WEB}/explorer?date=${proofDate}`)
  await expect(page.getByRole("heading", { name: "Explorer" })).toBeVisible()
  await expect(page.getByLabel("UTC date")).toHaveValue(proofDate)
  const proof = page.locator(`a[href*="${proofSignature}"]`)
  await expect(proof.first()).toBeVisible()
  expect(await proof.first().getAttribute("href")).toContain("cluster=devnet")
  await expect(page.getByRole("link", { name: "JSON" })).toHaveAttribute("href", new RegExp(`date=${proofDate}`))
  await page.getByLabel("UTC date").fill("2026-09-01")
  await expect(page.getByText("No prints for this date")).toBeVisible()

  await page.goto(`${WEB}/about`)
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible()
  await expect(page.getByText("Mainnet is not deployed")).toBeVisible()
  const devnetProgram = page.locator(`a[href*="${devnet.programId}"]:visible`).first()
  await expect(devnetProgram).toBeVisible()
  expect(await devnetProgram.getAttribute("href")).toContain("solscan.io")
  expect(await devnetProgram.getAttribute("href")).toContain("cluster=devnet")
  await expect(page.getByText("Who can pause, upgrade or override")).toBeVisible()
  await expect(page.locator(`a[href*="${upgradeAuthority}"]:visible`).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("local mainnet fork (Surfpool), not publicly resolvable").first()).toBeVisible()
  await expect(page.getByText(fork.signatures.fwdiSwap).first()).toBeVisible()
  await expect(page.getByRole("button", { name: new RegExp(`Copy fwdiSwap ${fork.signatures.fwdiSwap}`) })).toBeVisible()
  await expect(page.locator("a[href*='127.0.0.1']")).toHaveCount(0)
  await expect(page.locator("a[href*='cluster=custom']")).toHaveCount(0)
  await expect(page.locator(`a[href*='${fork.signatures.fwdiSwap}']`)).toHaveCount(0)
  await expect(page.getByRole("cell", { name: "Stand-in", exact: true }).first()).toBeVisible()

  await page.goto(`${WEB}/tape`)
  await expect(page).toHaveURL(/\/explorer$/)
  await page.goto(`${WEB}/proof`)
  await expect(page).toHaveURL(/\/about$/)

  mkdirSync("evidence", { recursive: true })
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const route of ["/", `/explorer?date=${proofDate}`, "/about"]) {
      await page.goto(`${WEB}${route}`)
      await expect(page.locator("main")).toBeVisible()
      if (route.includes("date=")) await expect(page.locator(`a[href*="${proofSignature}"]`).first()).toBeVisible()
      if (route === "/about") await expect(page.getByText("Mainnet is not deployed")).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
      expect(overflow, `${route} overflows at ${width}px`).toBe(true)
      if ((width === 375 && route === "/") || (width === 768 && route === "/explorer") || (width === 1440 && route === "/about")) {
        await page.screenshot({ path: `/tmp/bw-public-${route === "/" ? "home" : route.slice(1)}-${width}.png`, fullPage: true })
      }
    }
  }
  await page.screenshot({ path: "evidence/public-pages.png", fullPage: true })
})

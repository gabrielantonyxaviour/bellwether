/** Share one operator fork run between Abel checks of the same source tree. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const output = join(root, "test-results")
const paths = ["tests/e2e/operator-harness.ts", "tests/e2e/operator-flight.ts", "tests/e2e/operator.spec.ts", "web", "services", "scripts/deploy", "scripts/assets", "programs", "package.json", "pnpm-lock.yaml"]
type Verdict = { passed: boolean; summary: string; owner: number; finishedAt: string }

function sourceHash(): string {
  const hash = createHash("sha256")
  hash.update(execFileSync("git", ["ls-tree", "-r", "HEAD", "--", ...paths], { cwd: root, maxBuffer: 40_000_000 }))
  hash.update(execFileSync("git", ["diff", "--binary", "HEAD", "--", ...paths], { cwd: root, maxBuffer: 40_000_000 }))
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...paths], { cwd: root, encoding: "utf8" })
  for (const file of untracked.split("\n").filter(Boolean).sort()) {
    hash.update(file)
    hash.update(readFileSync(join(root, file)))
  }
  hash.update(process.env.SURFPOOL_DATASOURCE_RPC_URL ?? "")
  if (existsSync(join(root, "services/.env.devnet"))) hash.update(readFileSync(join(root, "services/.env.devnet")))
  return hash.digest("hex").slice(0, 24)
}

function live(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

export async function operatorSingleFlight(run: () => Promise<void>): Promise<void> {
  mkdirSync(output, { recursive: true })
  const key = sourceHash()
  const lock = join(output, `operator-${key}.lock`)
  const result = join(output, `operator-${key}.json`)
  const deadline = Date.now() + 540_000
  while (Date.now() < deadline) {
    if (existsSync(result)) {
      const verdict = JSON.parse(readFileSync(result, "utf8")) as Verdict
      if (!verdict.passed) throw new Error(`Operator fork run ${verdict.owner} failed: ${verdict.summary}`)
      return
    }
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, "pid"), String(process.pid))
      try {
        await run()
        const verdict: Verdict = { passed: true, summary: "operator workbench passed", owner: process.pid, finishedAt: new Date().toISOString() }
        const temporary = `${result}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify(verdict))
        renameSync(temporary, result)
        return
      } catch (error) {
        const summary = (error instanceof Error ? error.message : String(error))
          .replace(/https:\/\/[^\s/]+\.alchemy\.com\/v2\/[^\s)]+/g, "[redacted RPC]")
        const verdict: Verdict = { passed: false, summary, owner: process.pid, finishedAt: new Date().toISOString() }
        const temporary = `${result}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify(verdict))
        renameSync(temporary, result)
        throw error
      } finally {
        rmSync(lock, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > 5_000) {
        let owner = 0
        try { owner = Number(readFileSync(join(lock, "pid"), "utf8")) } catch { /* crashed before writing PID */ }
        if (!live(owner)) rmSync(lock, { recursive: true, force: true })
      }
    } catch { /* holder is creating or releasing its lock */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Operator fork result ${key} was not ready within nine minutes`)
}

/**
 * buildRehearsalReport(): what listing the real FWDI stock would involve, from live public data.
 * Read-only: it sends no transaction and writes nothing; `writeLatestReport` persists a result.
 */
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readActivity } from "./activity.js"
import { FWDI_MINT } from "./constants.js"
import { auditHalts } from "./halts.js"
import { discoverMarkets } from "./markets.js"
import { readFwdiMint } from "./mint.js"
import { createRpcClient, type RpcClient } from "./rpc.js"
import { RehearsalReportSchema, type RehearsalReport } from "./schema.js"
import { computeBudget } from "./volume.js"

export const LATEST_REPORT_PATH = join(dirname(fileURLToPath(import.meta.url)), "latest-report.json")

export interface BuildOptions {
  now?: Date
  rpc?: RpcClient
  rpcUrl?: string
  fetchImpl?: typeof fetch
}

export async function buildRehearsalReport(options: BuildOptions = {}): Promise<RehearsalReport> {
  const now = options.now ?? new Date()
  const rpc = options.rpc ?? createRpcClient({ url: options.rpcUrl, fetchImpl: options.fetchImpl })
  const mint = await readFwdiMint(rpc, FWDI_MINT)
  const markets = await discoverMarkets(rpc, { now, fetchImpl: options.fetchImpl })
  const activity = await readActivity(rpc, { now, markets })
  const budget = await computeBudget({ now, multiplier: mint.scaledUiAmount?.multiplier ?? 1, decimals: mint.decimals, fetchImpl: options.fetchImpl })
  const haltAudit = await auditHalts(rpc, { now, markets, activity, fetchImpl: options.fetchImpl })
  return RehearsalReportSchema.parse({
    schemaVersion: 1, generatedAt: now.toISOString(), symbol: "FWDI", mint, markets, activity, budget, haltAudit,
  })
}

export function writeLatestReport(report: RehearsalReport, path = LATEST_REPORT_PATH): string {
  writeFileSync(path, JSON.stringify(RehearsalReportSchema.parse(report), null, 2) + "\n")
  return path
}

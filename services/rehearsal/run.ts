/**
 * Refresh services/rehearsal/latest-report.json from live mainnet and public market data:
 *   npx tsx services/rehearsal/run.ts
 */
import { buildRehearsalReport, writeLatestReport } from "./report.js"

const report = await buildRehearsalReport()
const path = writeLatestReport(report)
const markets = report.markets.found.map((m) => `${m.programName} ${m.address} (FWDI vault ${m.fwdiVault.state})`).join("; ") || "none"
process.stdout.write([
  `wrote ${path} (${report.generatedAt})`,
  `authorities: freeze + permanent delegate ${report.mint.freezeAuthority}; mint/metadata/scaled-UI ${report.mint.mintAuthority}`,
  `markets: ${markets}`,
  `30-day activity: ${report.activity.signatures} txs (${report.activity.failed} failed), ${report.activity.trades} trades`,
  `budget: ${report.budget.dailyShareBudget?.toFixed(1)} shares/day = 2.5% × ${report.budget.month} ADV ${report.budget.averageDailyShareVolume?.toFixed(1)}`,
  `halt audit: ${report.haltAudit.note}`,
].join("\n") + "\n")

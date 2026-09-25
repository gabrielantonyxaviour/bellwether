/**
 * Serve the venue API on Node:
 *   BELLWETHER_PROGRAM_ID=<venue program> npx tsx services/api/main.ts
 * Reads the indexer's SQLite file (BELLWETHER_TAPE_DB); environment contract in
 * services/indexer/config.ts.
 */
import { serve } from "@hono/node-server"
import { readFileSync } from "node:fs"
import { isAddress } from "@solana/kit"
import { noticeDraftFor } from "../notice/index.js"
import { buildRehearsalReport, LATEST_REPORT_PATH } from "../rehearsal/report.js"
import { RehearsalReportSchema } from "../rehearsal/schema.js"
import { loadTapeConfig } from "../indexer/config.js"
import { openNodeSqlite } from "../indexer/node-sqlite.js"
import { SqlTapeStore } from "../indexer/sql-store.js"
import { createApp } from "./app.js"
import { fileHaltSource } from "./halts-file.js"

async function main() {
  const config = loadTapeConfig()
  const driver = openNodeSqlite(config.dbPath)
  const store = await SqlTapeStore.open(driver)
  const app = createApp({
    store,
    halts: fileHaltSource(config.haltLedgerPath),
    venue: { programId: config.programId, cluster: config.cluster, retentionDays: config.retentionDays },
    operatorToken: process.env.CREDENTIAL_OPERATOR_TOKEN ?? null,
    noticeDraft: process.env.BELLWETHER_VENUE && isAddress(process.env.BELLWETHER_VENUE)
      ? () => noticeDraftFor({ cluster: config.cluster, rpcUrl: config.rpcUrl, programId: config.programId, venue: process.env.BELLWETHER_VENUE })
      : undefined,
    rehearsalReport: async (refresh) => refresh
      ? buildRehearsalReport()
      : RehearsalReportSchema.parse(JSON.parse(readFileSync(LATEST_REPORT_PATH, "utf8"))),
  })
  const server = serve({ fetch: app.fetch, hostname: config.apiHost, port: config.apiPort }, (info) => {
    process.stdout.write(`[api] listening on http://${config.apiHost}:${info.port} db ${config.dbPath} halts ${config.haltLedgerPath}\n`)
  })
  const shutdown = () => {
    server.close()
    driver.close()
    process.exit(0)
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

main().catch((error) => {
  process.stderr.write(`api failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})

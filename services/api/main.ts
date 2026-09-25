/**
 * Serve the venue API on Node:
 *   BELLWETHER_PROGRAM_ID=<venue program> npx tsx services/api/main.ts
 * Reads the indexer's SQLite file (BELLWETHER_TAPE_DB); environment contract in
 * services/indexer/config.ts.
 */
import { serve } from "@hono/node-server"
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

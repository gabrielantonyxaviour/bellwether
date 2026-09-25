/**
 * Run the tape indexer:
 *   BELLWETHER_PROGRAM_ID=<venue program> npx tsx services/indexer/main.ts
 * Environment contract: services/indexer/config.ts. Stops cleanly on SIGINT / SIGTERM.
 */
import { loadTapeConfig } from "./config.js"
import { TapeIndexer } from "./indexer.js"
import { openNodeSqlite } from "./node-sqlite.js"
import { createIndexerRpc } from "./rpc.js"
import { SqlTapeStore } from "./sql-store.js"

const log = (line: string) => process.stdout.write(`[indexer ${new Date().toISOString()}] ${line}\n`)

async function main() {
  const config = loadTapeConfig()
  const driver = openNodeSqlite(config.dbPath)
  const store = await SqlTapeStore.open(driver)
  const indexer = new TapeIndexer({
    store,
    rpc: createIndexerRpc(config.rpcUrl, { fallbackUrl: process.env.RPC_FALLBACK_URLS?.split(",")[0]?.trim() }),
    programId: config.programId,
    poolAccounts: config.poolAccounts,
    wsUrl: config.wsUrl,
    pollMs: config.pollMs,
    poolRefreshMs: config.poolRefreshMs,
    retentionDays: config.retentionDays,
    backfillMax: config.backfillMax,
    log,
  })
  log(`program ${config.programId} rpc host ${new URL(config.rpcUrl).host} ws ${config.wsUrl ? new URL(config.wsUrl).host : "off"} db ${config.dbPath} retention ${config.retentionDays}d`)
  indexer.start()
  const shutdown = async () => {
    await indexer.stop()
    driver.close()
    process.exit(0)
  }
  process.once("SIGINT", () => void shutdown())
  process.once("SIGTERM", () => void shutdown())
}

main().catch((error) => {
  process.stderr.write(`indexer failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})

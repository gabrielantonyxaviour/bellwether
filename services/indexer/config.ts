/**
 * The indexer's and API's environment contract, validated once at startup.
 *
 *   BELLWETHER_PROGRAM_ID           venue program address (required)
 *   BELLWETHER_CLUSTER              mainnet | fork | devnet (default mainnet): picks default URLs from config/clusters.ts
 *   BELLWETHER_RPC_URL              JSON-RPC URL (overrides the cluster default)
 *   BELLWETHER_WS_URL               websocket URL for logsSubscribe ("off" to poll only; default derived from the RPC URL)
 *   BELLWETHER_TAPE_DB              SQLite file (default services/indexer/.data/tape.sqlite)
 *   BELLWETHER_TAPE_RETENTION_DAYS  days of prints kept and served, ≥ 30 (default 35)
 *   BELLWETHER_TAPE_POLL_MS         signature backfill interval, the websocket's safety net (default 15000)
 *   BELLWETHER_TAPE_POOL_REFRESH_MS pool-account snapshot interval (default 60000)
 *   BELLWETHER_TAPE_BACKFILL_MAX    most signatures walked per backfill round (default 5000)
 *   BELLWETHER_API_HOST / _PORT     API bind address (default 127.0.0.1:8787)
 *   BELLWETHER_HALT_LEDGER          relay halt ledger file (default services/relay/data/relay.json, the relay's state file)
 */
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { clusterConfig, CLUSTERS, wsUrlFor } from "../../config/clusters.js"

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 address")
const int = (min: number, fallback: number) => z.coerce.number().int().min(min).default(fallback)
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v)

const EnvSchema = z.object({
  BELLWETHER_PROGRAM_ID: base58,
  BELLWETHER_POOL_ACCOUNTS: z.preprocess(blankToUndefined, z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}(,[1-9A-HJ-NP-Za-km-z]{32,44})*$/).optional()),
  BELLWETHER_CLUSTER: z.enum(CLUSTERS).default("mainnet"),
  BELLWETHER_RPC_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  BELLWETHER_WS_URL: z.preprocess(blankToUndefined, z.union([z.literal("off"), z.string().regex(/^wss?:\/\//, "must be ws:// or wss://")]).optional()),
  BELLWETHER_TAPE_DB: z.preprocess(blankToUndefined, z.string().optional()),
  BELLWETHER_TAPE_RETENTION_DAYS: int(30, 35),
  BELLWETHER_TAPE_POLL_MS: int(1_000, 15_000),
  BELLWETHER_TAPE_POOL_REFRESH_MS: int(1_000, 60_000),
  BELLWETHER_TAPE_BACKFILL_MAX: int(1, 5_000),
  BELLWETHER_API_HOST: z.string().default("127.0.0.1"),
  BELLWETHER_API_PORT: int(1, 8787).pipe(z.number().max(65_535)),
  BELLWETHER_HALT_LEDGER: z.preprocess(blankToUndefined, z.string().optional()),
})

export interface TapeConfig {
  programId: string
  poolAccounts: string[] | undefined
  cluster: (typeof CLUSTERS)[number]
  rpcUrl: string
  wsUrl: string | undefined
  dbPath: string
  retentionDays: number
  pollMs: number
  poolRefreshMs: number
  backfillMax: number
  apiHost: string
  apiPort: number
  haltLedgerPath: string
}

export function loadTapeConfig(env: NodeJS.ProcessEnv = process.env): TapeConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`invalid tape environment — ${issues}`)
  }
  const e = parsed.data
  const cluster = clusterConfig(e.BELLWETHER_CLUSTER, env)
  const rpcUrl = e.BELLWETHER_RPC_URL ?? cluster.rpcUrl
  const local = ["127.0.0.1", "localhost"].includes(new URL(rpcUrl).hostname)
  const wsUrl = e.BELLWETHER_WS_URL === "off" ? undefined : (e.BELLWETHER_WS_URL ?? wsUrlFor(rpcUrl, local))
  return {
    programId: e.BELLWETHER_PROGRAM_ID,
    poolAccounts: e.BELLWETHER_POOL_ACCOUNTS?.split(","),
    cluster: e.BELLWETHER_CLUSTER,
    rpcUrl,
    wsUrl,
    dbPath: resolve(REPO_ROOT, e.BELLWETHER_TAPE_DB ?? join("services", "indexer", ".data", "tape.sqlite")),
    retentionDays: e.BELLWETHER_TAPE_RETENTION_DAYS,
    pollMs: e.BELLWETHER_TAPE_POLL_MS,
    poolRefreshMs: e.BELLWETHER_TAPE_POOL_REFRESH_MS,
    backfillMax: e.BELLWETHER_TAPE_BACKFILL_MAX,
    apiHost: e.BELLWETHER_API_HOST,
    apiPort: e.BELLWETHER_API_PORT,
    haltLedgerPath: resolve(REPO_ROOT, e.BELLWETHER_HALT_LEDGER ?? join("services", "relay", "data", "relay.json")),
  }
}

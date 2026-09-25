/**
 * Caps job entry point — run daily, about 30 minutes before the venue's trade-date cutoff
 * (the default 08:00 UTC cutoff → cron `30 7 * * *`), weekends included (they are no-ops).
 *
 *   npx tsx services/caps/run.ts [--dry-run]
 *
 * Env (validated here):
 *   CAPS_RPC_URL                  RPC of the venue's cluster (required)
 *   CAPS_PROGRAM_ID               venue program id (required)
 *   CAPS_VENUE / CAPS_VENUE_ADMIN the VenueConfig PDA, or the admin key it is derived from (one required)
 *   CAPS_DATA_AUTHORITY_KEYPAIR   path to (or JSON of) the venue's data-authority keypair; required unless --dry-run
 *   CAPS_SYMBOLS                  optional comma list of on-chain tickers (default: every registered symbol)
 *   CAPS_PROVENANCE_DIR           default services/caps/provenance
 *   CAPS_LEAD_MINUTES             default 240: a run this close to a trade-date start prepares that trade date
 *   CAPS_NOW                      optional ISO time, for a backfill or rehearsal
 *   CAPS_ALLOW_MAINNET=1          required before sending to a non-local mainnet RPC
 * Exit: 0 every symbol complete (sent or unchanged) · 2 a symbol partial (withheld) or its send failed · 1 error.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { address } from "@solana/kit"
import { z } from "zod"
import { createCapsChain, loadKeypair } from "./chain.js"
import { runCapsJob } from "./job.js"
import { venuePda } from "./venue.js"

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 address")
const optional = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === "" ? undefined : v), t.optional())

const envSchema = z.object({
  CAPS_RPC_URL: z.string().url(),
  CAPS_PROGRAM_ID: base58,
  CAPS_VENUE: optional(base58),
  CAPS_VENUE_ADMIN: optional(base58),
  CAPS_DATA_AUTHORITY_KEYPAIR: optional(z.string()),
  CAPS_SYMBOLS: optional(z.string().regex(/^[A-Za-z0-9.]{1,8}(,[A-Za-z0-9.]{1,8})*$/)),
  CAPS_PROVENANCE_DIR: optional(z.string()),
  CAPS_LEAD_MINUTES: optional(z.coerce.number().int().min(0).max(1440)),
  CAPS_NOW: optional(z.string().datetime()),
  CAPS_ALLOW_MAINNET: optional(z.enum(["0", "1"])),
}).refine((e) => e.CAPS_VENUE || e.CAPS_VENUE_ADMIN, { message: "set CAPS_VENUE or CAPS_VENUE_ADMIN" })

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) throw new Error(`invalid caps job env: ${parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ")}`)
  const env = parsed.data
  if (!dryRun && !env.CAPS_DATA_AUTHORITY_KEYPAIR) throw new Error("CAPS_DATA_AUTHORITY_KEYPAIR is required (or pass --dry-run)")

  const rpcUrl = new URL(env.CAPS_RPC_URL)
  const local = ["127.0.0.1", "localhost"].includes(rpcUrl.hostname)
  const { rpc, send } = createCapsChain(env.CAPS_RPC_URL)
  if (!dryRun && !local && env.CAPS_ALLOW_MAINNET !== "1" && (await rpc.getGenesisHash().send()) === MAINNET_GENESIS) {
    throw new Error("CAPS_RPC_URL is mainnet; set CAPS_ALLOW_MAINNET=1 to send set_cap there")
  }
  const programId = address(env.CAPS_PROGRAM_ID)
  const venue = env.CAPS_VENUE ? address(env.CAPS_VENUE) : await venuePda(programId, address(env.CAPS_VENUE_ADMIN!))
  const dataAuthority = dryRun ? null : await loadKeypair(env.CAPS_DATA_AUTHORITY_KEYPAIR!)
  const provenanceDir = env.CAPS_PROVENANCE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "provenance")

  const run = await runCapsJob({
    rpc, send, programId, venue, dataAuthority, provenanceDir, rpcHost: rpcUrl.host,
    now: env.CAPS_NOW ? new Date(env.CAPS_NOW) : undefined,
    tickers: env.CAPS_SYMBOLS?.split(","),
    leadSeconds: env.CAPS_LEAD_MINUTES === undefined ? undefined : env.CAPS_LEAD_MINUTES * 60,
  })
  process.stdout.write(`caps ${run.tradeDate} (volume ${run.month}) venue ${run.venue}${dryRun ? " [dry run]" : ""}\n`)
  for (const s of run.symbols) {
    const cap = s.cap ? `${s.cap.wholeShares.toLocaleString("en-US")} shares/day (${s.cap.units} units)` : "no cap"
    const tier = s.tier.tier ? `Tier ${s.tier.tier}${s.tier.inferred ? " inferred" : ""}` : "tier unknown"
    process.stdout.write(`  ${s.ticker.padEnd(8)} ${s.status.padEnd(8)} ${s.onchain.action.padEnd(9)} ${tier} · ${cap}${s.missing.length ? ` · missing ${s.missing.join(", ")}` : ""}${s.onchain.error ? ` · ${s.onchain.error}` : ""}\n`)
  }
  process.stdout.write(`provenance: ${provenanceDir}\n`)
  const incomplete = run.summary.partial + run.summary.failed
  process.exit(incomplete > 0 ? 2 : 0)
}

main().catch((error) => {
  process.stderr.write(`caps job failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})

/**
 * Provenance records for the caps job, stored as JSON.
 *
 *   <dir>/runs/<ranAt>.json     every run, complete or partial
 *   <dir>/latest-run.json       the most recent run
 *   <dir>/symbols/<TICKER>.json the run behind the value now on chain (written when a run sends
 *                               set_cap or confirms the on-chain value unchanged; a partial run
 *                               never replaces it)
 * Unit amounts are decimal strings (u64 does not fit a JSON number).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

const u64 = z.string().regex(/^\d+$/)
const source = z.object({ name: z.string(), url: z.string().url(), fetchedAt: z.string(), days: z.number().int(), totalShares: z.number(), adv: z.number(), firstDate: z.string(), lastDate: z.string() })

export const symbolProvenanceSchema = z.object({
  ticker: z.string(),
  symbolAccount: z.string(),
  mint: z.object({ address: z.string(), decimals: z.number().int(), multiplier: z.number(), scaledUi: z.boolean(), tokenProgram: z.string() }).nullable(),
  volumeSymbol: z.string(),
  mapping: z.string().nullable(),
  tradeDate: z.string(),
  month: z.string(),
  status: z.enum(["complete", "partial"]),
  missing: z.array(z.enum(["nasdaq", "yahoo", "tier", "mint"])),
  tier: z.object({
    tier: z.union([z.literal(1), z.literal(2)]).nullable(), percent: z.number().nullable(), basis: z.enum(["ishares", "override", "none"]),
    inferred: z.boolean(), reason: z.string(), onchainTier: z.number().int().nullable(), matchesOnchain: z.boolean().nullable(),
    lists: z.array(z.object({ key: z.string(), index: z.string(), url: z.string(), ok: z.boolean(), asOf: z.string().nullable(), count: z.number().nullable(), fetchedAt: z.string().nullable(), error: z.string().nullable() })),
  }),
  volume: z.object({
    symbol: z.string(), month: z.string(), from: z.string(), to: z.string(), primary: z.enum(["nasdaq", "yahoo"]).nullable(),
    nasdaq: source.nullable(), yahoo: source.nullable(), missing: z.array(z.enum(["nasdaq", "yahoo"])),
    days: z.array(z.object({ date: z.string(), nasdaq: z.number().nullable(), yahoo: z.number().nullable() })),
    crossCheck: z.object({ disagreementPct: z.number(), flagged: z.boolean(), thresholdPct: z.number() }).nullable(),
    sources: z.array(z.object({ source: z.enum(["nasdaq", "yahoo"]), name: z.string(), url: z.string().url(), fetchedAt: z.string() })),
  }),
  adv: z.object({ shares: z.number(), totalShares: z.number(), days: z.number().int() }).nullable(),
  cap: z.object({
    shares: z.number(), wholeShares: z.number().int(), units: u64, advUnits: u64, decimals: z.number().int(),
    multiplier: z.object({ value: z.number(), num: z.number().int(), den: z.number().int() }),
  }).nullable(),
  onchain: z.object({
    before: z.object({ capUnits: u64, advUnits: u64, multNum: z.number().int(), multDen: z.number().int(), tier: z.number().int() }).nullable(),
    action: z.enum(["sent", "unchanged", "withheld", "dry-run", "failed"]),
    signature: z.string().nullable(),
    error: z.string().nullable(),
  }),
  errors: z.array(z.string()),
})

export const provenanceRunSchema = z.object({
  schemaVersion: z.literal(1),
  job: z.literal("caps-data"),
  ranAt: z.string(),
  now: z.string(),
  tradeDate: z.string(),
  month: z.string(),
  programId: z.string(),
  venue: z.string(),
  dataAuthority: z.string(),
  rpcHost: z.string(),
  summary: z.object({ complete: z.number().int(), partial: z.number().int(), sent: z.number().int(), unchanged: z.number().int(), withheld: z.number().int(), failed: z.number().int() }),
  symbols: z.array(symbolProvenanceSchema),
})

export type SymbolProvenance = z.infer<typeof symbolProvenanceSchema>
export type ProvenanceRun = z.infer<typeof provenanceRunSchema>

function writeJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_")

/** Validates the run against the schema, then writes the three views. Returns the run file path. */
export function writeProvenance(dir: string, run: ProvenanceRun): string {
  const parsed = provenanceRunSchema.parse(run)
  mkdirSync(join(dir, "runs"), { recursive: true })
  mkdirSync(join(dir, "symbols"), { recursive: true })
  const file = join(dir, "runs", `${safeName(parsed.ranAt)}.json`)
  writeJson(file, parsed)
  writeJson(join(dir, "latest-run.json"), parsed)
  for (const s of parsed.symbols) {
    if (s.onchain.action === "sent" || s.onchain.action === "unchanged") {
      writeJson(join(dir, "symbols", `${safeName(s.ticker)}.json`), { ...s, run: { ranAt: parsed.ranAt, tradeDate: parsed.tradeDate, programId: parsed.programId, venue: parsed.venue } })
    }
  }
  return file
}

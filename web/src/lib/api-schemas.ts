/**
 * zod schemas for every service response the web reads. Shapes follow the services' own
 * source: services/api/app.ts + present.ts (venue API), services/credential/app.ts +
 * admission.ts (credential issuer), services/rehearsal/schema.ts (FWDI report). Objects are
 * loose so a service adding a field never breaks a screen. Amounts are exact decimal strings.
 */
import { z } from "zod"

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, "not a decimal string")
const iso = z.string()
const address = z.string()

// ── Venue API (services/api) ───────────────────────────────────────────────────────────

export const VolumeViewSchema = z.looseObject({
  window: z.literal("rolling_24h"),
  from: iso,
  to: iso,
  shares: decimal,
  usd: decimal,
  trades: z.number().int(),
})

export const PoolSizeSchema = z.looseObject({
  date: z.string(),
  as_of: iso,
  slot: z.number().int(),
  source: z.enum(["print", "account"]),
  stock_tokens: decimal,
  usdc: decimal,
  usd: decimal,
})

export const PairSchema = z.looseObject({
  pair: z.string(),
  symbol: z.string(),
  paired_symbol: z.string(),
  pool: address,
  program: address,
  stock_mint: address,
  usdc_mint: address,
  stock_decimals: z.number().int(),
  usdc_decimals: z.number().int(),
  fee_bps: z.number().int().nullable(),
  halted: z.boolean().nullable(),
  active: z.boolean().nullable(),
  last_price_usd: decimal.nullable(),
  last_trade_at: iso.nullable(),
  rolling_24h: VolumeViewSchema,
  eod_pool_size: PoolSizeSchema.nullable(),
})
export type Pair = z.infer<typeof PairSchema>

export const PrintSchema = z.looseObject({
  signature: z.string(),
  event_index: z.number().int(),
  slot: z.number().int(),
  pair: z.string(),
  symbol: z.string(),
  paired_symbol: z.string(),
  price_usd: decimal,
  size_shares: decimal,
  size_tokens: decimal,
  size_usdc: decimal,
  notional_usd: decimal,
  time: iso,
  unix_time: z.number().int(),
  published_at: iso,
  direction: z.enum(["buy", "sell"]),
  asset_in: z.string(),
  asset_out: z.string(),
  pool: address,
  program: address,
  stock_mint: address,
  usdc_mint: address,
  fee: z.looseObject({ asset: z.string(), amount: decimal }),
  trade_date: z.string(),
  daily_volume: VolumeViewSchema,
  pool_after: z.looseObject({ stock_tokens: decimal, usdc: decimal }),
  eod_pool_size: PoolSizeSchema.nullable(),
})
export type Print = z.infer<typeof PrintSchema>

export const TapeResponseSchema = z.looseObject({
  date: z.string(),
  filters: z.looseObject({ symbol: z.string().nullable(), side: z.enum(["buy", "sell"]).nullable() }),
  generated_at: iso,
  usd_method: z.unknown(),
  retention_days: z.number().int(),
  count: z.number().int(),
  prints: z.array(PrintSchema),
  pairs: z.array(PairSchema),
})
export type TapeResponse = z.infer<typeof TapeResponseSchema>

export const SymbolsResponseSchema = z.looseObject({ generated_at: iso, symbols: z.array(PairSchema) })
export type SymbolsResponse = z.infer<typeof SymbolsResponseSchema>

export const VenueResponseSchema = z.looseObject({
  name: z.string(),
  program: address,
  cluster: z.string(),
  generated_at: iso,
  usd_method: z.unknown(),
  retention_days: z.number().int(),
  transparency: z.looseObject({ free: z.boolean(), format: z.string(), publication_target: z.string(), time_zone: z.string() }),
  pools: z.array(PairSchema.extend({ contract_address: address })),
  indexer: z
    .looseObject({
      ws: z.unknown(),
      last_slot: z.number().nullable(),
      last_backfill_at: iso.nullable(),
      last_pool_refresh_at: iso.nullable(),
      prints_indexed_since_start: z.number(),
      last_error: z.string().nullable(),
      updated_at: iso,
      stale: z.boolean(),
    })
    .nullable(),
})
export type VenueResponse = z.infer<typeof VenueResponseSchema>

export const HaltEntrySchema = z.looseObject({
  symbol: z.string(),
  reason_code: z.string().nullable(),
  nasdaq_halt_time: iso.nullable(),
  feed_seen_at: iso.nullable(),
  tx_confirmed_at: iso.nullable(),
  resumed_at: iso.nullable(),
  tx_signature: z.string().nullable(),
})
export type HaltEntry = z.infer<typeof HaltEntrySchema>

export const HaltsResponseSchema = z.looseObject({
  generated_at: iso,
  source: z.string().nullable(),
  skipped: z.number().int(),
  halts: z.array(HaltEntrySchema),
})
export type HaltsResponse = z.infer<typeof HaltsResponseSchema>

// ── Credential issuer (services/credential) ────────────────────────────────────────────

export const CREDENTIAL_LABEL = "test admission, not KYC"

const CredentialRefSchema = z.looseObject({ kind: z.enum(["sas", "membership"]), address })
const StockAccountSchema = z.looseObject({ address, state: z.enum(["missing", "frozen", "thawed"]) })

export const AdmitResponseSchema = z.looseObject({
  label: z.string(),
  wallet: address,
  status: z.literal("admitted"),
  alreadyAdmitted: z.boolean(),
  expiresAt: iso,
  expiresAtUnix: z.number(),
  credential: CredentialRefSchema,
  stockAccount: StockAccountSchema,
  signature: z.string().nullable(),
})
export type AdmitResponse = z.infer<typeof AdmitResponseSchema>

export const RevokeResponseSchema = z.looseObject({
  label: z.string(),
  wallet: address,
  status: z.literal("revoked"),
  signature: z.string(),
})
export type RevokeResponse = z.infer<typeof RevokeResponseSchema>

export const CredentialStatusSchema = z.looseObject({
  label: z.string(),
  wallet: address,
  cluster: z.string(),
  gate: z.enum(["sas", "membership"]),
  status: z.enum(["admitted", "expired", "revoked", "not_admitted"]),
  admitted: z.boolean(),
  expiresAt: iso.nullable(),
  expiresAtUnix: z.number().nullable(),
  credential: CredentialRefSchema,
  stockAccount: StockAccountSchema,
  lastScreening: z.looseObject({ at: iso, event: z.string(), result: z.string().optional() }).nullable(),
  admissionSignature: z.string().nullable(),
})
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>

export const CredentialHealthSchema = z.looseObject({
  ok: z.literal(true),
  cluster: z.string(),
  gate: z.enum(["sas", "membership"]),
  credential: z.looseObject({
    program: address.optional(),
    credential: address.optional(),
    schema: address.optional(),
  }),
  sdn: z.looseObject({
    source: z.url(),
    publishDate: z.string().nullable(),
    fetchedAt: iso,
    stale: z.boolean(),
    officialAddresses: z.number().int().nonnegative(),
    fixtureAddresses: z.number().int().nonnegative(),
  }).nullable(),
})
export type CredentialHealth = z.infer<typeof CredentialHealthSchema>

export const ScreeningLogSchema = z.looseObject({
  label: z.string(),
  entries: z.array(
    z.looseObject({
      at: iso,
      wallet: z.string(),
      event: z.enum(["screened", "admitted", "revoked", "error"]),
      result: z.enum(["clear", "sanctioned", "unavailable"]).optional(),
    }),
  ),
})
export type ScreeningLog = z.infer<typeof ScreeningLogSchema>

// ── Placeholders: notice builder + FWDI rehearsal (no HTTP routes yet) ──────────────────

export const NoticeItemSchema = z.looseObject({
  letter: z.string(),
  title: z.string(),
  source: z.enum(["chain", "config", "operator-input"]),
  requirement: z.string(),
  value: z.unknown().optional(),
})
export const NoticeDraftSchema = z.looseObject({
  items: z.array(NoticeItemSchema),
  published_at: iso.nullable().optional(),
})
export type NoticeDraft = z.infer<typeof NoticeDraftSchema>

/** Top level of services/rehearsal/schema.ts RehearsalReportSchema; sections kept loose. */
export const RehearsalReportSchema = z.looseObject({
  schemaVersion: z.literal(1),
  generatedAt: iso,
  symbol: z.literal("FWDI"),
  mint: z.looseObject({ address, symbol: z.string() }),
  markets: z.unknown(),
  activity: z.unknown(),
  budget: z.unknown(),
  haltAudit: z.unknown(),
})
export type RehearsalReport = z.infer<typeof RehearsalReportSchema>

export const ApiErrorBodySchema = z.object({ error: z.string(), code: z.string().optional() })

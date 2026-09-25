/**
 * The FWDI launch-rehearsal report: a typed JSON document the API can serve as-is.
 * Every figure carries the source it came from and when it was fetched.
 */
import { z } from "zod"

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
const iso = z.string().datetime()

export const SourceSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  method: z.string().optional(),
  fetchedAt: iso,
  slot: z.number().int().optional(),
  note: z.string().optional(),
})
export type Source = z.infer<typeof SourceSchema>

export const AccountStateSchema = z.enum(["uninitialized", "initialized", "frozen"])

export const MintFactsSchema = z.object({
  address, symbol: z.string(), name: z.string(), tokenProgram: address, decimals: z.number().int(),
  supplyRaw: z.string(), supplyShares: z.number(), space: z.number().int(),
  mintAuthority: address.nullable(), freezeAuthority: address.nullable(), permanentDelegate: address.nullable(),
  defaultAccountState: AccountStateSchema.nullable(),
  metadataPointer: z.object({ authority: address.nullable(), metadataAddress: address.nullable() }).nullable(),
  scaledUiAmount: z.object({
    authority: address.nullable(), multiplier: z.number(), newMultiplier: z.number(), newMultiplierEffectiveTimestamp: z.number(),
  }).nullable(),
  metadata: z.object({ updateAuthority: address.nullable(), name: z.string(), symbol: z.string(), uri: z.string() }).nullable(),
  extensions: z.array(z.string()),
  hasPausable: z.boolean(),
  hasTransferHook: z.boolean(),
  authorityMap: z.array(z.object({ address, roles: z.array(z.string()), powers: z.array(z.string()) })),
  source: SourceSchema,
})
export type MintFacts = z.infer<typeof MintFactsSchema>

export const TokenAccountSchema = z.object({
  account: address, owner: address, state: AccountStateSchema, amountRaw: z.string(), shares: z.number(),
})
export type TokenAccountFact = z.infer<typeof TokenAccountSchema>

export const VaultSchema = z.object({
  address, mint: address, state: AccountStateSchema.nullable(), amountRaw: z.string().nullable(), exists: z.boolean(),
})

export const MarketSchema = z.object({
  address, program: address, programName: z.string(), kind: z.enum(["clob", "amm", "clmm", "dlmm"]),
  baseMint: address, quoteMint: address, fwdiSide: z.enum(["base", "quote"]),
  fwdiVault: VaultSchema.extend({ inEnumeratedAccounts: z.boolean() }),
  otherVault: VaultSchema,
  canTrade: z.boolean(),
  blocker: z.string().nullable(),
  discoveredBy: z.array(z.string()),
  activity: z.object({
    signatures: z.number().int(), capped: z.boolean(), firstAt: iso.nullable(), lastAt: iso.nullable(), last30Days: z.number().int(),
  }),
  source: SourceSchema,
})
export type Market = z.infer<typeof MarketSchema>

export const MarketsSchema = z.object({
  found: z.array(MarketSchema),
  tokenAccounts: z.object({
    total: z.number().int(), frozen: z.number().int(), initialized: z.number().int(),
    funded: z.array(TokenAccountSchema.extend({ ownerProgram: address.nullable(), ownerLabel: z.string() })),
    ownerPrograms: z.record(z.string(), z.number().int()),
    selfOwned: z.array(TokenAccountSchema),
    /** Vault-like FWDI accounts (self-owned) that no scanned DEX market claims. */
    unattributedVaults: z.array(address),
    source: SourceSchema,
  }),
  scans: z.array(z.object({
    program: address, programName: z.string(), offset: z.number().int(), field: z.string(),
    status: z.enum(["ok", "error"]), matches: z.array(address), error: z.string().optional(),
  })),
  largestAccounts: z.object({ status: z.enum(["ok", "rate_limited", "error"]), accounts: z.array(address), note: z.string().optional() }),
  jupiter: z.object({
    status: z.enum(["ok", "unavailable"]), firstPool: address.nullable(), firstPoolCreatedAt: z.string().nullable(),
    listedPoolFound: z.boolean().nullable(), note: z.string().optional(), source: SourceSchema.nullable(),
  }),
  sources: z.array(SourceSchema).min(1),
})

export const ActivityEntrySchema = z.object({
  signature: z.string(), at: iso.nullable(), slot: z.number().int(), ok: z.boolean(),
  categories: z.array(z.string()), programs: z.array(address),
})

export const ActivitySchema = z.object({
  windowDays: z.number().int(), from: iso, to: iso,
  addresses: z.array(z.object({ address, role: z.string(), signaturesInWindow: z.number().int(), pages: z.number().int() })),
  signatures: z.number().int(), succeeded: z.number().int(), failed: z.number().int(),
  trades: z.number().int(),
  categories: z.record(z.string(), z.number().int()),
  entries: z.array(ActivityEntrySchema),
  truncated: z.boolean(),
  sources: z.array(SourceSchema).min(1),
})

export const DailyVolumeSchema = z.object({ date: z.string(), nasdaq: z.number().nullable(), yahoo: z.number().nullable() })

export const BudgetSchema = z.object({
  status: z.enum(["complete", "partial", "unavailable"]),
  symbol: z.string(), tier: z.literal("Tier 2"), tierLabel: z.string(), tierPercent: z.number(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  primary: z.enum(["nasdaq", "yahoo"]).nullable(),
  tradingDays: z.number().int().nullable(),
  averageDailyShareVolume: z.number().nullable(),
  dailyShareBudget: z.number().nullable(),
  dailyShareBudgetRaw: z.string().nullable(),
  multiplierUsed: z.number(),
  crossCheck: z.object({
    nasdaqAdv: z.number().nullable(), nasdaqDays: z.number().int().nullable(),
    yahooAdv: z.number().nullable(), yahooDays: z.number().int().nullable(),
    disagreementPct: z.number().nullable(), flagged: z.boolean().nullable(), thresholdPct: z.number(),
  }),
  daily: z.array(DailyVolumeSchema),
  sources: z.array(SourceSchema).min(1),
  errors: z.array(z.string()),
})

export const HaltSchema = z.object({
  symbol: z.string(), reason: z.string(), haltAt: iso, resumedAt: iso.nullable(), exchange: z.string().nullable(),
  date: z.string(), source: z.enum(["nyse-history", "nasdaqtrader-rss"]),
})

export const HaltAuditSchema = z.object({
  status: z.enum(["complete", "partial", "unavailable"]),
  symbols: z.array(z.string()),
  events: z.array(z.object({ signature: z.string(), at: iso, kind: z.string() })),
  history: z.object({
    from: z.string(), to: z.string(),
    perSymbol: z.array(z.object({ symbol: z.string(), ok: z.boolean(), halts: z.number().int().nullable(), error: z.string().optional() })),
  }),
  halts: z.array(HaltSchema),
  latestHaltAt: iso.nullable(),
  crossCheck: z.object({
    status: z.enum(["agrees", "disagrees", "unavailable"]),
    datesQueried: z.array(z.object({ date: z.string(), ok: z.boolean(), items: z.number().int().nullable(), fwdiHalts: z.number().int().nullable(), error: z.string().optional() })),
    note: z.string(),
  }),
  control: z.object({ date: z.string(), expected: z.string(), found: z.boolean() }),
  overlaps: z.array(z.object({ signature: z.string(), at: iso, halt: HaltSchema })),
  note: z.string(),
  sources: z.array(SourceSchema).min(1),
})

export const RehearsalReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: iso,
  symbol: z.literal("FWDI"),
  mint: MintFactsSchema,
  markets: MarketsSchema,
  activity: ActivitySchema,
  budget: BudgetSchema,
  haltAudit: HaltAuditSchema,
})
export type RehearsalReport = z.infer<typeof RehearsalReportSchema>
export type Activity = z.infer<typeof ActivitySchema>
export type Budget = z.infer<typeof BudgetSchema>
export type HaltAudit = z.infer<typeof HaltAuditSchema>
export type Halt = z.infer<typeof HaltSchema>
export type Markets = z.infer<typeof MarketsSchema>

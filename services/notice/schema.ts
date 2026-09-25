/**
 * The public-notice draft as JSON: the contract the API serves and the web's notice page renders.
 * Every chain value carries where it was read; every config value is the operator's own answer.
 */
import { z } from "zod"

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const iso = z.string().datetime()

export const TokenFactsSchema = z.object({
  address, name: z.string(), symbol: z.string(), tokenProgram: address, decimals: z.number().int(),
  mintAuthority: address.nullable(), freezeAuthority: address.nullable(), permanentDelegate: address.nullable(),
  defaultAccountState: z.enum(["uninitialized", "initialized", "frozen"]).nullable(),
  metadataPointerAuthority: address.nullable(), metadataUpdateAuthority: address.nullable(), scaledUiAuthority: address.nullable(),
  transferHook: z.object({ authority: address.nullable(), programId: address.nullable() }).nullable(),
  pausable: z.object({ authority: address.nullable(), paused: z.boolean() }).nullable(),
  extensions: z.array(z.string()),
  readVia: z.string(),
  slot: z.number().int(),
})
export type TokenFacts = z.infer<typeof TokenFactsSchema>

export const PoolFactsSchema = z.object({
  address, feeBps: z.number().int(), stockVault: address, usdcVault: address, stockMint: address, usdcMint: address,
  stockDecimals: z.number().int(), usdcDecimals: z.number().int(), reserveStock: z.string(), reserveUsdc: z.string(), lpTotal: z.string(),
})

export const SymbolFactsSchema = z.object({
  address, ticker: z.string(), mint: address, tier: z.number().int(), issuerSponsored: z.boolean(), active: z.boolean(),
  halted: z.boolean(), haltReason: z.string(), objected: z.boolean(), breachCount: z.number().int(),
  advShares: z.string(), capShares: z.string(), pausedUntil: z.number().int(), lastHeartbeat: z.number().int(), noticeReceivedAt: z.number().int(),
  pool: PoolFactsSchema.nullable(),
  token: TokenFactsSchema.nullable(),
})
export type SymbolFacts = z.infer<typeof SymbolFactsSchema>

export const ChainFactsSchema = z.object({
  rpcUrl: z.string().url(), slot: z.number().int(), fetchedAt: iso,
  program: z.object({
    id: address, loader: address, upgradeable: z.boolean(), programData: address.nullable(), upgradeAuthority: address.nullable(),
    deploySlot: z.number().int().nullable(), programLength: z.number().int().nullable(),
  }).nullable(),
  venue: z.object({
    address, admin: address, relay: address, dataAuthority: address, credentialIssuer: address,
    sasCredential: address, sasSchema: address, affiliateGroup: address,
    gate: z.object({ sas: z.boolean(), membership: z.boolean() }),
    tier1Count: z.number().int(), tier2Count: z.number().int(),
    heartbeatMaxAgeS: z.number().int(), tradeDateCutoffS: z.number().int(), tradeDateCutoffUtc: z.string(),
  }).nullable(),
  symbols: z.array(SymbolFactsSchema),
  errors: z.array(z.string()),
})
export type ChainFacts = z.infer<typeof ChainFactsSchema>

export const FactSchema = z.object({
  key: z.string(), label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  source: z.enum(["chain", "config"]),
  /** For chain facts: the account (and field) the value was decoded from. */
  evidence: z.string().nullable(),
})
export type Fact = z.infer<typeof FactSchema>

export const NoticeItemSchema = z.object({
  letter: z.string(), title: z.string(), requirement: z.string(),
  source: z.enum(["chain", "config", "operator-input"]),
  /** filled: answered from chain/config · operator-input: empty, flagged · unresolved: a chain/config value is missing */
  status: z.enum(["filled", "operator-input", "unresolved"]),
  text: z.string().nullable(),
  facts: z.array(FactSchema),
  operatorPrompt: z.string().nullable(),
  /** Parts of a filled item the order also asks for that only the operator can add. */
  addenda: z.array(z.string()),
  unresolved: z.array(z.string()),
})
export type NoticeItem = z.infer<typeof NoticeItemSchema>

export const ReminderKinds = ["operating-date", "sec-email", "listing-change", "volume-pause", "objection", "material-change", "quarterly", "inaccuracy"] as const
export const ReminderSchema = z.object({
  kind: z.enum(ReminderKinds), due: ymd, rule: z.string(), cite: z.string(), subject: z.string().nullable(),
})
export type Reminder = z.infer<typeof ReminderSchema>

export const IssuerNoticeRecordSchema = z.object({
  symbol: z.string().min(1), mint: address, issuer: z.string().min(1), issuerSponsored: z.boolean(),
  /** Physical or email address of the principal executive offices, from the cover page of the issuer's Exchange Act reports. */
  address: z.string().min(1).nullable().default(null),
  addressSource: z.string().url().nullable().default(null),
  sentAt: iso.nullable().default(null),
  receivedAt: iso.nullable().default(null),
  objection: z.object({ receivedAt: iso }).nullable().default(null),
})
export type IssuerNoticeRecord = z.input<typeof IssuerNoticeRecordSchema>

export const OnChainSymbolSchema = z.object({
  address, issuerSponsored: z.boolean(), noticeReceivedAt: z.number().int(), objected: z.boolean(), active: z.boolean(),
})
export type OnChainSymbol = z.infer<typeof OnChainSymbolSchema>

export const IssuerNoticeStatusSchema = z.object({
  symbol: z.string(), mint: address, issuer: z.string(), issuerSponsored: z.boolean(),
  /** False for an issuer-sponsored token: the Issuer Notice condition applies only to third-party tokens. */
  noticeRequired: z.boolean(),
  address: z.string().nullable(), addressSource: z.string().nullable(),
  sentAt: iso.nullable(), receivedAt: iso.nullable(), deadline: iso.nullable(), daysRemaining: z.number().int().nullable(),
  objection: z.object({ receivedAt: iso, timely: z.boolean() }).nullable(),
  status: z.enum(["not-required", "not-sent", "awaiting-receipt", "window-open", "objected", "eligible", "active"]),
  canActivate: z.boolean(),
  blockedReason: z.string().nullable(),
  /** What activate_pool would return right now, judged on the on-chain record when one is given. */
  expectedActivation: z.object({ ok: z.boolean(), error: z.enum(["NoticeWindowOpen", "Objected"]).nullable(), code: z.number().int().nullable() }),
  onChain: OnChainSymbolSchema.nullable(),
  mismatches: z.array(z.string()),
  nextAction: z.string().nullable(),
  reminders: z.array(ReminderSchema),
})
export type IssuerNoticeStatus = z.infer<typeof IssuerNoticeStatusSchema>

export const RevisionEventSchema = z.object({
  category: z.enum(["listing-change", "volume-pause", "volume-resume", "objection", "material-change", "non-material", "inaccuracy"]),
  description: z.string().min(1),
  occurredOn: ymd,
  effectiveOn: ymd.nullable().default(null),
})
export type RevisionEvent = z.input<typeof RevisionEventSchema>

export const NoticeDraftSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: iso,
  venueName: z.string(),
  orderCite: z.string(),
  completeness: z.object({
    filled: z.number().int(), operatorInput: z.number().int(), unresolved: z.number().int(), total: z.literal(30),
    withAddenda: z.number().int(), label: z.string(),
  }),
  items: z.array(NoticeItemSchema).length(30),
  schedule: z.object({
    publishedOn: ymd.nullable(),
    earliestOperatingDate: ymd.nullable(),
    secEmailDue: ymd.nullable(),
    secEmail: z.object({ to: z.string().email(), mustInclude: z.array(z.object({ what: z.string(), value: z.string().nullable() })), missing: z.array(z.string()) }),
    reminders: z.array(ReminderSchema),
  }),
  issuerNotices: z.array(IssuerNoticeStatusSchema),
  revisions: z.array(RevisionEventSchema),
  chain: ChainFactsSchema,
})
export type NoticeDraft = z.infer<typeof NoticeDraftSchema>

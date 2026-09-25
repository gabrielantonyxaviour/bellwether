/**
 * The notice draft and FWDI report as services/notice and services/rehearsal actually serve them.
 * Loose where a new fact must not blank the page; strict on the fields the screens render.
 */
import { z } from "zod"

const address = z.string()
const factValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const OperatorNoticeSchema = z.looseObject({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  venueName: z.string(),
  orderCite: z.string(),
  completeness: z.looseObject({
    filled: z.number(),
    operatorInput: z.number(),
    unresolved: z.number(),
    total: z.number(),
    label: z.string(),
  }),
  items: z.array(z.looseObject({
    letter: z.string(),
    title: z.string(),
    requirement: z.string(),
    source: z.enum(["chain", "config", "operator-input"]),
    status: z.enum(["filled", "operator-input", "unresolved"]),
    text: z.string().nullable(),
    operatorPrompt: z.string().nullable(),
    addenda: z.array(z.string()),
    unresolved: z.array(z.string()),
    facts: z.array(z.looseObject({ key: z.string(), label: z.string(), value: factValue, source: z.enum(["chain", "config"]) })),
  })),
  schedule: z.looseObject({
    publishedOn: z.string().nullable(),
    earliestOperatingDate: z.string().nullable(),
    secEmailDue: z.string().nullable(),
    reminders: z.array(z.looseObject({ kind: z.string(), due: z.string(), rule: z.string(), subject: z.string().nullable() })),
  }),
  chain: z.looseObject({
    program: z.looseObject({
      id: address,
      upgradeable: z.boolean(),
      upgradeAuthority: address.nullable(),
    }).nullable(),
    venue: z.looseObject({
      address,
      admin: address,
      relay: address,
      dataAuthority: address,
      credentialIssuer: address,
      sasCredential: address,
      sasSchema: address,
      tier1Count: z.number(),
      tier2Count: z.number(),
      heartbeatMaxAgeS: z.number(),
    }).nullable(),
    symbols: z.array(z.looseObject({
      ticker: z.string(),
      pool: z.looseObject({ address, feeBps: z.number(), stockVault: address, usdcVault: address }).nullable(),
      token: z.looseObject({
        mintAuthority: address.nullable(),
        freezeAuthority: address.nullable(),
        permanentDelegate: address.nullable(),
        pausable: z.looseObject({ authority: address.nullable(), paused: z.boolean() }).nullable(),
      }).nullable(),
    })),
  }),
})
export type OperatorNotice = z.infer<typeof OperatorNoticeSchema>

export const OperatorRehearsalSchema = z.looseObject({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  symbol: z.literal("FWDI"),
  mint: z.looseObject({
    address,
    name: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    supplyShares: z.number(),
    mintAuthority: address.nullable(),
    freezeAuthority: address.nullable(),
    permanentDelegate: address.nullable(),
    defaultAccountState: z.string().nullable(),
    authorityMap: z.array(z.looseObject({ address, roles: z.array(z.string()), powers: z.array(z.string()) })),
    source: z.looseObject({ name: z.string(), fetchedAt: z.string() }),
  }),
  markets: z.looseObject({
    found: z.array(z.looseObject({
      address,
      programName: z.string(),
      kind: z.string(),
      canTrade: z.boolean(),
      blocker: z.string().nullable(),
      fwdiVault: z.looseObject({ state: z.string().nullable(), exists: z.boolean() }),
    })),
  }),
  activity: z.looseObject({
    windowDays: z.number(),
    signatures: z.number(),
    trades: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    truncated: z.boolean(),
  }),
  budget: z.looseObject({
    status: z.enum(["complete", "partial", "unavailable"]),
    tier: z.literal("Tier 2"),
    tierLabel: z.string(),
    month: z.string(),
    averageDailyShareVolume: z.number().nullable(),
    dailyShareBudget: z.number().nullable(),
    primary: z.string().nullable(),
    errors: z.array(z.string()),
  }),
  haltAudit: z.looseObject({
    status: z.enum(["complete", "partial", "unavailable"]),
    latestHaltAt: z.string().nullable(),
    note: z.string(),
    halts: z.array(z.looseObject({ symbol: z.string(), reason: z.string(), haltAt: z.string(), resumedAt: z.string().nullable() })),
  }),
})
export type OperatorRehearsal = z.infer<typeof OperatorRehearsalSchema>

export const HaltRowSchema = z.looseObject({
  symbol: z.string(),
  reason_code: z.string().nullable(),
  status: z.string().nullable().optional(),
  nasdaq_halt_time: z.string().nullable(),
  feed_seen_at: z.string().nullable(),
  tx_confirmed_at: z.string().nullable(),
  tx_signature: z.string().nullable(),
  resumed_at: z.string().nullable(),
  detection_ms: z.number().nullable().optional(),
  enforcement_ms: z.number().nullable().optional(),
})
export type HaltRow = z.infer<typeof HaltRowSchema>

export const RelayHealthSchema = z.looseObject({
  last_poll_at: z.string().nullable(),
  last_poll_ok: z.boolean().nullable(),
  consecutive_failures: z.number().nullable(),
  last_heartbeat_at: z.string().nullable(),
  feed_published_at: z.string().nullable(),
  source: z.string().nullable(),
}).nullable()
export type RelayHealth = z.infer<typeof RelayHealthSchema>

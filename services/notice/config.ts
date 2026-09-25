/**
 * The venue's own answers to the Notice items that are neither on-chain facts nor legal
 * narrative: hours, quote asset, affiliates, market data, fees and the like. A null value is a
 * statement the operator has not made yet; the draft flags it instead of inventing one.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

export const VENUE_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "venue.config.json")

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 address")
const text = z.string().min(1)
const deployment = z.object({ programId: address.nullable(), venue: address.nullable() })

export const VenueConfigFileSchema = z.object({
  venue: z.object({
    name: text,
    legalEntity: text.nullable(),
    contactEmail: z.string().email().nullable(),
    contactPhone: text.nullable(),
    noticeUrl: z.string().url().nullable(),
  }),
  deployments: z.object({ fork: deployment, devnet: deployment, mainnet: deployment }),
  structure: text,
  affiliates: z.object({ affiliatedTsvs: z.array(text), tradingByTsvOrAffiliates: z.boolean(), statement: text }),
  lpGovernance: text,
  participants: z.object({ eligible: z.array(text).min(1), brokerDealerAccess: text }),
  access: z.object({
    criteria: text, procedure: text, sanctions: text, denial: text, identityVerification: text.nullable(),
  }),
  treatment: text,
  entry: z.object({ procedure: text, checks: text, confirmation: text, sizeLimits: text, messages: text }),
  offchain: text,
  hours: z.object({ twentyFourSeven: z.boolean(), statement: text }),
  quoteAsset: z.object({ symbol: text, name: text, kind: text, usdValuation: text }),
  marketData: z.array(z.object({ provider: text, source: text, use: text })).min(1),
  oracles: text,
  display: text,
  fees: text,
  stoppage: z.object({ circumstances: text, controls: text, resumption: text, corporateActions: text.nullable() }),
  technology: z.object({
    ledger: text,
    interfaces: z.array(z.object({ name: text, role: text, providedBy: text })).min(1),
    aggregators: text,
    interoperability: text,
    directAccess: text,
  }),
  listings: z.array(z.object({
    symbol: text, mint: address, issuer: text, tokenizer: text, issuerSponsored: z.boolean(), note: text.optional(),
  })),
})
export type VenueConfigFile = z.infer<typeof VenueConfigFileSchema>
export type Cluster = keyof VenueConfigFile["deployments"]

export function parseVenueConfig(value: unknown): VenueConfigFile {
  const parsed = VenueConfigFileSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    throw new Error(`venue config is invalid: ${issues}`)
  }
  return parsed.data
}

export function loadVenueConfig(path = VENUE_CONFIG_PATH): VenueConfigFile {
  return parseVenueConfig(JSON.parse(readFileSync(path, "utf8")))
}

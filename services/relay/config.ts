/**
 * Relay configuration from the environment (zod-validated at the boundary).
 *
 *   RELAY_RPC_URL           Solana RPC the relay sends to (required)
 *   RELAY_KEYPAIR_PATH      relay authority keypair file, a 64-byte JSON array (required; the
 *                           venue's `relay` field must equal its public key)
 *   RELAY_PROGRAM_ID        venue program id (required)
 *   RELAY_VENUE             VenueConfig PDA address (required)
 *   RELAY_SYMBOL_MAP        JSON array, or a path to a .json file holding it:
 *                           [{"nasdaq":"FWDI","stockMint":"<mint>","ticker":"BWRS"}]
 *                           symbolRecord is optional (derived from venue + stockMint)
 *   RELAY_POLL_INTERVAL_MS  default 60000; anything below 60000 is refused (Nasdaq rule)
 *   RELAY_FEED_URL          default https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts
 *   RELAY_NYSE_URL          default https://www.nyse.com/api/trade-halts/current
 *   RELAY_NYSE_CROSSCHECK   1 (default) records NYSE agreement each cycle; 0 disables
 *   RELAY_NYSE_FALLBACK     0 (default); 1 uses NYSE when the Nasdaq poll fails
 *   RELAY_DATA_DIR          ledger/status directory, default services/relay/data
 *   RELAY_CONFIRM_MAINNET   must be 1 before the relay will send to a mainnet RPC
 */
import { existsSync, readFileSync } from "node:fs"
import { z } from "zod"
import { NASDAQ_HALTS_URL } from "./feed.js"
import { DEFAULT_DATA_DIR } from "./ledger.js"
import { NYSE_CURRENT_URL } from "./nyse.js"
import { MIN_POLL_INTERVAL_MS } from "./scheduler.js"

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 address")
const flag = (fallback: boolean) => z.enum(["0", "1", "true", "false"]).optional().transform((v) => (v === undefined ? fallback : v === "1" || v === "true"))

export const symbolMappingSchema = z.object({
  nasdaq: z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/, "Nasdaq IssueSymbol, e.g. FWDI"),
  stockMint: base58,
  ticker: z.string().min(1).max(8).optional(),
  symbolRecord: base58.optional(),
})
export type SymbolMapping = z.infer<typeof symbolMappingSchema>

const envSchema = z.object({
  RELAY_RPC_URL: z.string().url(),
  RELAY_KEYPAIR_PATH: z.string().min(1),
  RELAY_PROGRAM_ID: base58,
  RELAY_VENUE: base58,
  RELAY_SYMBOL_MAP: z.string().min(1),
  RELAY_POLL_INTERVAL_MS: z.coerce.number().int().optional().default(MIN_POLL_INTERVAL_MS)
    .refine((v) => v >= MIN_POLL_INTERVAL_MS, `RELAY_POLL_INTERVAL_MS must be at least ${MIN_POLL_INTERVAL_MS} (Nasdaq allows one poll a minute)`),
  RELAY_FEED_URL: z.string().url().optional().default(NASDAQ_HALTS_URL),
  RELAY_NYSE_URL: z.string().url().optional().default(NYSE_CURRENT_URL),
  RELAY_NYSE_CROSSCHECK: flag(true),
  RELAY_NYSE_FALLBACK: flag(false),
  RELAY_DATA_DIR: z.string().min(1).optional().default(DEFAULT_DATA_DIR),
  RELAY_CONFIRM_MAINNET: flag(false),
})

export interface RelayConfig {
  rpcUrl: string
  keypairPath: string
  programId: string
  venue: string
  symbols: SymbolMapping[]
  pollIntervalMs: number
  feedUrl: string
  nyseUrl: string
  nyseCrossCheck: boolean
  nyseFallback: boolean
  dataDir: string
  confirmMainnet: boolean
}

function symbolMap(raw: string): SymbolMapping[] {
  const text = raw.trim().startsWith("[") ? raw : existsSync(raw) ? readFileSync(raw, "utf8") : null
  if (text === null) throw new Error(`RELAY_SYMBOL_MAP is neither a JSON array nor an existing file: ${raw}`)
  const parsed = z.array(symbolMappingSchema).min(1).safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error(`RELAY_SYMBOL_MAP: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`)
  const seen = new Set<string>()
  for (const s of parsed.data) {
    if (seen.has(s.nasdaq)) throw new Error(`RELAY_SYMBOL_MAP maps ${s.nasdaq} twice`)
    seen.add(s.nasdaq)
  }
  return parsed.data
}

export function parseRelayConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) throw new Error(`relay config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
  const e = parsed.data
  return {
    rpcUrl: e.RELAY_RPC_URL, keypairPath: e.RELAY_KEYPAIR_PATH, programId: e.RELAY_PROGRAM_ID, venue: e.RELAY_VENUE,
    symbols: symbolMap(e.RELAY_SYMBOL_MAP), pollIntervalMs: e.RELAY_POLL_INTERVAL_MS, feedUrl: e.RELAY_FEED_URL,
    nyseUrl: e.RELAY_NYSE_URL, nyseCrossCheck: e.RELAY_NYSE_CROSSCHECK, nyseFallback: e.RELAY_NYSE_FALLBACK,
    dataDir: e.RELAY_DATA_DIR, confirmMainnet: e.RELAY_CONFIRM_MAINNET,
  }
}

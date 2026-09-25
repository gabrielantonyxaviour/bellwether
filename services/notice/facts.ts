/** Shared shapes for filling Notice items: a fact carries its source and, for chain facts, its account. */
import type { VenueConfigFile } from "./config.js"
import type { ChainFacts, Fact, IssuerNoticeStatus, SymbolFacts } from "./schema.js"

export interface FillContext {
  chain: ChainFacts
  config: VenueConfigFile
  issuers: IssuerNoticeStatus[]
  now: Date
}

export interface Filled {
  text: string | null
  facts: Fact[]
  addenda: string[]
  /** Keys a chain/config item needed but could not resolve. */
  unresolved: string[]
  operatorPrompt?: string
}

export const chainFact = (key: string, label: string, value: Fact["value"], evidence: string): Fact =>
  ({ key, label, value, source: "chain", evidence })
export const configFact = (key: string, label: string, value: Fact["value"]): Fact =>
  ({ key, label, value, source: "config", evidence: null })

export const code = (value: string | null | undefined) => (value ? `\`${value}\`` : "none")
export const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n")
export const pct = (bps: number) => `${bps} bps (${(bps / 100).toFixed(2)}%)`

export function sharesOf(raw: string, decimals: number | undefined): string {
  if (decimals === undefined) return `${raw} base units`
  const value = Number(BigInt(raw)) / 10 ** decimals
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} shares`
}

export function isoOrNever(seconds: number): string | null {
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : null
}

export function symbolState(s: SymbolFacts, nowS: number): string {
  if (s.objected) return "not available: the issuer objected"
  if (s.pausedUntil > nowS) return `paused until ${new Date(s.pausedUntil * 1000).toISOString().slice(0, 10)} after a volume-threshold breach`
  if (!s.active) return s.issuerSponsored ? "registered, not yet activated" : "registered, awaiting the issuer-notice window"
  if (s.halted) return `available, currently halted (${s.haltReason || "halt"})`
  return "available for trading"
}

/** Every mint authority and extension the Notice states, as facts keyed mint.<TICKER>.<field>. */
export function tokenFacts(s: SymbolFacts): Fact[] {
  const t = s.token
  if (!t) return []
  const ev = `mint ${t.address} (${t.readVia}, slot ${t.slot})`
  const k = (field: string) => `mint.${s.ticker}.${field}`
  return [
    chainFact(k("tokenProgram"), `${s.ticker} token program`, t.tokenProgram, ev),
    chainFact(k("mintAuthority"), `${s.ticker} mint authority`, t.mintAuthority, ev),
    chainFact(k("freezeAuthority"), `${s.ticker} freeze authority`, t.freezeAuthority, ev),
    chainFact(k("permanentDelegate"), `${s.ticker} permanent delegate`, t.permanentDelegate, ev),
    chainFact(k("metadataUpdateAuthority"), `${s.ticker} metadata update authority`, t.metadataUpdateAuthority, ev),
    chainFact(k("metadataPointerAuthority"), `${s.ticker} metadata pointer authority`, t.metadataPointerAuthority, ev),
    chainFact(k("scaledUiAuthority"), `${s.ticker} scaled-UI authority`, t.scaledUiAuthority, ev),
    chainFact(k("defaultAccountState"), `${s.ticker} default account state`, t.defaultAccountState, ev),
    chainFact(k("transferHookProgram"), `${s.ticker} transfer hook program`, t.transferHook?.programId ?? null, ev),
    chainFact(k("transferHookAuthority"), `${s.ticker} transfer hook authority`, t.transferHook?.authority ?? null, ev),
    chainFact(k("pausableAuthority"), `${s.ticker} pausable authority`, t.pausable?.authority ?? null, ev),
  ]
}

/** Plain-English token powers for the Notice text. */
export function tokenPowers(s: SymbolFacts): string[] {
  const t = s.token
  if (!t) return [`${s.ticker}: mint facts could not be read`]
  const lines = [
    `${s.ticker} mint ${code(t.address)} (${t.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : t.tokenProgram}, ${t.decimals} decimals); new token accounts start ${t.defaultAccountState ?? "initialized"}.`,
    `${s.ticker} freeze authority ${code(t.freezeAuthority)} can freeze and thaw any holder's account, including pool vaults.`,
    `${s.ticker} permanent delegate ${code(t.permanentDelegate)} can transfer or burn tokens from any account, including pool vaults.`,
    `${s.ticker} mint authority ${code(t.mintAuthority)}; metadata update authority ${code(t.metadataUpdateAuthority)}; scaled-UI authority ${code(t.scaledUiAuthority)}.`,
  ]
  lines.push(t.transferHook
    ? `${s.ticker} transfer hook: program ${code(t.transferHook.programId)}, authority ${code(t.transferHook.authority)} (can set or change the hook program).`
    : `${s.ticker} has no transfer hook.`)
  if (t.pausable) lines.push(`${s.ticker} pausable authority ${code(t.pausable.authority)} can pause every transfer of the token (currently ${t.pausable.paused ? "paused" : "not paused"}).`)
  return lines
}

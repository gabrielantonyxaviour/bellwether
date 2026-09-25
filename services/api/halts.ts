/**
 * The halt ledger as the API serves it (HaltLedgerEntry in spec.json), normalized from the halt
 * relay's state (services/relay/ledger.ts: camelCase entries under `ledger`, ISO times) while also
 * accepting snake_case rows and epoch-ms / epoch-s times. Runtime-neutral: the Node file reader
 * lives in halts-file.ts.
 */
import { z } from "zod"

export interface HaltEntry {
  symbol: string
  reason_code: string | null
  status: string | null
  nasdaq_halt_time: string | null
  feed_seen_at: string | null
  tx_confirmed_at: string | null
  tx_signature: string | null
  resumed_at: string | null
  resume_confirmed_at: string | null
  resume_signature: string | null
  detection_ms: number | null
  enforcement_ms: number | null
}

/** The relay's own health, when its state file carries it. */
export interface RelayHealth {
  last_poll_at: string | null
  last_poll_ok: boolean | null
  consecutive_failures: number | null
  last_heartbeat_at: string | null
  feed_published_at: string | null
  source: string | null
}

export interface HaltList {
  source: string | null
  entries: HaltEntry[]
  skipped: number
  relay: RelayHealth | null
}

export interface HaltSource {
  list(): Promise<HaltList>
}

export class HaltLedgerUnreadable extends Error {}

const Raw = z.record(z.string(), z.unknown())

function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null
  const digits = typeof value === "string" && /^\d+$/.test(value)
  const n = typeof value === "string" && !digits ? Date.parse(value) : Number(value)
  if (!Number.isFinite(n)) return null
  const ms = typeof value === "string" && !digits ? n : n < 1e12 ? n * 1000 : n
  return new Date(ms).toISOString()
}

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]
  return null
}
const text = (v: unknown) => (v === null || v === undefined ? null : String(v))
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)

export function normalizeHalt(raw: unknown): HaltEntry | null {
  const parsed = Raw.safeParse(raw)
  if (!parsed.success) return null
  const o = parsed.data
  const symbol = text(pick(o, "symbol", "ticker", "nasdaqSymbol"))
  if (!symbol || !symbol.trim()) return null
  return {
    symbol: symbol.trim().toUpperCase(),
    reason_code: text(pick(o, "reason_code", "reasonCode", "reason")),
    status: text(pick(o, "status")),
    nasdaq_halt_time: toIso(pick(o, "nasdaq_halt_time", "nasdaqHaltTime", "halt_at", "haltAt")),
    feed_seen_at: toIso(pick(o, "feed_seen_at", "feedSeenAt")),
    tx_confirmed_at: toIso(pick(o, "tx_confirmed_at", "txConfirmedAt", "haltConfirmedAt")),
    tx_signature: text(pick(o, "tx_signature", "txSignature", "haltSignature", "signature")),
    resumed_at: toIso(pick(o, "resumed_at", "resumedAt")),
    resume_confirmed_at: toIso(pick(o, "resume_confirmed_at", "clearConfirmedAt")),
    resume_signature: text(pick(o, "resume_signature", "clearSignature")),
    detection_ms: count(pick(o, "detection_ms", "detectionMs")),
    enforcement_ms: count(pick(o, "enforcement_ms", "enforcementMs")),
  }
}

export function normalizeRelayHealth(raw: unknown): RelayHealth | null {
  const parsed = Raw.safeParse(raw)
  if (!parsed.success) return null
  const o = parsed.data
  return {
    last_poll_at: toIso(o.lastPollAt),
    last_poll_ok: typeof o.lastPollOk === "boolean" ? o.lastPollOk : null,
    consecutive_failures: count(o.consecutiveFailures),
    last_heartbeat_at: toIso(o.lastHeartbeatAt),
    feed_published_at: toIso(o.feedPublishedAt),
    source: text(o.lastSource),
  }
}

/**
 * The relay's persisted state: the latency ledger (one entry per halt of a mapped symbol, with
 * Nasdaq's halt time, when the relay first saw it in the feed, and when set_halt confirmed on
 * chain) and the relay's own status (last poll, failures, last heartbeat, NYSE cross-check).
 *
 * Stored as one JSON document (services/relay/data/relay.json by default; gitignored runtime
 * data), written atomically. The API reads it with readLedger / readRelayStatus.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

export const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data")
export const STATE_FILE = "relay.json"

const iso = z.string().datetime({ offset: true })
const isoOrNull = iso.nullable()

export const haltLedgerEntrySchema = z.object({
  id: z.string(),
  nasdaqSymbol: z.string(),
  ticker: z.string(),
  symbolRecord: z.string(),
  reasonCode: z.string(),
  /** Nasdaq's halt instant (HaltDate + HaltTime ET), UTC ISO. */
  nasdaqHaltTime: iso,
  /** When a successful poll first carried this halt. */
  feedSeenAt: iso,
  haltSignature: z.string().nullable(),
  /** When set_halt was confirmed: from here the program refuses swaps. */
  haltConfirmedAt: isoOrNull,
  haltSlot: z.string().nullable(),
  detectionMs: z.number(),
  enforcementMs: z.number().nullable(),
  /** Nasdaq's resumption trade time, when published. */
  resumedAt: isoOrNull,
  resumeSeenAt: isoOrNull,
  clearSignature: z.string().nullable(),
  clearConfirmedAt: isoOrNull,
  /** halted: enforced on chain; resumed: cleared; missed: resumed before the relay saw it. */
  status: z.enum(["pending", "halted", "resumed", "missed"]),
})
export type HaltLedgerEntry = z.infer<typeof haltLedgerEntrySchema>

export const relayStatusSchema = z.object({
  relay: z.string().nullable(),
  lastPollAt: isoOrNull,
  lastPollOk: z.boolean().nullable(),
  lastPollError: z.string().nullable(),
  lastSource: z.enum(["nasdaq", "nyse-fallback"]).nullable(),
  feedPublishedAt: isoOrNull,
  consecutiveFailures: z.number().int().nonnegative(),
  lastHeartbeatAt: isoOrNull,
  lastHeartbeatSignature: z.string().nullable(),
  lastTxError: z.string().nullable(),
  crossCheck: z.object({ at: iso, ok: z.boolean(), disagreements: z.array(z.string()), error: z.string().nullable() }).nullable(),
  symbols: z.record(z.string(), z.object({
    ticker: z.string(), symbolRecord: z.string(), halted: z.boolean(), reasonCode: z.string().nullable(),
    seq: z.string(), lastAction: z.enum(["set_halt", "clear_halt", "heartbeat"]).nullable(), lastActionAt: isoOrNull,
  })),
})
export type RelayStatus = z.infer<typeof relayStatusSchema>

export const relayStateSchema = z.object({ version: z.literal(1), status: relayStatusSchema, ledger: z.array(haltLedgerEntrySchema) })
export type RelayState = z.infer<typeof relayStateSchema>

export function emptyState(relay: string | null = null): RelayState {
  return {
    version: 1,
    status: {
      relay, lastPollAt: null, lastPollOk: null, lastPollError: null, lastSource: null, feedPublishedAt: null,
      consecutiveFailures: 0, lastHeartbeatAt: null, lastHeartbeatSignature: null, lastTxError: null, crossCheck: null, symbols: {},
    },
    ledger: [],
  }
}

export interface RelayStore {
  load(): Promise<RelayState>
  save(state: RelayState): Promise<void>
}

export function memoryStore(initial: RelayState = emptyState()): RelayStore {
  let current = structuredClone(initial)
  return {
    async load() { return structuredClone(current) },
    async save(state) { current = structuredClone(relayStateSchema.parse(state)) },
  }
}

function readStateFile(path: string): RelayState | null {
  if (!existsSync(path)) return null
  return relayStateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

/** A state file that no longer parses is moved aside (never deleted) so the relay keeps heartbeating. */
function loadOrQuarantine(path: string): RelayState {
  try {
    return readStateFile(path) ?? emptyState()
  } catch {
    renameSync(path, `${path}.unreadable-${Date.now()}`)
    return emptyState()
  }
}

/** JSON file store under `dir` (created on first save), replaced atomically by rename. */
export function jsonFileStore(dir = DEFAULT_DATA_DIR): RelayStore {
  const path = join(dir, STATE_FILE)
  return {
    async load() { return loadOrQuarantine(path) },
    async save(state) {
      const valid = relayStateSchema.parse(state)
      mkdirSync(dir, { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(valid, null, 2) + "\n")
      renameSync(tmp, path)
    },
  }
}

/** The latency ledger, newest halt first. Empty when the relay has never run here. */
export function readLedger(dir = DEFAULT_DATA_DIR): HaltLedgerEntry[] {
  const state = readStateFile(join(dir, STATE_FILE))
  return state ? [...state.ledger].sort((a, b) => b.nasdaqHaltTime.localeCompare(a.nasdaqHaltTime)) : []
}

/** The relay's last-known status, or null when it has never run here. */
export function readRelayStatus(dir = DEFAULT_DATA_DIR): RelayStatus | null {
  return readStateFile(join(dir, STATE_FILE))?.status ?? null
}

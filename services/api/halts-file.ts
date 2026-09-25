/**
 * Node reader for the halt relay's ledger (written by services/relay; never modified here).
 * A missing file means the relay has not run here yet and reads as empty; a file that exists but
 * cannot be read is an error, never "no halts".
 *
 * Accepted files: the relay's state document services/relay/data/relay.json ({ status, ledger }),
 * any .json holding an array or { entries | halts | ledger: [...] }, .jsonl / .ndjson (one entry per
 * line), and .sqlite / .db (table halt_ledger).
 */
import { existsSync, readFileSync } from "node:fs"
import { extname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { HaltLedgerUnreadable, normalizeHalt, normalizeRelayHealth, type HaltEntry, type HaltSource, type RelayHealth } from "./halts.js"

function readRows(path: string): { rows: unknown[]; relay: RelayHealth | null } {
  const ext = extname(path).toLowerCase()
  if (ext === ".sqlite" || ext === ".db") {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return { rows: db.prepare("SELECT * FROM halt_ledger").all(), relay: null }
    } finally {
      db.close()
    }
  }
  const body = readFileSync(path, "utf8")
  if (ext === ".jsonl" || ext === ".ndjson") return { rows: body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)), relay: null }
  const json = JSON.parse(body) as unknown
  if (Array.isArray(json)) return { rows: json, relay: null }
  const doc = (json ?? {}) as { entries?: unknown; halts?: unknown; ledger?: unknown; status?: unknown }
  const list = doc.ledger ?? doc.entries ?? doc.halts
  if (!Array.isArray(list)) throw new Error("expected a ledger array")
  return { rows: list, relay: doc.status ? normalizeRelayHealth(doc.status) : null }
}

export function fileHaltSource(path: string): HaltSource {
  return {
    async list() {
      if (!existsSync(path)) return { source: null, entries: [], skipped: 0, relay: null }
      let read: { rows: unknown[]; relay: RelayHealth | null }
      try {
        read = readRows(path)
      } catch (error) {
        throw new HaltLedgerUnreadable(`halt ledger at ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
      }
      const entries: HaltEntry[] = []
      let skipped = 0
      for (const row of read.rows) {
        const entry = normalizeHalt(row)
        if (entry) entries.push(entry)
        else skipped++
      }
      entries.sort((a, b) => (b.nasdaq_halt_time ?? b.feed_seen_at ?? "").localeCompare(a.nasdaq_halt_time ?? a.feed_seen_at ?? ""))
      return { source: path, entries, skipped, relay: read.relay }
    },
  }
}

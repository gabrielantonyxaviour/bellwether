/**
 * Screening and credential log: one JSON object per line under services/credential/data
 * (runtime, gitignored). Every line carries the "test admission, not KYC" label.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { LABEL } from "./labels.js"

export type LogEvent = "screened" | "admitted" | "revoked" | "funded" | "error"

export interface LogEntry {
  at: string
  label: typeof LABEL
  wallet: string
  event: LogEvent
  result?: "clear" | "sanctioned" | "unavailable"
  [field: string]: unknown
}

export class ScreeningLog {
  constructor(readonly path: string) {}

  append(entry: { wallet: string; event: LogEvent; [field: string]: unknown }): LogEntry {
    const line: LogEntry = { at: new Date().toISOString(), label: LABEL, ...entry }
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, JSON.stringify(line) + "\n")
    return line
  }

  /** Newest first. */
  recent(limit: number, wallet?: string): LogEntry[] {
    if (!existsSync(this.path)) return []
    const out: LogEntry[] = []
    const lines = readFileSync(this.path, "utf8").split("\n")
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i].trim()) continue
      try {
        const entry = JSON.parse(lines[i]) as LogEntry
        if (!wallet || entry.wallet === wallet) out.push(entry)
      } catch { /* a torn last line from a crash is skipped, not fatal */ }
    }
    return out
  }

  lastFor(wallet: string): LogEntry | null {
    return this.recent(1, wallet)[0] ?? null
  }

  /** The wallet's latest credential transition (admitted or revoked). */
  lastCredentialEvent(wallet: string): LogEntry | null {
    return this.recent(Number.MAX_SAFE_INTEGER, wallet).find((e) => e.event === "admitted" || e.event === "revoked") ?? null
  }
}

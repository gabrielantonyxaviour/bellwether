/**
 * Operator readings of the venue rulebook: trade date, share budget, notice clock.
 * Matches programs/venue/src/rules (weekend fold, 30-day notice, tier caps).
 */
import type { SymbolRecord } from "@/lib/program"

export const TIER1_MAX = 75
export const TIER2_MAX = 250
export const NOTICE_WINDOW_S = 30 * 86_400
const DAY = 86_400

/** Day index of the trade date containing `now` (days since 1970-01-01, weekends → Friday). */
export function tradeDate(now: number, cutoff: number): number {
  const day = Math.floor(Math.max(0, now - cutoff) / DAY)
  const weekday = (day + 4) % 7
  if (weekday === 6) return day - 1
  if (weekday === 0) return day - 2
  return day
}

/** Shares already counted against today's budget. A new trade date starts at zero. */
export function sharesUsed(symbol: SymbolRecord, now: number, cutoff: number): bigint {
  const day = tradeDate(now, cutoff)
  return symbol.tradeDate === BigInt(day) ? symbol.sharesTradedToday : 0n
}

/** Percent of the daily share budget used, or null when the data job has not set a cap. */
export function capPercent(used: bigint, cap: bigint): number | null {
  if (cap <= 0n) return null
  const hundredths = Number((used * 10_000n) / cap)
  return Math.min(100, hundredths / 100)
}

export function heartbeatAge(lastHeartbeat: bigint, now: number): number | null {
  if (lastHeartbeat <= 0n) return null
  return Math.max(0, now - Number(lastHeartbeat))
}

export type Activation =
  | { kind: "active" }
  | { kind: "sponsored" }
  | { kind: "objected" }
  | { kind: "unnoticed" }
  | { kind: "window"; daysRemaining: number; deadline: number }
  | { kind: "eligible" }

export function activation(symbol: SymbolRecord, now: number): Activation {
  if (symbol.objected) return { kind: "objected" }
  if (symbol.active) return { kind: "active" }
  if (symbol.issuerSponsored) return { kind: "sponsored" }
  if (symbol.noticeReceivedAt <= 0n) return { kind: "unnoticed" }
  const deadline = Number(symbol.noticeReceivedAt) + NOTICE_WINDOW_S
  if (now < deadline) return { kind: "window", daysRemaining: Math.max(1, Math.ceil((deadline - now) / DAY)), deadline }
  return { kind: "eligible" }
}

export function activationLabel(state: Activation): string {
  switch (state.kind) {
    case "active": return "Active"
    case "sponsored": return "Issuer sponsored · not active"
    case "objected": return "Issuer objected"
    case "unnoticed": return "Notice not recorded"
    case "window": return `Notice clock · ${state.daysRemaining}d remaining`
    case "eligible": return "Eligible to activate"
  }
}

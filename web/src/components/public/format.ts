/** Display helpers for the public screens. Amounts stay decimal strings from the API. */

export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** Inclusive UTC day window ending today. The explorer picker is 30 days. */
export function utcWindow(days: number, now = new Date()): { min: string; max: string } {
  const max = utcToday(now)
  const [year, month, day] = max.split("-").map(Number)
  const start = new Date(Date.UTC(year, month - 1, day - (days - 1)))
  return { min: start.toISOString().slice(0, 10), max }
}

export function clampUtcDate(value: string, window: { min: string; max: string }): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return window.max
  if (value < window.min) return window.min
  if (value > window.max) return window.max
  return value
}

export function utcClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toISOString().slice(11, 19)
}

export function ageLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "not reported"
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return "not reported"
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** 30 bps → "0.30%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`
}

export function formatShares(decimal: string): string {
  const n = Number(decimal)
  if (!Number.isFinite(n)) return decimal
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 })
}

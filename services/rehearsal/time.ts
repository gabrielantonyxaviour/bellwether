/** US Eastern time helpers (Nasdaq dates and halt times are Eastern, with no zone in the string). */

const ET = "America/New_York"

function parts(date: Date): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value)
  }
  return out
}

/** YYYY-MM-DD of an instant in Eastern time. */
export function etDate(date: Date): string {
  const p = parts(date)
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`
}

/** An Eastern wall-clock time → the UTC instant (handles EST/EDT). */
export function etToUtc(ymd: string, hms: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number)
  const [h, mi, s] = hms.split(".")[0].split(":").map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0)
  const p = parts(new Date(guess))
  const asEt = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return new Date(guess + (guess - asEt))
}

/** MM/DD/YYYY → YYYY-MM-DD. */
export function fromUsDate(us: string): string {
  const [m, d, y] = us.trim().split("/")
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`
}

/** YYYY-MM-DD → MMDDYYYY (the Nasdaq Trader haltdate parameter). */
export function toHaltDateParam(ymd: string): string {
  const [y, m, d] = ymd.split("-")
  return `${m}${d}${y}`
}

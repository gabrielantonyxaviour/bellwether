/**
 * US Eastern wall-clock → UTC. Nasdaq and NYSE publish halt dates and times in Eastern time
 * with no zone in the string, so the offset (EST or EDT) is resolved per date.
 */

const ET = "America/New_York"
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
})

function etParts(ms: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of formatter.formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value)
  return out
}

/** YYYY-MM-DD and HH:MM[:SS[.mmm]] in Eastern time → unix milliseconds (UTC). */
export function etToUtcMs(ymd: string, hms: string): number {
  const date = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const time = hms.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/)
  if (!date || !time) throw new Error(`not an Eastern date/time: ${ymd} ${hms}`)
  const [y, mo, d] = [Number(date[1]), Number(date[2]), Number(date[3])]
  const [h, mi, s] = [Number(time[1]), Number(time[2]), Number(time[3] ?? 0)]
  const millis = Number((time[4] ?? "0").padEnd(3, "0"))
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const p = etParts(guess)
  const asEt = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return guess + (guess - asEt) + millis
}

/** MM/DD/YYYY → YYYY-MM-DD. */
export function fromUsDate(us: string): string {
  const m = us.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) throw new Error(`not an MM/DD/YYYY date: ${us}`)
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
}

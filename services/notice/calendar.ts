/**
 * Notice deadlines run on calendar days and on business days. Exchange Act Rule 0-3: a business
 * day is any day other than a Saturday, Sunday or federal holiday. Federal holidays follow 5 U.S.C.
 * 6103 with the OPM observance rule (a Saturday holiday is observed Friday, a Sunday one Monday).
 * Dates are YYYY-MM-DD strings in US Eastern time; instants convert through `etDate`.
 */
import { etDate } from "../rehearsal/time.js"

const DAY_MS = 86_400_000

function toUtc(ymd: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`not a YYYY-MM-DD date: ${ymd}`)
  return new Date(`${ymd}T00:00:00Z`)
}
const ymdOf = (d: Date) => d.toISOString().slice(0, 10)

export function addCalendarDays(ymd: string, days: number): string {
  return ymdOf(new Date(toUtc(ymd).getTime() + days * DAY_MS))
}

/** The n-th given weekday (0 = Sunday) of a month; n = -1 is the last. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1))
    const offset = (weekday - first.getUTCDay() + 7) % 7
    return ymdOf(new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7)))
  }
  const last = new Date(Date.UTC(year, month + 1, 0))
  const back = (last.getUTCDay() - weekday + 7) % 7
  return ymdOf(new Date(Date.UTC(year, month, last.getUTCDate() - back)))
}

function observed(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month, day))
  const dow = d.getUTCDay()
  if (dow === 6) return ymdOf(new Date(d.getTime() - DAY_MS))
  if (dow === 0) return ymdOf(new Date(d.getTime() + DAY_MS))
  return ymdOf(d)
}

const holidayCache = new Map<number, Set<string>>()

export function federalHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year)
  if (cached) return cached
  const set = new Set([
    observed(year, 0, 1), // New Year's Day
    nthWeekday(year, 0, 1, 3), // Birthday of Martin Luther King, Jr.
    nthWeekday(year, 1, 1, 3), // Washington's Birthday
    nthWeekday(year, 4, 1, -1), // Memorial Day
    observed(year, 5, 19), // Juneteenth National Independence Day
    observed(year, 6, 4), // Independence Day
    nthWeekday(year, 8, 1, 1), // Labor Day
    nthWeekday(year, 9, 1, 2), // Columbus Day
    observed(year, 10, 11), // Veterans Day
    nthWeekday(year, 10, 4, 4), // Thanksgiving Day
    observed(year, 11, 25), // Christmas Day
  ])
  // A Saturday New Year's Day of the next year is observed on 31 December of this one.
  if (new Date(Date.UTC(year + 1, 0, 1)).getUTCDay() === 6) set.add(`${year}-12-31`)
  holidayCache.set(year, set)
  return set
}

export function isBusinessDay(ymd: string): boolean {
  const d = toUtc(ymd)
  const dow = d.getUTCDay()
  return dow !== 0 && dow !== 6 && !federalHolidays(d.getUTCFullYear()).has(ymd)
}

/** The date `n` business days after `ymd` (the start day itself never counts). */
export function addBusinessDays(ymd: string, n: number): string {
  let current = ymd
  let left = n
  while (left > 0) {
    current = addCalendarDays(current, 1)
    if (isBusinessDay(current)) left--
  }
  return current
}

/** Last day of the calendar quarter containing `ymd`. */
export function quarterEnd(ymd: string): string {
  const d = toUtc(ymd)
  const endMonth = Math.floor(d.getUTCMonth() / 3) * 3 + 3
  return ymdOf(new Date(Date.UTC(d.getUTCFullYear(), endMonth, 0)))
}

/** Eastern-time calendar date of an ISO instant or a YYYY-MM-DD date (returned as is). */
export function easternDate(value: string | Date): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = typeof value === "string" ? new Date(value) : value
  if (Number.isNaN(date.getTime())) throw new Error(`not a date: ${String(value)}`)
  return etDate(date)
}

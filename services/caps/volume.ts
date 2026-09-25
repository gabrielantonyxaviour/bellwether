/**
 * Prior-calendar-month daily share volume for one NMS stock from two keyless sources:
 * Nasdaq.com historical quotes (consolidated volume, primary) and Yahoo's chart API (cross-check).
 * Reuses the rehearsal's fetchers. A source that fails is null with its error recorded — its
 * values are never filled in from the other source.
 */
import { fetchNasdaqDaily, fetchYahooDaily } from "../rehearsal/volume.js"
import { priorMonth } from "../rehearsal/constants.js"
import { DISAGREEMENT_THRESHOLD_PCT } from "./config.js"

export type VolumeSource = "nasdaq" | "yahoo"

export interface SourceVolume {
  name: string
  url: string
  fetchedAt: string
  days: number
  totalShares: number
  adv: number
  firstDate: string
  lastDate: string
}

export interface MonthVolume {
  symbol: string
  month: string
  from: string
  to: string
  primary: VolumeSource | null
  nasdaq: SourceVolume | null
  yahoo: SourceVolume | null
  missing: VolumeSource[]
  /** The primary source's trading days (the days averaged), with both sources' volumes. */
  days: { date: string; nasdaq: number | null; yahoo: number | null }[]
  crossCheck: { disagreementPct: number; flagged: boolean; thresholdPct: number } | null
  sources: { source: VolumeSource; name: string; url: string; fetchedAt: string }[]
  errors: string[]
}

function summarize(daily: Map<string, number>, source: { name: string; url: string; fetchedAt: string }, label: string): SourceVolume {
  for (const [date, v] of daily) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${label} volume for ${date} is not a whole share count: ${v}`)
  }
  const dates = [...daily.keys()].sort()
  const totalShares = [...daily.values()].reduce((a, b) => a + b, 0)
  return { ...source, days: dates.length, totalShares, adv: totalShares / dates.length, firstDate: dates[0], lastDate: dates[dates.length - 1] }
}

/** Month of trade date YYYY-MM-DD → the prior calendar month's bars from both sources. */
export async function fetchMonthVolume(symbol: string, tradeDate: string, fetchImpl: typeof fetch = fetch): Promise<MonthVolume> {
  const month = priorMonth(new Date(`${tradeDate}T00:00:00Z`))
  const errors: string[] = []
  const attempt = async <T>(label: VolumeSource, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run()
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }
  const nasdaqRaw = await attempt("nasdaq", () => fetchNasdaqDaily(symbol, month.from, month.to, fetchImpl))
  const yahooRaw = await attempt("yahoo", () => fetchYahooDaily(symbol, month.period1, month.period2, month.from, month.to, fetchImpl))
  const nasdaq = nasdaqRaw ? await attempt("nasdaq", async () => summarize(nasdaqRaw.daily, nasdaqRaw.source, "Nasdaq")) : null
  const yahoo = yahooRaw ? await attempt("yahoo", async () => summarize(yahooRaw.daily, yahooRaw.source, "Yahoo")) : null

  const missing: VolumeSource[] = []
  if (!nasdaq) missing.push("nasdaq")
  if (!yahoo) missing.push("yahoo")
  const primary: VolumeSource | null = nasdaq ? "nasdaq" : yahoo ? "yahoo" : null
  const primaryDaily = nasdaq ? nasdaqRaw!.daily : yahoo ? yahooRaw!.daily : new Map<string, number>()
  const days = [...primaryDaily.keys()].sort().map((date) => ({
    date,
    nasdaq: nasdaq ? nasdaqRaw!.daily.get(date) ?? null : null,
    yahoo: yahoo ? yahooRaw!.daily.get(date) ?? null : null,
  }))
  const disagreementPct = nasdaq && yahoo ? (Math.abs(nasdaq.adv - yahoo.adv) / nasdaq.adv) * 100 : null
  const sources = [
    ...(nasdaq ? [{ source: "nasdaq" as const, name: nasdaq.name, url: nasdaq.url, fetchedAt: nasdaq.fetchedAt }] : []),
    ...(yahoo ? [{ source: "yahoo" as const, name: yahoo.name, url: yahoo.url, fetchedAt: yahoo.fetchedAt }] : []),
  ]
  return {
    symbol, month: month.key, from: month.from, to: month.to, primary, nasdaq, yahoo, missing, days,
    crossCheck: disagreementPct === null ? null : { disagreementPct, flagged: disagreementPct > DISAGREEMENT_THRESHOLD_PCT, thresholdPct: DISAGREEMENT_THRESHOLD_PCT },
    sources, errors,
  }
}

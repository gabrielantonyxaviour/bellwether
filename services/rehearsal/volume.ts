/**
 * Tier-2 daily share budget = 2.5% × prior-month average daily share volume (ADSV).
 * Nasdaq.com historical quotes (consolidated volume) are primary; Yahoo's chart API is the
 * cross-check, and a disagreement above 1% is flagged. The tier is inferred and labelled so.
 */
import { DISAGREEMENT_THRESHOLD_PCT, SYMBOL, TIER_LABEL, TIER_PERCENT, priorMonth } from "./constants.js"
import { getJson } from "./http.js"
import { etDate, fromUsDate } from "./time.js"
import type { Budget, Source } from "./schema.js"

interface NasdaqHistorical { data: { tradesTable: { rows: { date: string; volume: string }[] | null } } | null; status?: { rCode: number } }
interface YahooChart { chart: { result: { timestamp?: number[]; indicators: { quote: { volume: (number | null)[] }[] } }[] | null; error: unknown } }

export async function fetchNasdaqDaily(symbol: string, from: string, to: string, fetchImpl?: typeof fetch): Promise<{ daily: Map<string, number>; source: Source }> {
  const url = `https://api.nasdaq.com/api/quote/${symbol}/historical?assetclass=stocks&fromdate=${from}&todate=${to}&limit=40`
  const { body, fetchedAt } = await getJson<NasdaqHistorical>(url, fetchImpl)
  const rows = body.data?.tradesTable.rows ?? []
  const daily = new Map<string, number>()
  for (const row of rows) {
    const date = fromUsDate(row.date)
    const volume = Number(row.volume.replace(/,/g, ""))
    if (date >= from && date <= to && Number.isFinite(volume)) daily.set(date, volume)
  }
  if (daily.size === 0) throw new Error(`Nasdaq returned no ${symbol} rows for ${from}..${to}`)
  return { daily, source: { name: "Nasdaq.com historical quotes API (consolidated daily share volume)", url, fetchedAt } }
}

export async function fetchYahooDaily(symbol: string, period1: number, period2: number, from: string, to: string, fetchImpl?: typeof fetch): Promise<{ daily: Map<string, number>; source: Source }> {
  const path = `/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`
  let fetched: Awaited<ReturnType<typeof getJson<YahooChart>>>
  try {
    fetched = await getJson<YahooChart>(`https://query1.finance.yahoo.com${path}`, fetchImpl)
  } catch {
    fetched = await getJson<YahooChart>(`https://query2.finance.yahoo.com${path}`, fetchImpl)
  }
  const { body, fetchedAt, url } = fetched
  const result = body.chart.result?.[0]
  const stamps = result?.timestamp ?? []
  const volumes = result?.indicators.quote[0]?.volume ?? []
  const daily = new Map<string, number>()
  stamps.forEach((t, i) => {
    const date = etDate(new Date(t * 1000))
    const v = volumes[i]
    if (v != null && date >= from && date <= to) daily.set(date, v)
  })
  if (daily.size === 0) throw new Error(`Yahoo returned no ${symbol} volume for ${from}..${to}`)
  return { daily, source: { name: "Yahoo Finance chart API (daily volume, cross-check)", url, fetchedAt } }
}

const average = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0) / m.size

export async function computeBudget(options: { now: Date; multiplier: number; decimals: number; symbol?: string; fetchImpl?: typeof fetch }): Promise<Budget> {
  const symbol = options.symbol ?? SYMBOL
  const month = priorMonth(options.now)
  const errors: string[] = []
  const sources: Source[] = []
  const settle = async <T>(p: Promise<T>): Promise<T | null> => p.catch((e) => { errors.push(String(e instanceof Error ? e.message : e)); return null })
  const nasdaq = await settle(fetchNasdaqDaily(symbol, month.from, month.to, options.fetchImpl))
  const yahoo = await settle(fetchYahooDaily(symbol, month.period1, month.period2, month.from, month.to, options.fetchImpl))
  if (nasdaq) sources.push(nasdaq.source)
  if (yahoo) sources.push(yahoo.source)

  const nasdaqAdv = nasdaq ? average(nasdaq.daily) : null
  const yahooAdv = yahoo ? average(yahoo.daily) : null
  const primary = nasdaq ? "nasdaq" : yahoo ? "yahoo" : null
  const adv = nasdaqAdv ?? yahooAdv
  const disagreementPct = nasdaqAdv !== null && yahooAdv !== null ? (Math.abs(nasdaqAdv - yahooAdv) / nasdaqAdv) * 100 : null
  const budget = adv === null ? null : adv * (TIER_PERCENT / 100)
  // Caps are enforced on raw units: shares ÷ scaled-UI multiplier × 10^decimals, rounded down.
  const raw = budget === null ? null : BigInt(Math.floor((budget / options.multiplier) * 10 ** options.decimals)).toString()
  const dates = [...new Set([...(nasdaq?.daily.keys() ?? []), ...(yahoo?.daily.keys() ?? [])])].sort()
  if (sources.length === 0) sources.push({ name: "Nasdaq.com / Yahoo (both unreachable)", url: `https://api.nasdaq.com/api/quote/${symbol}/historical`, fetchedAt: new Date().toISOString() })

  return {
    status: nasdaq && yahoo ? "complete" : adv !== null ? "partial" : "unavailable",
    symbol, tier: "Tier 2", tierLabel: TIER_LABEL, tierPercent: TIER_PERCENT, month: month.key, primary,
    tradingDays: primary === "nasdaq" ? nasdaq!.daily.size : primary === "yahoo" ? yahoo!.daily.size : null,
    averageDailyShareVolume: adv, dailyShareBudget: budget, dailyShareBudgetRaw: raw, multiplierUsed: options.multiplier,
    crossCheck: {
      nasdaqAdv, nasdaqDays: nasdaq?.daily.size ?? null, yahooAdv, yahooDays: yahoo?.daily.size ?? null,
      disagreementPct, flagged: disagreementPct === null ? null : disagreementPct > DISAGREEMENT_THRESHOLD_PCT, thresholdPct: DISAGREEMENT_THRESHOLD_PCT,
    },
    daily: dates.map((date) => ({ date, nasdaq: nasdaq?.daily.get(date) ?? null, yahoo: yahoo?.daily.get(date) ?? null })),
    sources, errors,
  }
}

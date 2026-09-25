/** Bounded Yahoo Finance chart reader for the underlying FWDI stock. */
import { z } from "zod"

const quote = z.object({
  open: z.array(z.number().nullable()), high: z.array(z.number().nullable()),
  low: z.array(z.number().nullable()), close: z.array(z.number().nullable()),
  volume: z.array(z.number().nullable()),
})
const chart = z.object({ chart: z.object({
  result: z.array(z.object({
    meta: z.object({ symbol: z.literal("FWDI") }).passthrough(),
    timestamp: z.array(z.number().int()),
    indicators: z.object({ quote: z.array(quote).min(1) }).passthrough(),
  }).passthrough()).min(1),
  error: z.null(),
}) })

export type MarketChart = z.infer<typeof chart>
export type MarketRange = "1mo" | "3mo" | "6mo" | "1y"

export function createMarketReader(fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<MarketRange, { until: number; body: MarketChart }>()
  return async (range: MarketRange): Promise<MarketChart> => {
    const saved = cache.get(range)
    if (saved && saved.until > now()) return saved.body
    const path = `/v8/finance/chart/FWDI?range=${range}&interval=1d`
    for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
      try {
        const response = await fetchImpl(`https://${host}${path}`, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) continue
        const length = Number(response.headers.get("content-length") ?? 0)
        if (length > 2_000_000) continue
        const text = await response.text()
        if (text.length > 2_000_000) continue
        const parsed = chart.safeParse(JSON.parse(text))
        if (!parsed.success || parsed.data.chart.result[0].timestamp.length === 0) continue
        cache.set(range, { body: parsed.data, until: now() + 5 * 60_000 })
        return parsed.data
      } catch {
        // Try Yahoo's second chart host before reporting an unavailable feed.
      }
    }
    throw new Error("market feed unavailable")
  }
}

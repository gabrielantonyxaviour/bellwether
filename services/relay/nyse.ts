/**
 * NYSE's public current trade halts (https://www.nyse.com/api/trade-halts/current): all US
 * listings, reasons as text ("News Pending", "LULD pause"), Eastern dates and times. The relay
 * uses it as a cross-check of the Nasdaq feed and, only when explicitly enabled, as a fallback
 * source for a cycle whose Nasdaq poll failed.
 */
import { z } from "zod"
import { etToUtcMs } from "./et.js"
import { BROWSER_UA, FeedUnavailable, type HaltItem } from "./feed.js"

export const NYSE_CURRENT_URL = "https://www.nyse.com/api/trade-halts/current"

const nullableText = z.string().nullable().optional()
const nyseSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  results: z.object({
    lastUpdatedTime: z.string().nullable().optional(),
    tradeHalts: z.array(z.object({
      formatedHaltDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      formatedHaltTime: z.string().min(1),
      symbol: z.string().min(1),
      issuerName: nullableText,
      sourceExchange: nullableText,
      reason: nullableText,
      formatedResumptionDate: nullableText,
      formatedResumptionTime: nullableText,
    })),
  }),
})

/** NYSE rows as HaltItems. The reason is text, so reasonCode carries NYSE's words, trimmed to 8 bytes on chain. */
export function parseNyseCurrent(json: unknown): HaltItem[] {
  const parsed = nyseSchema.safeParse(json)
  if (!parsed.success) throw new FeedUnavailable("malformed", `not NYSE current trade halts: ${parsed.error.issues[0]?.message ?? "invalid"}`)
  return parsed.data.results.tradeHalts.map((h) => {
    const resumedAt = h.formatedResumptionDate && h.formatedResumptionTime ? etToUtcMs(h.formatedResumptionDate, h.formatedResumptionTime) : null
    return {
      symbol: h.symbol, issueName: h.issuerName ?? null, market: h.sourceExchange ?? null,
      reasonCode: h.reason ?? "", pauseThresholdPrice: null, haltDate: h.formatedHaltDate,
      haltAt: etToUtcMs(h.formatedHaltDate, h.formatedHaltTime), resumedAt, resumptionQuoteAt: null,
    }
  })
}

export async function fetchNyseCurrent(url = NYSE_CURRENT_URL, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<HaltItem[]> {
  let response: Response
  try {
    response = await fetchImpl(url, { headers: { "user-agent": BROWSER_UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new FeedUnavailable("network", `GET ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new FeedUnavailable("http", `GET ${url}: HTTP ${response.status}`)
  let json: unknown
  try { json = await response.json() } catch { throw new FeedUnavailable("not-rss", `GET ${url}: body is not JSON`) }
  return parseNyseCurrent(json)
}

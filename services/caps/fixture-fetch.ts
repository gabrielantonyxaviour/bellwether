/**
 * Replays recorded API responses as a `fetch`, so the caps check is deterministic and offline.
 * Unknown symbols get the real "not found" answers Nasdaq (200, data null) and Yahoo (404) gave
 * on 2026-09-25; a source marked missing answers HTTP 403 (a hard failure with no retry).
 * Any URL outside the three sources throws, so a replayed run cannot reach the network.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

const recorded = z.object({ url: z.string().url(), status: z.number(), contentType: z.string().nullable(), body: z.unknown() })
const fixtureSchema = z.object({
  recordedAt: z.string(),
  symbol: z.string(),
  month: z.string(),
  responses: z.object({
    nasdaq: recorded,
    yahoo: recorded,
    ishares: z.object({ status: z.number(), contentType: z.string(), bodyPrefix: z.string(), note: z.string() }),
  }),
})
export type Fixture = z.infer<typeof fixtureSchema>

export function loadFixture(name: string): Fixture {
  return fixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")))
}

export interface ReplayOptions {
  missing?: ("nasdaq" | "yahoo" | "ishares")[]
  /** Multiply every Yahoo volume, to exercise the disagreement flag. */
  yahooScale?: number
  /** Serve these holdings files instead of the recorded HTML page. */
  ishares?: { ivv: string; iwb: string }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export function fixtureFetch(fixture: Fixture, options: ReplayOptions = {}): typeof fetch {
  const missing = new Set(options.missing ?? [])
  const nasdaqUrl = new URL(fixture.responses.nasdaq.url)
  const yahooUrl = new URL(fixture.responses.yahoo.url)
  const replay = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.host === "api.nasdaq.com") {
      if (missing.has("nasdaq")) return new Response("forbidden (simulated outage)", { status: 403 })
      if (url.pathname === nasdaqUrl.pathname && url.search === nasdaqUrl.search) return json(fixture.responses.nasdaq.body)
      return json({ data: null, message: null, status: { rCode: 400, bCodeMessage: [{ code: 1001, errorMessage: "Symbol not exists." }], developerMessage: null } })
    }
    if (url.host === "query1.finance.yahoo.com" || url.host === "query2.finance.yahoo.com") {
      if (missing.has("yahoo")) return new Response("forbidden (simulated outage)", { status: 403 })
      if (url.pathname === yahooUrl.pathname && url.search === yahooUrl.search) {
        const body = structuredClone(fixture.responses.yahoo.body) as { chart: { result: { indicators: { quote: { volume: (number | null)[] }[] } }[] } }
        const scale = options.yahooScale
        if (scale) for (const q of body.chart.result[0].indicators.quote) q.volume = q.volume.map((v) => (v === null ? null : Math.round(v * scale)))
        return json(body)
      }
      return json({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }, 404)
    }
    if (url.host === "www.ishares.com") {
      if (missing.has("ishares")) return new Response("forbidden (simulated outage)", { status: 403 })
      const custom = options.ishares ? (url.search.includes("IVV_") ? options.ishares.ivv : options.ishares.iwb) : null
      const r = fixture.responses.ishares
      return new Response(custom ?? r.bodyPrefix, { status: r.status, headers: { "content-type": r.contentType } })
    }
    throw new Error(`fixture fetch: no recorded response for ${url.host}${url.pathname}`)
  }
  return replay as typeof fetch
}

/**
 * A holdings file in the iShares CSV layout (preamble, header row, quoted equity rows, then a
 * disclaimer), padded with filler tickers to `rows` equities. The real files were not reachable
 * when this block was built, so this sample exercises the parser rather than replaying a download.
 */
export function ishareSampleCsv(tickers: string[], rows: number): string {
  const lines = [
    "iShares Sample Fund", 'Fund Holdings as of,"Sep 24, 2026"', 'Inception Date,"May 15, 2000"', 'Shares Outstanding,"1,000,000"', " ",
    "Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency,Accrual Date",
  ]
  const all = [...tickers, ...Array.from({ length: Math.max(0, rows - tickers.length) }, (_, i) => `F${String(i).padStart(4, "0")}`)]
  for (const t of all) lines.push(`"${t}","${t} INC","Information Technology","Equity","1,000.00","0.10","1,000.00","10.00","100.00","United States","NASDAQ","USD","1.00","USD","-"`)
  lines.push('"XTSLA","BLK CSH FND TREASURY SL AGENCY","Cash and/or Derivatives","Money Market","1.00","0.01","1.00","1.00","1.00","United States","-","USD","1.00","USD","-"')
  lines.push(" ", '"The content contained herein is owned or licensed by BlackRock."')
  return lines.join("\n")
}

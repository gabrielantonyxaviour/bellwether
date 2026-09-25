/**
 * The Nasdaq Trader trade-halt RSS (https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts).
 *
 * RSS 2.0 with the `ndaq` namespace; each <item> is one halt: HaltDate (MM/DD/YYYY), HaltTime
 * (Eastern, HH:MM:SS[.mmm]), IssueSymbol, IssueName, Market, ReasonCode, PauseThresholdPrice,
 * ResumptionDate / ResumptionQuoteTime / ResumptionTradeTime (empty while still halted).
 * Unresumed items stay in the feed indefinitely, so an old unresumed halt is still a halt.
 *
 * The feed sits behind an Imperva/Incapsula WAF that sometimes answers with a bot challenge.
 * Anything that is not a complete RSS document is a FAILED poll (FeedUnavailable), never
 * "no halts": the relay then skips that cycle's heartbeat and the program fails closed.
 */
import { etToUtcMs, fromUsDate } from "./et.js"

export const NASDAQ_HALTS_URL = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts"
/** Nasdaq Trader serves automated clients less reliably; a browser user agent is accepted. */
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

export interface HaltItem {
  symbol: string
  issueName: string | null
  market: string | null
  reasonCode: string
  pauseThresholdPrice: string | null
  /** YYYY-MM-DD (Eastern). */
  haltDate: string
  /** Halt instant, unix ms. */
  haltAt: number
  /** Trading resumption instant (ResumptionTradeTime), unix ms; null while halted. */
  resumedAt: number | null
  resumptionQuoteAt: number | null
}

export type FeedFailure = "challenge" | "not-rss" | "malformed" | "http" | "network"

export class FeedUnavailable extends Error {
  constructor(readonly kind: FeedFailure, message: string) {
    super(message)
    this.name = "FeedUnavailable"
  }
}

function tag(item: string, name: string): string | null {
  const m = item.match(new RegExp(`<ndaq:${name}>([^<]*)</ndaq:${name}>`))
  const value = m?.[1].trim()
  return value ? value : null
}

function instant(date: string | null, time: string | null): number | null {
  return date && time ? etToUtcMs(fromUsDate(date), time) : null
}

export function parseHaltFeed(body: string): { publishedAt: string | null; items: HaltItem[] } {
  if (/_Incapsula_Resource|Incapsula incident/i.test(body)) throw new FeedUnavailable("challenge", "Nasdaq Trader answered with a bot challenge, not RSS")
  if (!/<rss[\s>]/.test(body) || !/<\/channel>\s*<\/rss>\s*$/.test(body)) throw new FeedUnavailable("not-rss", "response is not a complete RSS document")
  const blocks = body.match(/<item>[\s\S]*?<\/item>/g) ?? []
  const declared = body.match(/<ndaq:numItems>(\d+)<\/ndaq:numItems>/)
  if (!declared || Number(declared[1]) !== blocks.length) {
    throw new FeedUnavailable("malformed", `feed declares ${declared?.[1] ?? "no"} items but carries ${blocks.length}`)
  }
  const items: HaltItem[] = []
  for (const block of blocks) {
    const symbol = tag(block, "IssueSymbol")
    const haltDate = tag(block, "HaltDate")
    const haltTime = tag(block, "HaltTime")
    if (!symbol || !haltDate || !haltTime) throw new FeedUnavailable("malformed", "an item lacks IssueSymbol, HaltDate or HaltTime")
    const resumeDate = tag(block, "ResumptionDate")
    try {
      items.push({
        symbol, issueName: tag(block, "IssueName"), market: tag(block, "Market"),
        reasonCode: tag(block, "ReasonCode") ?? "", pauseThresholdPrice: tag(block, "PauseThresholdPrice"),
        haltDate: fromUsDate(haltDate), haltAt: instant(haltDate, haltTime)!,
        resumedAt: instant(resumeDate, tag(block, "ResumptionTradeTime")),
        resumptionQuoteAt: instant(resumeDate, tag(block, "ResumptionQuoteTime")),
      })
    } catch (error) {
      throw new FeedUnavailable("malformed", `item ${symbol}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const pub = body.match(/<channel>[\s\S]*?<pubDate>([^<]+)<\/pubDate>/)
  return { publishedAt: pub ? new Date(pub[1]).toISOString() : null, items }
}

export interface SymbolHaltState {
  halted: boolean
  /** The symbol's most recent halt item, if any. */
  item: HaltItem | null
}

/**
 * A symbol is halted when its most recent item has no resumption yet, or a resumption that has
 * not arrived by `nowMs`. No item at all means not halted.
 */
export function haltStateFor(items: readonly HaltItem[], symbol: string, nowMs: number): SymbolHaltState {
  let latest: HaltItem | null = null
  for (const item of items) if (item.symbol === symbol && (!latest || item.haltAt > latest.haltAt)) latest = item
  if (!latest) return { halted: false, item: null }
  return { halted: latest.resumedAt === null || nowMs < latest.resumedAt, item: latest }
}

/** One GET of the feed. HTTP and network failures become FeedUnavailable too. */
export async function fetchHaltFeed(url = NASDAQ_HALTS_URL, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl(url, { headers: { "user-agent": BROWSER_UA, accept: "application/rss+xml, text/xml" }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new FeedUnavailable("network", `GET ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body = await response.text()
  if (!response.ok) throw new FeedUnavailable(/_Incapsula_Resource/.test(body) ? "challenge" : "http", `GET ${url}: HTTP ${response.status}`)
  return body
}

/**
 * Two free halt sources for Nasdaq-listed stocks:
 *  - NYSE's public historical trade-halt CSV (all US listings, filterable by symbol and date range);
 *  - the official Nasdaq Trader trade-halt RSS for one date (`haltdate=MMDDYYYY`). It sits behind an
 *    Incapsula WAF that sometimes answers automated clients with a bot challenge instead of RSS;
 *    that is detected and reported, never parsed as "no halts".
 * All times in both sources are US Eastern.
 */
import { HALT_SYMBOLS } from "./constants.js"
import { getText } from "./http.js"
import { etToUtc, fromUsDate, toHaltDateParam } from "./time.js"
import type { Halt, Source } from "./schema.js"

/** Parse one CSV line with RFC 4180 quoting ("" is a literal quote). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ",") { out.push(field); field = "" }
    else field += c
  }
  out.push(field)
  return out
}

/** NYSE CSV rows → halts, one per (symbol, halt instant), preferring the row that has a resumption. */
export function parseNyseHaltCsv(csv: string): Halt[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0 || !/^Halt Date,Halt Time,Symbol/i.test(lines[0])) throw new Error("not an NYSE trade-halt CSV")
  const byKey = new Map<string, Halt>()
  for (const line of lines.slice(1)) {
    const [date, time, symbol, , exchange, reason, resumeDate, resumeTime] = parseCsvLine(line)
    if (!date || !time || !symbol) continue
    const halt: Halt = {
      symbol, reason: reason ?? "", exchange: exchange || null, date, source: "nyse-history",
      haltAt: etToUtc(date, time).toISOString(),
      resumedAt: resumeDate && resumeTime ? etToUtc(resumeDate, resumeTime).toISOString() : null,
    }
    const key = `${symbol}|${halt.haltAt}`
    const existing = byKey.get(key)
    if (!existing || (existing.resumedAt === null && halt.resumedAt !== null)) byKey.set(key, halt)
  }
  return [...byKey.values()].sort((a, b) => b.haltAt.localeCompare(a.haltAt))
}

export async function fetchNyseHaltHistory(symbol: string, from: string, to: string, fetchImpl?: typeof fetch): Promise<{ halts: Halt[]; source: Source }> {
  const url = `https://www.nyse.com/api/trade-halts/historical/download?symbol=${symbol}&haltDateFrom=${from}&haltDateTo=${to}`
  const { body, fetchedAt } = await getText(url, fetchImpl, 2)
  const halts = parseNyseHaltCsv(body).filter((h) => h.symbol === symbol)
  return { halts, source: { name: `NYSE historical trade-halt CSV for ${symbol} (covers Nasdaq-listed halts)`, url, fetchedAt } }
}

const tag = (item: string, name: string): string | null => {
  const match = item.match(new RegExp(`<ndaq:${name}>([^<]*)</ndaq:${name}>`))
  return match && match[1].trim().length > 0 ? match[1].trim() : null
}

export function parseHaltRss(xml: string, symbols: readonly string[] = HALT_SYMBOLS): { items: number; halts: Halt[] } {
  if (/_Incapsula_Resource/.test(xml)) throw new Error("Nasdaq Trader answered with an Incapsula bot challenge, not RSS")
  if (!/<rss[\s>]/.test(xml)) throw new Error("response is not RSS")
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? []
  const halts: Halt[] = []
  for (const item of items) {
    const symbol = tag(item, "IssueSymbol")
    const haltDate = tag(item, "HaltDate")
    const haltTime = tag(item, "HaltTime")
    if (!symbol || !symbols.includes(symbol) || !haltDate || !haltTime) continue
    const resumeDate = tag(item, "ResumptionDate")
    const resumeTime = tag(item, "ResumptionTradeTime")
    halts.push({
      symbol, reason: tag(item, "ReasonCode") ?? "", exchange: tag(item, "Mkt") ?? tag(item, "Market"),
      date: fromUsDate(haltDate), source: "nasdaqtrader-rss",
      haltAt: etToUtc(fromUsDate(haltDate), haltTime).toISOString(),
      resumedAt: resumeDate && resumeTime ? etToUtc(fromUsDate(resumeDate), resumeTime).toISOString() : null,
    })
  }
  return { items: items.length, halts }
}

export async function fetchNasdaqTraderHalts(date: string, fetchImpl?: typeof fetch): Promise<{ items: number; halts: Halt[]; source: Source }> {
  const url = `https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts&haltdate=${toHaltDateParam(date)}`
  const { body, fetchedAt } = await getText(url, fetchImpl, 1)
  const parsed = parseHaltRss(body)
  return { ...parsed, source: { name: `Nasdaq Trader trade-halt RSS for ${date} (official)`, url, fetchedAt } }
}

/**
 * Halt-overlap audit: did any on-chain FWDI market event happen while the underlying stock was
 * halted? Halt history for both tickers (FWDI, formerly FORD) comes from NYSE's historical halt
 * CSV; the official Nasdaq Trader RSS is queried for the event dates as a cross-check. A control
 * halt (FORD LULD pause, 2025-09-12) proves the history can see this stock's halts at all.
 */
import { HALT_SYMBOLS } from "./constants.js"
import { signaturesFor, toIso } from "./accounts.js"
import { fetchNasdaqTraderHalts, fetchNyseHaltHistory } from "./halt-sources.js"
import type { RpcClient } from "./rpc.js"
import { etDate } from "./time.js"
import type { Activity, Halt, HaltAudit, Markets, Source } from "./schema.js"

export const CONTROL_HALT = { date: "2025-09-12", symbol: "FORD", time: "09:31:55 ET", reason: /LULD|LUDP/ } as const
const MAX_CROSS_CHECK_DATES = 6
const RSS_SPACING_MS = 2_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const errorMessage = (e: unknown) => String(e instanceof Error ? e.message : e)

async function marketEvents(rpc: RpcClient, markets: Markets, activity: Activity): Promise<{ events: HaltAudit["events"]; fetchedAt: string | null }> {
  const events: HaltAudit["events"] = []
  let fetchedAt: string | null = null
  for (const market of markets.found) {
    const response = await signaturesFor(rpc, market.address)
    fetchedAt = response.fetchedAt
    for (const s of response.signatures) {
      const at = toIso(s.blockTime)
      if (at && s.err === null) events.push({ signature: s.signature, at, kind: `${market.programName} market transaction` })
    }
  }
  for (const e of activity.entries) {
    if (e.at && e.ok && e.categories.includes("dex-trade") && !events.some((x) => x.signature === e.signature)) {
      events.push({ signature: e.signature, at: e.at, kind: "DEX trade touching FWDI" })
    }
  }
  return { events: events.sort((a, b) => a.at.localeCompare(b.at)), fetchedAt }
}

export async function auditHalts(rpc: RpcClient, options: { now: Date; markets: Markets; activity: Activity; fetchImpl?: typeof fetch }): Promise<HaltAudit> {
  const { events, fetchedAt: eventsFetchedAt } = await marketEvents(rpc, options.markets, options.activity)
  const sources: Source[] = []
  if (eventsFetchedAt) sources.push({ name: "Solana mainnet RPC getSignaturesForAddress (market transactions)", url: rpc.url, method: "getSignaturesForAddress", fetchedAt: eventsFetchedAt })

  const eventDates = [...new Set(events.map((e) => etDate(new Date(e.at))))]
  const firstYear = Math.min(Number(CONTROL_HALT.date.slice(0, 4)), ...eventDates.map((d) => Number(d.slice(0, 4))))
  const from = `${firstYear}-01-01`
  const to = etDate(options.now)
  const halts: Halt[] = []
  const perSymbol: HaltAudit["history"]["perSymbol"] = []
  for (const symbol of HALT_SYMBOLS) {
    try {
      const history = await fetchNyseHaltHistory(symbol, from, to, options.fetchImpl)
      halts.push(...history.halts)
      sources.push(history.source)
      perSymbol.push({ symbol, ok: true, halts: history.halts.length })
    } catch (error) {
      perSymbol.push({ symbol, ok: false, halts: null, error: errorMessage(error) })
    }
  }
  halts.sort((a, b) => b.haltAt.localeCompare(a.haltAt))

  // Cross-check against the official Nasdaq RSS on the event dates and the control date.
  const datesQueried: HaltAudit["crossCheck"]["datesQueried"] = []
  let challenged = false
  let disagreements = 0
  for (const [i, date] of [...new Set([...eventDates.slice(-MAX_CROSS_CHECK_DATES), CONTROL_HALT.date])].entries()) {
    if (challenged) { datesQueried.push({ date, ok: false, items: null, fwdiHalts: null, error: "skipped after a bot challenge" }); continue }
    if (i > 0) await sleep(RSS_SPACING_MS)
    try {
      const rss = await fetchNasdaqTraderHalts(date, options.fetchImpl)
      sources.push(rss.source)
      datesQueried.push({ date, ok: true, items: rss.items, fwdiHalts: rss.halts.length })
      const fromHistory = new Set(halts.filter((h) => h.date === date).map((h) => `${h.symbol}|${h.haltAt}`))
      const fromRss = new Set(rss.halts.map((h) => `${h.symbol}|${h.haltAt}`))
      if (perSymbol.every((p) => p.ok) && (fromHistory.size !== fromRss.size || [...fromRss].some((k) => !fromHistory.has(k)))) disagreements++
      for (const h of rss.halts) if (!halts.some((x) => x.symbol === h.symbol && x.haltAt === h.haltAt)) halts.push(h)
    } catch (error) {
      const message = errorMessage(error)
      challenged = /challenge/i.test(message)
      datesQueried.push({ date, ok: false, items: null, fwdiHalts: null, error: message })
    }
  }
  const rssOk = datesQueried.filter((d) => d.ok).length
  const crossCheck: HaltAudit["crossCheck"] = {
    status: rssOk === 0 ? "unavailable" : disagreements > 0 ? "disagrees" : "agrees",
    datesQueried,
    note: rssOk === 0
      ? "Nasdaq Trader RSS unavailable from this network (see errors); the NYSE history stands alone"
      : `${rssOk} date(s) checked against the official Nasdaq RSS; ${disagreements} disagreement(s)`,
  }

  const controlFound = halts.some((h) => h.date === CONTROL_HALT.date && h.symbol === CONTROL_HALT.symbol && CONTROL_HALT.reason.test(h.reason))
  const overlaps: HaltAudit["overlaps"] = []
  for (const event of events) {
    const t = Date.parse(event.at)
    for (const halt of halts) {
      if (t >= Date.parse(halt.haltAt) && (halt.resumedAt === null ? etDate(new Date(t)) === halt.date : t <= Date.parse(halt.resumedAt))) {
        overlaps.push({ signature: event.signature, at: event.at, halt })
      }
    }
  }
  const okSymbols = perSymbol.filter((p) => p.ok).length
  const status = okSymbols === perSymbol.length ? "complete" : okSymbols > 0 || rssOk > 0 ? "partial" : "unavailable"
  if (sources.length === 0) sources.push({ name: "NYSE / Nasdaq Trader halt sources (unreachable)", url: "https://www.nyse.com/api/trade-halts/historical/download", fetchedAt: new Date().toISOString() })
  const latest = halts[0] ?? null
  const note = `${halts.length} FWDI/FORD halt(s) ${from}..${to}, latest ${latest ? `${latest.date} (${latest.symbol} ${latest.reason})` : "none"}; `
    + `${events.length} on-chain market event(s), first ${events[0]?.at ?? "none"}; ${overlaps.length} overlap(s). `
    + `Control ${CONTROL_HALT.symbol} halt ${CONTROL_HALT.date} ${CONTROL_HALT.time}: ${controlFound ? "visible" : "NOT visible — treat 'no overlap' as unproven"}.`
  return {
    status, symbols: [...HALT_SYMBOLS], events, history: { from, to, perSymbol }, halts, latestHaltAt: latest?.haltAt ?? null,
    crossCheck, control: { date: CONTROL_HALT.date, expected: `${CONTROL_HALT.symbol} LULD pause at ${CONTROL_HALT.time} on ${CONTROL_HALT.date}`, found: controlFound },
    overlaps, note, sources,
  }
}

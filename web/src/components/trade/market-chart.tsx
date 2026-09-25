import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { CandlestickSeries, createChart, createSeriesMarkers, type CandlestickData, type UTCTimestamp } from "lightweight-charts"
import { z } from "zod"
import { clusterConfig } from "@/lib/cluster"
import type { Print } from "@/lib/api"

const yahooSchema = z.object({ chart: z.object({ result: z.array(z.object({
  timestamp: z.array(z.number()),
  indicators: z.object({ quote: z.array(z.object({
    open: z.array(z.number().nullable()), high: z.array(z.number().nullable()),
    low: z.array(z.number().nullable()), close: z.array(z.number().nullable()),
  })) }),
})).min(1), error: z.unknown().nullable() }) })
export type Candle = CandlestickData<UTCTimestamp>

async function chartResponse(url: string, signal?: AbortSignal): Promise<Candle[]> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Market data returned HTTP ${res.status}`)
  const parsed = yahooSchema.parse(await res.json())
  const result = parsed.chart.result[0]
  const quote = result.indicators.quote[0]
  const candles: Candle[] = []
  result.timestamp.forEach((time, index) => {
    const [open, high, low, close] = [quote.open[index], quote.high[index], quote.low[index], quote.close[index]]
    if ([open, high, low, close].every((n) => n != null && Number.isFinite(n))) {
      candles.push({ time: time as UTCTimestamp, open: open!, high: high!, low: low!, close: close! })
    }
  })
  if (!candles.length) throw new Error("The market feed returned no price history")
  return candles
}

export function useUnderlyingCandles(symbol: string) {
  return useQuery({
    queryKey: ["underlying-candles", symbol],
    queryFn: async ({ signal }) => {
      const path = `/market/${encodeURIComponent(symbol)}?range=6mo&interval=1d`
      try { return await chartResponse(`${clusterConfig().apiBaseUrl}${path}`, signal) }
      catch { return chartResponse(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`, signal) }
    },
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

export function MarketChart({ symbol, prints }: { symbol: string; prints: Print[] }) {
  const host = useRef<HTMLDivElement>(null)
  const candles = useUnderlyingCandles(symbol)
  useEffect(() => {
    if (!host.current || !candles.data?.length) return
    const element = host.current
    const chart = createChart(element, { autoSize: true, height: 340,
      layout: { background: { color: "#ffffff" }, textColor: "#525252", attributionLogo: true },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f5f5f5" } },
      timeScale: { timeVisible: false },
    })
    const series = chart.addSeries(CandlestickSeries, { upColor: "#404040", downColor: "#a3a3a3",
      wickUpColor: "#404040", wickDownColor: "#a3a3a3", borderVisible: false })
    series.setData(candles.data)
    const available = new Set(candles.data.map((candle) => new Date(Number(candle.time) * 1000).toISOString().slice(0, 10)))
    const markers = prints.filter((print) => available.has(print.time.slice(0, 10))).map((print) => ({
      time: candles.data!.find((candle) => new Date(Number(candle.time) * 1000).toISOString().slice(0, 10) === print.time.slice(0, 10))!.time,
      position: print.direction === "buy" ? "belowBar" as const : "aboveBar" as const,
      color: print.direction === "buy" ? "#404040" : "#737373", shape: print.direction === "buy" ? "arrowUp" as const : "arrowDown" as const,
      text: `${print.direction} ${print.size_shares}`,
    })).sort((a, b) => Number(a.time) - Number(b.time))
    createSeriesMarkers(series, markers)
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [candles.data, prints])
  return <section className="rounded-xl border bg-card p-4" aria-label={`${symbol} stock chart`}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{symbol} underlying stock</h2><span className="text-xs text-muted-foreground">Yahoo Finance · daily candles · onchain trades marked</span></div>
    {candles.isPending && <div className="flex h-[340px] items-center justify-center text-sm text-muted-foreground" role="status">Loading market history…</div>}
    {candles.isError && <div className="flex h-[340px] items-center justify-center text-center text-sm text-muted-foreground" role="alert">Market history unavailable: {candles.error.message}</div>}
    {candles.data && <div ref={host} className="h-[340px] min-w-0" />}
  </section>
}

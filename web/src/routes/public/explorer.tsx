import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { useSearchParams } from "react-router"
import { ChainLink } from "@/components/public/chain-link"
import { ageLabel, clampUtcDate, formatShares, utcClock, utcToday, utcWindow } from "@/components/public/format"
import { EmptyBlock, ErrorBlock, LoadingBlock, Panel } from "@/components/public/states"
import { api, queryKeys, useSymbols, type Pair, type Print, type TapeQuery } from "@/lib/api"
import { explorerUrl } from "@/lib/cluster"
import { formatUsd } from "@/lib/format"
import { cn } from "@/lib/utils"

const WINDOW = 30

function chipsFor(pairs: Pair[], symbol: string): Pair[] {
  return symbol ? pairs.filter((pair) => pair.symbol === symbol) : pairs
}

function TapeTable({ prints }: { prints: Print[] }) {
  if (prints.length === 0) {
    return <EmptyBlock title="No prints for this date" detail="The first confirmed swap on this UTC date shows up here. Nothing is filled in while the tape is empty." />
  }
  return (
    <>
    <ul className="grid gap-2 p-3 lg:hidden">
      {prints.map((print) => (
        <li key={`${print.signature}-${print.event_index}`} className="grid grid-cols-2 gap-x-3 gap-y-1 border-b pb-2 text-xs last:border-0">
          <span className="font-mono">{utcClock(print.time)} UTC</span>
          <span className={print.direction === "buy" ? "text-right text-emerald-700" : "text-right text-rose-700"}>{print.direction === "buy" ? "Buy" : "Sell"} · {print.pair}</span>
          <span className="font-mono">${formatUsd(print.price_usd, 4)}</span>
          <span className="text-right font-mono">{formatShares(print.size_shares)} shares · ${formatUsd(print.notional_usd, 2)}</span>
          <ChainLink href={explorerUrl("account", print.pool)} id={print.pool} kind="account" />
          <span className="text-right"><ChainLink href={explorerUrl("tx", print.signature)} id={print.signature} kind="tx" /></span>
        </li>
      ))}
    </ul>
    <div className="hidden max-w-full overflow-x-auto lg:block">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Time (UTC)</th>
            <th className="px-3 py-2 font-medium">Side</th>
            <th className="px-3 py-2 font-medium">Pair</th>
            <th className="px-3 py-2 text-right font-medium">Price (USD)</th>
            <th className="px-3 py-2 text-right font-medium">Shares</th>
            <th className="px-3 py-2 text-right font-medium">Value (USD)</th>
            <th className="px-3 py-2 font-medium">Pool</th>
            <th className="px-3 py-2 font-medium">Signature</th>
          </tr>
        </thead>
        <tbody>
          {prints.map((print) => (
            <tr key={`${print.signature}-${print.event_index}`} className="border-t">
              <td className="px-3 py-1.5 font-mono">{utcClock(print.time)}</td>
              <td className="px-3 py-1.5">
                <span className={cn("rounded-full border px-1.5 py-0.5", print.direction === "buy" ? "text-emerald-700" : "text-rose-700")}>
                  {print.direction === "buy" ? "Buy" : "Sell"}
                </span>
              </td>
              <td className="px-3 py-1.5">{print.pair}</td>
              <td className="px-3 py-1.5 text-right font-mono">{formatUsd(print.price_usd, 4)}</td>
              <td className="px-3 py-1.5 text-right font-mono">{formatShares(print.size_shares)}</td>
              <td className="px-3 py-1.5 text-right font-mono">{formatUsd(print.notional_usd, 2)}</td>
              <td className="px-3 py-1.5">
                <ChainLink href={explorerUrl("account", print.pool)} id={print.pool} kind="account" />
              </td>
              <td className="px-3 py-1.5">
                <ChainLink href={explorerUrl("tx", print.signature)} id={print.signature} kind="tx" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}

export function TapePage() {
  const [params, setParams] = useSearchParams()
  const window = useMemo(() => utcWindow(WINDOW), [])
  const date = clampUtcDate(params.get("date") ?? utcToday(), window)
  const sideParam = params.get("side")
  const side = sideParam === "buy" || sideParam === "sell" ? sideParam : undefined
  const symbol = (params.get("symbol") ?? "").toUpperCase()
  const paused = params.get("live") === "0"
  const historical = date !== utcToday()
  const query: TapeQuery = { date, side, symbol: symbol || undefined }
  const symbols = useSymbols()
  const tape = useQuery({
    queryKey: queryKeys.tape(query),
    queryFn: ({ signal }) => api.tape(query, signal),
    refetchInterval: paused || historical ? false : 5_000,
  })
  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (!value) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }
  const options = symbols.data?.symbols ?? tape.data?.pairs ?? []
  const chipPairs = chipsFor(tape.data?.pairs ?? symbols.data?.symbols ?? [], symbol)
  return (
    <div className="grid min-w-0 gap-4 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Explorer</h1>
          <p className="text-sm text-muted-foreground">Every Bellwether print. No wallet needed.</p>
        </div>
        <button
          type="button"
          className="rounded-full border px-2 py-0.5 text-xs"
          aria-pressed={!paused && !historical}
          onClick={() => set("live", paused ? null : "0")}
        >
          {historical ? "Historical" : paused ? "Paused · resume" : `Live · ${tape.data ? ageLabel(tape.data.generated_at) : "waiting"}`}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {chipPairs.length === 0 && !tape.isPending && <span className="rounded-full border px-2 py-1 text-xs">No pool volume recorded</span>}
        {chipPairs.map((pair) => (
          <span key={pair.pool} className="max-w-full rounded-full border px-2 py-1 text-xs break-words">
            24h volume <span className="font-mono">{formatShares(pair.rolling_24h.shares)} shares · ${formatUsd(pair.rolling_24h.usd, 2)}</span>
            {" · "}
            {pair.eod_pool_size
              ? <>EOD pool {pair.eod_pool_size.date} <span className="font-mono">{formatShares(pair.eod_pool_size.stock_tokens)} {pair.symbol} / ${formatUsd(pair.eod_pool_size.usdc, 2)}</span></>
              : "End-of-day pool size not recorded"}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Symbol
          <select aria-label="Symbol" className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" value={symbol} onChange={(event) => set("symbol", event.target.value || null)}>
            <option value="">All symbols</option>
            {options.map((pair) => <option key={pair.pool} value={pair.symbol}>{pair.symbol}</option>)}
          </select>
        </label>
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Side">
          {(["all", "buy", "sell"] as const).map((value) => (
            <button key={value} type="button" className={cn("rounded px-2 py-1 text-sm", (side ?? "all") === value && "bg-muted")} onClick={() => set("side", value === "all" ? null : value)}>
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Date
          <input
            type="date"
            aria-label="Date, last 30 days"
            className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
            min={window.min}
            max={window.max}
            value={date}
            onChange={(event) => set("date", event.target.value || null)}
          />
        </label>
        <a className="ml-auto text-sm underline" href={api.tapeUrl(query)} target="_blank" rel="noreferrer">JSON</a>
      </div>
      {symbols.isError && <p className="text-xs text-muted-foreground">Symbol list unavailable: {symbols.error.message}</p>}
      <Panel title={`${tape.data?.count ?? "—"} prints · ${date} UTC`}>
        {tape.isPending ? <div className="p-3"><LoadingBlock label="Loading prints" /></div>
          : tape.isError ? <div className="p-3"><ErrorBlock title="The tape is unavailable" error={tape.error} onRetry={() => void tape.refetch()} /></div>
          : <TapeTable prints={tape.data.prints} />}
      </Panel>
    </div>
  )
}

import { useState } from "react"
import { Link, useParams } from "react-router"
import { Badge } from "@/components/ui/badge"
import { MarketChart, useUnderlyingCandles } from "@/components/trade/market-chart"
import { TradePanel } from "@/components/trade/trade-panel"
import { paths } from "@/app/paths"
import { explorerUrl } from "@/lib/cluster"
import { formatUnits, formatUsd } from "@/lib/format"
import { shortAddress } from "@/lib/wallet"
import { MarketLoad, MarketStats, Row, useParticipantMarket, VenueStatus } from "./market-state"

const TABS = ["Trades", "Liquidity", "Positions", "Orders"] as const
const EMPTY_PRINTS: NonNullable<ReturnType<typeof useParticipantMarket>["tape"]["data"]>["prints"] = []
type Tab = (typeof TABS)[number]

export function TradePage() {
  const { symbol = "" } = useParams()
  const market = useParticipantMarket(symbol)
  const [tab, setTab] = useState<Tab>("Trades")
  const underlying = symbol.toUpperCase() === "BWRS" ? "FWDI" : symbol.toUpperCase()
  const candles = useUnderlyingCandles(underlying)
  const last = candles.data?.at(-1)
  const previous = candles.data?.at(-2)
  const change = last && previous ? (last.close - previous.close) / previous.close * 100 : null
  if (!market.pair || !market.chain.data) return <div className="p-4 sm:p-6"><MarketLoad market={market} symbol={symbol} /></div>
  const { pair, chain, tape } = market
  const stock = chain.data.symbol
  const pool = chain.data.pool
  const prints = tape.data?.prints ?? EMPTY_PRINTS
  return <div className="space-y-4 px-4 py-6 sm:px-6">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold">{pair.symbol} / USDC</h1><Badge variant="outline">Permissioned pool</Badge>{stock.halted && <Badge variant="destructive">Halted</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">{pair.symbol === underlying ? "Tokenized stock" : `Tokenized stock following ${underlying}`} · pool {shortAddress(pair.pool, 6)}</p></div><Link to={paths.liquidity(pair.symbol)} className="text-sm underline">Provide liquidity →</Link></header>
    <div className="grid grid-cols-2 gap-2 rounded-xl border p-3 text-sm sm:grid-cols-4"><div><div className="text-xs text-muted-foreground">{underlying} underlying</div><strong>{last ? `$${formatUsd(String(last.close))}` : candles.isPending ? "Loading…" : "Unavailable"}</strong></div><div><div className="text-xs text-muted-foreground">Daily change</div><strong>{change == null ? "Unavailable" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</strong></div><div><div className="text-xs text-muted-foreground">Onchain last price</div><strong>{pair.last_price_usd ? `$${formatUsd(pair.last_price_usd, 4)}` : "No fills"}</strong></div><div><div className="text-xs text-muted-foreground">24h trades</div><strong>{pair.rolling_24h.trades}</strong></div></div>
    <MarketStats pair={pair} market={market} />
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]"><div className="min-w-0 space-y-4">
      <MarketChart symbol={underlying} prints={prints} />
      <section className="rounded-xl border bg-card" aria-label="Market detail tabs"><div className="flex overflow-x-auto border-b p-2" role="tablist">{TABS.map((name) => <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)} className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${tab === name ? "bg-muted font-semibold" : "text-muted-foreground"}`}>{name}</button>)}</div><div className="min-h-40 p-4 text-sm">
        {tab === "Trades" && (tape.isPending ? <p role="status">Loading onchain prints…</p> : tape.isError ? <div role="alert">Tape unavailable: {tape.error.message} <button className="underline" onClick={() => void tape.refetch()}>Retry</button></div> : prints.length ? <div className="overflow-x-auto"><table className="w-full min-w-[480px] text-left"><thead><tr className="text-muted-foreground"><th className="pb-2">Time</th><th>Side</th><th>Price</th><th>Shares</th><th>Transaction</th></tr></thead><tbody>{prints.slice(0, 30).map((print) => <tr className="border-t" key={`${print.signature}-${print.event_index}`}><td className="py-2">{new Date(print.time).toLocaleString()}</td><td>{print.direction}</td><td>${formatUsd(print.price_usd, 4)}</td><td>{print.size_shares}</td><td><a className="font-mono underline" href={explorerUrl("tx", print.signature)} target="_blank" rel="noreferrer">{shortAddress(print.signature)} ↗</a></td></tr>)}</tbody></table></div> : <p className="text-muted-foreground">No onchain trades for {pair.symbol} today. <Link to="/tape" className="underline">Open full tape →</Link></p>)}
        {tab === "Liquidity" && <div className="space-y-2"><p>Pool reserves: {formatUnits(pool.reserveStock, pool.stockDecimals)} {pair.symbol} and {formatUnits(pool.reserveUsdc, pool.usdcDecimals)} USDC.</p><p>Fee: {(pool.feeBps / 100).toFixed(2)}% per swap, retained in the pool.</p><Link className="underline" to={paths.liquidity(pair.symbol)}>Manage liquidity →</Link></div>}
        {tab === "Positions" && (market.wallet.publicKey ? <div className="space-y-2"><p>{pair.symbol} balance: {formatUnits(chain.data.stockBalance ?? 0n, pool.stockDecimals)}</p><p>USDC balance: {formatUnits(chain.data.usdcBalance ?? 0n, pool.usdcDecimals)}</p><p>LP shares: {chain.data.lp ? chain.data.lp.shares.toString() : "No position"}</p></div> : <p className="text-muted-foreground">Connect a wallet to read your token and LP positions.</p>)}
        {tab === "Orders" && <p className="text-muted-foreground">This venue executes swaps immediately. There is no limit order book or pending order to show.</p>}
      </div></section>
    </div><aside className="space-y-4"><TradePanel market={market} /><VenueStatus market={market} /><section className="rounded-xl border bg-card p-4"><h2 className="font-semibold">Tokenized info</h2><dl className="mt-2 text-sm"><Row label="Underlying ticker" value={underlying} /><Row label="Shares per token" value={`${stock.multiplierNum} / ${stock.multiplierDen}`} /><Row label="Tier" value={String(stock.tier)} /><Row label="Stock mint" value={shortAddress(pool.stockMint, 6)} /><Row label="USDC mint" value={shortAddress(pool.usdcMint, 6)} /></dl><a href={explorerUrl("token", pool.stockMint)} className="text-xs underline" target="_blank" rel="noreferrer">Inspect mint ↗</a></section></aside></div>
  </div>
}

import { useState } from "react"
import { Link, useParams } from "react-router"
import { Badge } from "@/components/ui/badge"
import { AddressDisplay } from "@/components/sol/address-display"
import { MarketChart, useUnderlyingCandles } from "@/components/trade/market-chart"
import { TradePrints } from "@/components/trade/trade-prints"
import { TradePanel } from "@/components/trade/trade-panel"
import { paths } from "@/app/paths"
import { explorerUrl } from "@/lib/cluster"
import { formatUnits, formatUsd } from "@/lib/format"
import { shortAddress } from "@/lib/wallet"
import { MarketLoad, Row, shareBudget, useParticipantMarket, VenueStatus, type ParticipantMarket } from "./market-state"

const TABS = ["Trades", "Liquidity", "Positions", "Orders"] as const
type Tab = (typeof TABS)[number]

function MarketHeader({ market, underlying, last, change }: { market: ParticipantMarket; underlying: string; last: number | null; change: number | null }) {
  const { pair, chain } = market
  if (!pair || !chain.data) return null
  const { pool, symbol } = chain.data
  const budget = shareBudget(market)
  const liquidity = Number(formatUnits(pool.reserveUsdc, pool.usdcDecimals)) * 2
  const stats = [
    ["Last pool price", pair.last_price_usd ? `$${formatUsd(pair.last_price_usd, 4)}` : "No fills"],
    ["24h change · FWDI", change == null ? "Unavailable" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`],
    [`${underlying} underlying`, last == null ? "Unavailable" : `$${formatUsd(String(last))}`],
    ["24h volume", `$${formatUsd(pair.rolling_24h.usd)}`],
    ["Pool liquidity", `$${formatUsd(String(liquidity))}`],
    ["Pool fee", `${(pool.feeBps / 100).toFixed(2)}%`],
    ["Budget used", `${formatUnits(budget.used, pool.stockDecimals)} / ${formatUnits(budget.cap, pool.stockDecimals)}`],
  ]
  return <header className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold">{pair.symbol} / USDC</h1><Badge variant="outline">Tokenized stock</Badge>{symbol.halted && <Badge variant="destructive">Halted</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">Permissioned pool · {underlying} underlying · {shortAddress(pair.pool, 6)}</p></div><Link to={paths.liquidity(pair.symbol)} className="text-sm underline">Provide liquidity →</Link></div>
    <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t pt-4 sm:grid-cols-4">{stats.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-semibold tabular-nums" title={value}>{value}</dd></div>)}</dl>
  </header>
}

function MarketTabs({ market, tab, setTab }: { market: ParticipantMarket; tab: Tab; setTab: (tab: Tab) => void }) {
  const { pair, chain, tape, wallet } = market
  if (!pair || !chain.data) return null
  const { pool } = chain.data
  const prints = tape.data?.prints ?? []
  return <section className="rounded-xl border bg-card" aria-label="Market detail tabs"><div className="flex overflow-x-auto border-b p-2" role="tablist" aria-label="Market details">{TABS.map((name) => <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)} className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${tab === name ? "bg-muted font-semibold" : "text-muted-foreground"}`}>{name}</button>)}</div><div className="min-h-44 p-4 text-sm">
    {tab === "Trades" && (tape.isPending ? <p role="status">Loading onchain prints…</p> : tape.isError ? <div role="alert">Tape unavailable: {tape.error.message} <button className="underline" onClick={() => void tape.refetch()}>Retry</button></div> : prints.length ? <TradePrints prints={prints} /> : <p className="text-muted-foreground">No onchain trades for {pair.symbol} today. <Link to={paths.explorer} className="underline">Open full explorer →</Link></p>)}
    {tab === "Liquidity" && <div className="grid gap-3 sm:grid-cols-2"><div><p className="text-muted-foreground">Stock reserve</p><strong>{formatUnits(pool.reserveStock, pool.stockDecimals)} {pair.symbol}</strong></div><div><p className="text-muted-foreground">USDC reserve</p><strong>{formatUnits(pool.reserveUsdc, pool.usdcDecimals)} USDC</strong></div><div><p className="text-muted-foreground">LP supply</p><strong>{pool.lpTotal.toString()} shares</strong></div><div><p className="text-muted-foreground">Swap fee</p><strong>{(pool.feeBps / 100).toFixed(2)}%</strong></div><Link className="underline sm:col-span-2" to={paths.liquidity(pair.symbol)}>Manage liquidity →</Link></div>}
    {tab === "Positions" && (wallet.publicKey ? <div className="grid gap-3 sm:grid-cols-3"><div><p className="text-muted-foreground">{pair.symbol} balance</p><strong>{formatUnits(chain.data.stockBalance ?? 0n, pool.stockDecimals)}</strong></div><div><p className="text-muted-foreground">USDC balance</p><strong>{formatUnits(chain.data.usdcBalance ?? 0n, pool.usdcDecimals)}</strong></div><div><p className="text-muted-foreground">LP shares</p><strong>{chain.data.lp ? chain.data.lp.shares.toString() : "No position"}</strong></div></div> : <p className="text-muted-foreground">Connect a wallet to read your token and LP positions.</p>)}
    {tab === "Orders" && <p className="text-muted-foreground">This pool executes swaps immediately. There is no limit order book or pending order on this venue. Confirmed fills appear under Trades and in the <Link to={paths.explorer} className="underline">public explorer</Link>.</p>}
  </div></section>
}

function TokenizedInfo({ market, underlying }: { market: ParticipantMarket; underlying: string }) {
  if (!market.chain.data || !market.pair) return null
  const { pool, venue, symbol, authorities } = market.chain.data
  const budget = shareBudget(market)
  const addr = (value: string | null) => value ? <AddressDisplay address={value} href={explorerUrl("account", value)} /> : <span>None</span>
  return <section className="rounded-xl border bg-card p-4" aria-label="Tokenized stock info"><h2 className="font-semibold">Tokenized stock info</h2><dl className="mt-2 text-sm">
    <Row label="Underlying" value={`${underlying} · Nasdaq`} />
    <Row label="Shares per token" value={`${symbol.multiplierNum} / ${symbol.multiplierDen}`} />
    <Row label="Regulatory tier" value={`Tier ${symbol.tier}`} />
    <Row label="Daily share budget" value={`${formatUnits(budget.cap, pool.stockDecimals)} shares`} />
    <Row label="Halt state" value={symbol.halted ? symbol.haltReason || "Halted" : "Clear"} />
    <Row label="Halt source" value="Nasdaq Trader RSS → onchain relay" />
  </dl><div className="space-y-2 border-t pt-3 text-xs"><div className="flex items-center justify-between gap-2"><span>Stock mint</span>{addr(pool.stockMint)}</div><div className="flex items-center justify-between gap-2"><span>USDC mint</span>{addr(pool.usdcMint)}</div><div className="flex items-center justify-between gap-2"><span>Mint authority</span>{addr(authorities.mintAuthority)}</div><div className="flex items-center justify-between gap-2"><span>Freeze authority</span>{addr(authorities.freezeAuthority)}</div><div className="flex items-center justify-between gap-2"><span>Halt relay</span>{addr(venue.relay)}</div><div className="flex items-center justify-between gap-2"><span>Data authority</span>{addr(venue.dataAuthority)}</div></div><a className="mt-3 inline-block text-xs underline" href="https://www.nasdaqtrader.com/trader.aspx?id=tradehalts" target="_blank" rel="noreferrer">Nasdaq halt feed ↗</a></section>
}

export function TradePage() {
  const { symbol = "" } = useParams()
  const market = useParticipantMarket(symbol)
  const [tab, setTab] = useState<Tab>("Trades")
  const underlying = symbol.toUpperCase() === "BWRS" ? "FWDI" : symbol.toUpperCase()
  const candles = useUnderlyingCandles(underlying)
  const last = candles.data?.at(-1)
  const previous = candles.data?.at(-2)
  const change = last && previous && previous.close ? (last.close - previous.close) / previous.close * 100 : null
  if (!market.pair || !market.chain.data) return <div className="p-4 sm:p-6"><MarketLoad market={market} symbol={symbol} /></div>
  return <div className="space-y-4 px-4 py-6 sm:px-6">
    <MarketHeader market={market} underlying={underlying} last={last?.close ?? null} change={change} />
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_350px]"><div className="min-w-0 space-y-4"><MarketChart symbol={underlying} prints={market.tape.data?.prints ?? []} /><MarketTabs market={market} tab={tab} setTab={setTab} /></div><aside className="space-y-4"><TradePanel market={market} /><VenueStatus market={market} /><TokenizedInfo market={market} underlying={underlying} /></aside></div>
  </div>
}

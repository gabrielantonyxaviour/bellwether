import { Link } from "react-router"
import { useCredential, useSymbols, useTape, type Pair } from "@/lib/api"
import { useMarketAccounts } from "@/lib/wallet-ui/chain"
import { useWallet } from "@/lib/wallet"
import { formatUnits, formatUsd } from "@/lib/format"

export function useParticipantMarket(symbol: string) {
  const wallet = useWallet()
  const symbols = useSymbols()
  const pair = symbols.data?.symbols.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase()) ?? null
  const chain = useMarketAccounts(pair, wallet.publicKey)
  const credential = useCredential(wallet.publicKey)
  const tape = useTape({ symbol: symbol.toUpperCase() })
  return { wallet, symbols, pair, chain, credential, tape }
}

export type ParticipantMarket = ReturnType<typeof useParticipantMarket>

function availableShares(market: ParticipantMarket): bigint {
  const state = market.chain.data
  if (!state) return 0n
  const { symbol, venue, chainTime } = state
  let day = Math.floor(Math.max(0, chainTime - Number(venue.tradeDateCutoff)) / 86_400)
  const weekday = (day + 4) % 7
  if (weekday === 6) day -= 1
  if (weekday === 0) day -= 2
  const traded = symbol.tradeDate === BigInt(day) ? symbol.sharesTradedToday : 0n
  return symbol.capShares > traded ? symbol.capShares - traded : 0n
}

export function MarketLoad({ market, symbol }: { market: ParticipantMarket; symbol: string }) {
  if (market.symbols.isPending) return <StateCard label="Loading available markets from the venue…" />
  if (market.symbols.isError) return <StateCard label={`Venue API unavailable: ${market.symbols.error.message}`} retry={() => void market.symbols.refetch()} />
  if (!market.pair) return <StateCard label={`${symbol} is not listed on this venue.`} />
  if (market.chain.isPending) return <StateCard label="Reading pool and symbol accounts from chain…" />
  if (market.chain.isError) return <StateCard label={`Chain data unavailable: ${market.chain.error.message}`} retry={() => void market.chain.refetch()} />
  return null
}

function StateCard({ label, retry }: { label: string; retry?: () => void }) {
  return <div className="rounded-xl border p-6 text-sm" role="status"><p>{label}</p>{retry && <button onClick={retry} className="mt-3 underline">Retry</button>}</div>
}

export function blockReason(market: ParticipantMarket, forDeposit = false): { title: string; detail: string; action?: string } | null {
  const { chain, credential, wallet } = market
  if (!wallet.publicKey) return { title: "Connect wallet", detail: "A wallet is needed to sign this transaction." }
  if (credential.isPending) return { title: "Checking admission…", detail: "Reading your credential from the issuer." }
  if (credential.isError) return { title: "Admission unavailable", detail: credential.error.message }
  if (credential.data?.status !== "admitted") return { title: "Not admitted · Get admitted", detail: "Program refusal: NotAdmitted", action: "/app/onboard" }
  if (!chain.data) return { title: "Chain data unavailable", detail: "Pool state could not be read." }
  const { symbol, venue } = chain.data
  if (symbol.halted) return { title: forDeposit ? "Halted · withdraw only" : "Halted by Nasdaq", detail: "Program refusal: TradingHalted" }
  const age = chain.data.chainTime - Number(symbol.lastHeartbeat)
  if (age > Number(venue.heartbeatMaxAge)) return { title: "Halt data stale · trading paused", detail: `Program refusal: HaltDataStale · last heartbeat ${age}s ago` }
  if (!symbol.active) return { title: "Market is not active", detail: "Program refusal: NotActive" }
  if (Number(symbol.pausedUntil) > chain.data.chainTime) return { title: "Paused after second breach", detail: `Program refusal: Paused · resumes ${new Date(Number(symbol.pausedUntil) * 1000).toLocaleDateString()}` }
  if (availableShares(market) === 0n) return { title: "Daily cap reached", detail: "Program refusal: CapReached" }
  return null
}

export function VenueStatus({ market }: { market: ParticipantMarket }) {
  const state = market.chain.data
  if (!state) return null
  const { symbol, venue, pool } = state
  const age = Math.max(0, state.chainTime - Number(symbol.lastHeartbeat))
  const budget = formatUnits(availableShares(market), pool.stockDecimals)
  const total = formatUnits(symbol.capShares, pool.stockDecimals)
  const reason = blockReason(market)
  return <section className="rounded-xl border bg-card p-4" aria-label="Venue status">
    <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Venue status</h2><span className="text-xs text-muted-foreground">Onchain SymbolRecord</span></div>
    {reason && <div className="mt-3 rounded-lg border p-3 text-sm"><strong>{reason.title}</strong><p className="mt-1 text-muted-foreground">{reason.detail}</p>{reason.action && <Link to={reason.action} className="underline">Get admitted →</Link>}</div>}
    <dl className="mt-3 grid gap-2 text-sm">
      <Row label="Halt" value={symbol.halted ? `Halted · ${symbol.haltReason || "reason unavailable"}` : "Clear"} />
      <Row label="Heartbeat" value={`${age}s ago · limit ${venue.heartbeatMaxAge}s`} />
      <Row label="Share budget remaining" value={`${budget} / ${total}`} />
      <Row label="Activation" value={symbol.active ? "Active" : "Inactive"} />
      <Row label="Breaches" value={String(symbol.breachCount)} />
      <Row label="Credential" value={market.credential.isPending ? "Checking…" : market.credential.data?.status ?? "Unavailable"} />
    </dl>
  </section>
}

export function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4 border-b py-2 last:border-0"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium">{value}</dd></div>
}

export function MarketStats({ pair, market }: { pair: Pair; market: ParticipantMarket }) {
  const pool = market.chain.data?.pool
  const stats = [
    ["Pool price", pair.last_price_usd ? `$${formatUsd(pair.last_price_usd, 4)}` : "No trades yet"],
    ["24h volume", `$${formatUsd(pair.rolling_24h.usd)}`],
    ["Liquidity", pool ? `$${formatUsd(String(Number(formatUnits(pool.reserveUsdc, pool.usdcDecimals)) * 2))}` : "Unavailable"],
    ["Pool fee", pool ? `${(pool.feeBps / 100).toFixed(2)}%` : "Unavailable"],
  ]
  return <div className="grid grid-cols-2 gap-2 md:grid-cols-4">{stats.map(([label, value]) => <div className="rounded-xl border p-3" key={label}><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-lg font-semibold tabular-nums">{value}</div></div>)}</div>
}

import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useParams } from "react-router"
import type { Address } from "@solana/kit"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { paths } from "@/app/paths"
import { formatUnits, parseUnits } from "@/lib/format"
import { addLiquidityInstruction, removeLiquidityInstruction, withSlippage } from "@/lib/program"
import { useTransaction } from "@/lib/tx"
import { transactionFailureMessage } from "@/lib/wallet-ui/transaction-error"
import { shortAddress } from "@/lib/wallet"
import { blockReason, MarketLoad, MarketStats, Row, useParticipantMarket } from "./market-state"

function sqrt(value: bigint): bigint {
  if (value < 2n) return value
  let next = value
  let previous = (next + 1n) / 2n
  while (previous < next) { next = previous; previous = (value / previous + previous) / 2n }
  return next
}

export function LiquidityPage() {
  const { symbol = "" } = useParams()
  const market = useParticipantMarket(symbol)
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit")
  const [stockAmount, setStockAmount] = useState("")
  const [usdcAmount, setUsdcAmount] = useState("")
  const [percent, setPercent] = useState(25)
  const tx = useTransaction(`${mode === "deposit" ? "Deposit" : "Withdraw"} ${symbol} liquidity`)
  const qc = useQueryClient()
  const state = market.chain.data
  const pool = state?.pool
  const lpShares = state?.lp?.shares ?? 0n
  const halted = state?.symbol.halted ?? false
  const depositBlock = blockReason(market, true)
  const withdrawBlock = !market.wallet.publicKey ? "Connect wallet to withdraw" : market.credential.isPending ? "Checking admission…" : market.credential.data?.status !== "admitted" ? "Valid admission required" : null
  const calc = useMemo(() => {
    if (!pool) return null
    try {
      const stock = parseUnits(stockAmount, pool.stockDecimals)
      const usdc = parseUnits(usdcAmount, pool.usdcDecimals)
      if (stock <= 0n || usdc <= 0n) return null
      const minted = pool.lpTotal === 0n ? sqrt(stock * usdc) :
        pool.reserveStock > 0n && pool.reserveUsdc > 0n ?
          (stock * pool.lpTotal / pool.reserveStock < usdc * pool.lpTotal / pool.reserveUsdc ? stock * pool.lpTotal / pool.reserveStock : usdc * pool.lpTotal / pool.reserveUsdc) : 0n
      const credited = pool.lpTotal === 0n ? minted - 1000n : minted
      return credited > 0n ? { stock, usdc, credited } : null
    } catch { return null }
  }, [stockAmount, usdcAmount, pool])
  const withdraw = pool && lpShares > 0n && pool.lpTotal > 0n ? (() => {
    const shares = lpShares * BigInt(percent) / 100n
    return { shares, stock: shares * pool.reserveStock / pool.lpTotal, usdc: shares * pool.reserveUsdc / pool.lpTotal }
  })() : null
  const setFromStock = (value: string) => {
    setStockAmount(value)
    if (!pool || pool.reserveStock === 0n) return
    try {
      const units = parseUnits(value, pool.stockDecimals)
      const usdc = (units * pool.reserveUsdc + pool.reserveStock - 1n) / pool.reserveStock
      setUsdcAmount(formatUnits(usdc, pool.usdcDecimals))
    } catch { setUsdcAmount("") }
  }
  const setFromUsdc = (value: string) => {
    setUsdcAmount(value)
    if (!pool || pool.reserveUsdc === 0n) return
    try {
      const units = parseUnits(value, pool.usdcDecimals)
      const stock = (units * pool.reserveStock + pool.reserveUsdc - 1n) / pool.reserveUsdc
      setStockAmount(formatUnits(stock, pool.stockDecimals))
    } catch { setStockAmount("") }
  }
  const execute = async () => {
    if (!state || !market.wallet.signer || !state.ownerStock || !state.ownerUsdc || !state.lpAddress || !market.credential.data) return
    const accounts = { ...state.addresses, credential: market.credential.data.credential.address as Address }
    const owner = { owner: market.wallet.signer, ownerStock: state.ownerStock, ownerUsdc: state.ownerUsdc }
    const ix = mode === "deposit" && calc ? addLiquidityInstruction(accounts, owner, { stockMax: calc.stock, usdcMax: calc.usdc, minLp: withSlippage(calc.credited, 50), lp: state.lpAddress }) :
      mode === "withdraw" && withdraw ? removeLiquidityInstruction(accounts, owner, { lpShares: withdraw.shares, minStock: withSlippage(withdraw.stock, 50), minUsdc: withSlippage(withdraw.usdc, 50), lp: state.lpAddress }) : null
    if (!ix) return
    const result = await tx.submit([ix], market.wallet.signer)
    if (result.phase === "confirmed") { void qc.invalidateQueries({ queryKey: ["market-accounts"] }); setStockAmount(""); setUsdcAmount("") }
  }
  if (!market.pair || !pool || !state) return <div className="p-4 sm:p-6"><MarketLoad market={market} symbol={symbol} /></div>
  const pair = market.pair
  const share = pool.lpTotal > 0n ? Number(lpShares * 10_000n / pool.lpTotal) / 100 : 0
  const sufficient = calc && state.stockBalance != null && state.usdcBalance != null && calc.stock <= state.stockBalance && calc.usdc <= state.usdcBalance
  const disabled = tx.busy || (mode === "deposit" ? !!depositBlock || !calc || !sufficient : !!withdrawBlock || !withdraw || withdraw.shares === 0n)
  return <div className="space-y-5 px-4 py-6 sm:px-6"><header className="flex flex-wrap items-start justify-between gap-2"><div><h1 className="text-2xl font-semibold">Provide liquidity</h1><p className="mt-1 text-sm text-muted-foreground">{pair.symbol} / USDC · permissioned, non-transferable LP position</p></div><Link to={paths.trade(pair.symbol)} className="text-sm underline">Back to trade →</Link></header>
    {halted && <div className="rounded-lg border p-3 text-sm" role="status"><strong>Halted: withdraw only.</strong> Nasdaq halt state blocks deposits; your existing position can still be withdrawn.</div>}
    <MarketStats pair={pair} market={market} />
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><section className="space-y-4 rounded-xl border bg-card p-4" aria-label="Liquidity action">
      <div role="tablist" className="flex gap-2">{(["deposit", "withdraw"] as const).map((name) => <Button key={name} role="tab" aria-selected={mode === name} variant={mode === name ? "default" : "outline"} onClick={() => { setMode(name); tx.reset() }}>{name === "deposit" ? "Deposit" : "Withdraw"}</Button>)}</div>
      {mode === "deposit" ? <><div className="space-y-3"><label className="block text-sm">{pair.symbol} amount<input inputMode="decimal" aria-label={`${pair.symbol} amount`} value={stockAmount} onChange={(event) => setFromStock(event.target.value)} className="mt-1 w-full rounded-lg border bg-background p-3 text-lg" /></label><p className="text-xs text-muted-foreground">Balance {state.stockBalance == null ? "Connect wallet" : formatUnits(state.stockBalance, pool.stockDecimals)} {pair.symbol}</p>
        <p className="text-center text-xs text-muted-foreground">Ratio locked to the onchain pool</p><label className="block text-sm">USDC amount<input inputMode="decimal" aria-label="USDC amount" value={usdcAmount} onChange={(event) => setFromUsdc(event.target.value)} className="mt-1 w-full rounded-lg border bg-background p-3 text-lg" /></label><p className="text-xs text-muted-foreground">Balance {state.usdcBalance == null ? "Connect wallet" : formatUnits(state.usdcBalance, pool.usdcDecimals)} USDC</p></div>
        {calc && <p className="text-sm">Estimated LP shares: {calc.credited.toString()} · minimum with 0.5% slippage: {withSlippage(calc.credited, 50).toString()}</p>}
        {calc && !sufficient && <p role="alert" className="text-sm text-destructive">Insufficient token balance for this deposit.</p>}
        {depositBlock && <p className="rounded-lg border p-3 text-sm" role="status">{depositBlock.title} · {depositBlock.detail}</p>}</> : <><div className="rounded-lg border p-4"><div className="flex justify-between"><span>Withdraw</span><strong>{percent}%</strong></div><div className="mt-3 grid grid-cols-4 gap-2">{[25, 50, 75, 100].map((value) => <Button key={value} variant={percent === value ? "default" : "outline"} onClick={() => setPercent(value)}>{value === 100 ? "MAX" : `${value}%`}</Button>)}</div></div><p className="text-sm">Receive {withdraw ? formatUnits(withdraw.stock, pool.stockDecimals) : "0"} {pair.symbol} and {withdraw ? formatUnits(withdraw.usdc, pool.usdcDecimals) : "0"} USDC.</p>{withdrawBlock && <p role="status" className="text-sm">{withdrawBlock}</p>}</>}
      {tx.state.phase === "review" && <div role="group" aria-label={`Review ${mode}`} className="rounded-lg border p-3 text-sm"><strong>Review {mode}</strong><p className="mt-1">{mode === "deposit" ? `${stockAmount} ${pair.symbol} + ${usdcAmount} USDC` : `${percent}% of your LP position`}</p><p className="mt-2 text-muted-foreground">The position belongs to this wallet and cannot be transferred.</p><div className="mt-3 flex gap-2"><Button onClick={() => void execute()}>Confirm {mode}</Button><Button variant="outline" onClick={tx.reset}>Cancel</Button></div></div>}
      {tx.busy && <p role="status">{tx.state.phase === "awaiting-signature" ? "Awaiting wallet signature…" : "Transaction pending on chain…"}</p>}
      {tx.state.phase === "failed" && <p role="alert" className="text-sm text-destructive">{tx.state.venueError ? `Program refusal: ${tx.state.venueError.name}. ` : ""}{transactionFailureMessage(tx.state.error)}</p>}
      {tx.state.phase === "confirmed" && <p role="status">Liquidity {mode} confirmed on chain. {tx.state.explorer && <a href={tx.state.explorer} target="_blank" rel="noreferrer" className="underline">View transaction ↗</a>}</p>}
      <Button className="w-full" disabled={disabled || tx.state.phase === "review"} onClick={tx.review}>{mode === "deposit" ? halted ? "Halted: withdraw only" : "Review deposit" : "Review withdrawal"}</Button>
    </section><div className="space-y-4"><section className="rounded-xl border bg-card p-4"><h2 className="font-semibold">Your position <Badge variant="outline" className="ml-2">Non-transferable</Badge></h2><dl className="mt-3 text-sm"><Row label="LP shares" value={lpShares.toString()} /><Row label="Pool share" value={`${share.toFixed(2)}%`} /><Row label="Claim on stock" value={`${formatUnits(lpShares * pool.reserveStock / (pool.lpTotal || 1n), pool.stockDecimals)} ${pair.symbol}`} /><Row label="Claim on USDC" value={`${formatUnits(lpShares * pool.reserveUsdc / (pool.lpTotal || 1n), pool.usdcDecimals)} USDC`} /><Row label="Position account" value={state.lpAddress ? shortAddress(state.lpAddress, 6) : "Connect wallet"} /></dl></section><div className="rounded-lg border p-4 text-sm text-muted-foreground"><strong className="text-foreground">Covered Firm disclosure.</strong> Deposits form an internal LP record. It cannot be sold or sent; only this wallet can withdraw it. The pool fee stays in reserves and accrues to positions. No unverified fee estimate is shown.</div></div></div>
  </div>
}

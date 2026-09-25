import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"
import type { Address } from "@solana/kit"
import { Button } from "@/components/ui/button"
import { formatUnits, parseUnits } from "@/lib/format"
import { quoteSwap, swapInstruction, SWAP_BUY, SWAP_SELL, withSlippage } from "@/lib/program"
import { useTransaction } from "@/lib/tx"
import { transactionFailureMessage } from "@/lib/wallet-ui/transaction-error"
import type { ParticipantMarket } from "@/routes/app/market-state"
import { blockReason, Row } from "@/routes/app/market-state"

const SLIPPAGE_BPS = 50

export function TradePanel({ market }: { market: ParticipantMarket }) {
  const [side, setSide] = useState<"buy" | "sell">("buy")
  const [amount, setAmount] = useState("")
  const tx = useTransaction(`${side === "buy" ? "Buy" : "Sell"} ${market.pair?.symbol ?? "stock"}`)
  const qc = useQueryClient()
  const state = market.chain.data
  const pool = state?.pool
  const balance = side === "buy" ? state?.usdcBalance : state?.stockBalance
  const decimalsIn = side === "buy" ? pool?.usdcDecimals : pool?.stockDecimals
  const decimalsOut = side === "buy" ? pool?.stockDecimals : pool?.usdcDecimals
  const quote = useMemo(() => {
    if (!pool || decimalsIn == null) return null
    try {
      const input = parseUnits(amount, decimalsIn)
      if (input <= 0n) return null
      const result = quoteSwap(input,
        side === "buy" ? pool.reserveUsdc : pool.reserveStock,
        side === "buy" ? pool.reserveStock : pool.reserveUsdc, pool.feeBps)
      return { input, ...result, minimum: withSlippage(result.out, SLIPPAGE_BPS) }
    } catch { return null }
  }, [amount, pool, decimalsIn, side])
  const block = blockReason(market)
  const insufficient = !!quote && balance != null && quote.input > balance
  const badInput = !!amount && !quote
  const review = async () => {
    if (!state || !pool || !quote || !market.wallet.signer || !state.ownerStock || !state.ownerUsdc || !market.credential.data) return
    const credential = market.credential.data.credential.address as Address
    const ix = swapInstruction({ ...state.addresses, credential },
      { owner: market.wallet.signer, ownerStock: state.ownerStock, ownerUsdc: state.ownerUsdc },
      { direction: side === "buy" ? SWAP_BUY : SWAP_SELL, amountIn: quote.input, minOut: quote.minimum })
    const result = await tx.submit([ix], market.wallet.signer)
    if (result.phase === "confirmed") {
      void qc.invalidateQueries({ queryKey: ["market-accounts"] })
      void qc.invalidateQueries({ queryKey: ["tape"] })
      void qc.invalidateQueries({ queryKey: ["symbols"] })
      setAmount("")
    }
  }
  const inSymbol = side === "buy" ? "USDC" : market.pair?.symbol ?? "stock"
  const outSymbol = side === "buy" ? market.pair?.symbol ?? "stock" : "USDC"
  return <section className="rounded-xl border bg-card p-4" aria-label="Trade panel">
    <div className="flex items-center justify-between"><h2 className="font-semibold">Swap</h2><span className="text-xs text-muted-foreground">Slippage 0.5%</span></div>
    <div className="mt-4 rounded-lg border bg-muted/30 p-3">
      <div className="flex justify-between text-xs text-muted-foreground"><label htmlFor="trade-amount">You pay · {inSymbol}</label><span>Balance {balance == null || decimalsIn == null ? "Connect wallet" : formatUnits(balance, decimalsIn)}</span></div>
      <div className="mt-2 flex items-center gap-2"><input id="trade-amount" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); tx.reset() }} placeholder="0.00" className="min-w-0 flex-1 bg-transparent text-xl outline-none" /><strong className="text-sm">{inSymbol}</strong></div>
      <div className="mt-2 flex gap-2">{[25, 50, 100].map((percent) => <Button key={percent} variant="outline" size="xs" disabled={balance == null || decimalsIn == null} onClick={() => { if (balance != null && decimalsIn != null) setAmount(formatUnits(balance * BigInt(percent) / 100n, decimalsIn)) }}>{percent === 100 ? "MAX" : `${percent}%`}</Button>)}</div>
    </div>
    <div className="my-2 text-center"><Button variant="outline" size="sm" aria-label="Flip direction" onClick={() => { setSide((value) => value === "buy" ? "sell" : "buy"); setAmount(""); tx.reset() }}>⇅</Button></div>
    <div className="rounded-lg border bg-muted/30 p-3"><div className="text-xs text-muted-foreground">You receive · {outSymbol}</div><div className="mt-2 flex justify-between gap-2 text-xl"><span className="tabular-nums">{quote && decimalsOut != null ? formatUnits(quote.out, decimalsOut) : "0.00"}</span><strong className="text-sm">{outSymbol}</strong></div></div>
    {quote && pool && decimalsIn != null && decimalsOut != null && <dl className="mt-3 text-xs"><Row label="Pool fee" value={`${formatUnits(quote.fee, decimalsIn)} ${inSymbol}`} /><Row label="Minimum received" value={`${formatUnits(quote.minimum, decimalsOut)} ${outSymbol}`} /><Row label="Pool reserves" value={`${formatUnits(pool.reserveStock, pool.stockDecimals)} ${market.pair?.symbol} / ${formatUnits(pool.reserveUsdc, pool.usdcDecimals)} USDC`} /></dl>}
    {tx.state.phase === "review" && quote && <div className="mt-4 rounded-lg border p-3 text-sm" role="group" aria-label="Review swap"><strong>Review {side}</strong><p className="mt-2">Pay {amount} {inSymbol} for at least {formatUnits(quote.minimum, decimalsOut!)} {outSymbol}.</p><p className="mt-1 text-muted-foreground">The program checks admission, Nasdaq halt state and the daily share cap when you sign.</p><div className="mt-3 flex gap-2"><Button disabled={tx.busy} onClick={() => void review()}>Confirm swap</Button><Button variant="outline" onClick={tx.reset}>Cancel</Button></div></div>}
    {tx.busy && <p className="mt-3 text-sm" role="status">{tx.state.phase === "awaiting-signature" ? "Awaiting wallet signature…" : "Pending on chain…"}</p>}
    {tx.state.phase === "failed" && <p role="alert" className="mt-3 rounded-lg border border-destructive p-3 text-sm">{tx.state.venueError ? `Program refusal: ${tx.state.venueError.name}. ` : ""}{transactionFailureMessage(tx.state.error)}</p>}
    {tx.state.phase === "confirmed" && <p role="status" className="mt-3 rounded-lg border p-3 text-sm">Swap confirmed. <Link to="/tape" className="underline">Check the public tape →</Link>{tx.state.explorer && <> · <a href={tx.state.explorer} target="_blank" rel="noreferrer" className="underline">View transaction ↗</a></>}</p>}
    {block ? <div className="mt-4 rounded-lg border p-3 text-sm" role="status"><strong>{block.title}</strong><p className="text-muted-foreground">{block.detail}</p>{block.action && <Link to={block.action} className="underline">Get admitted →</Link>}</div>
      : <Button className="mt-4 w-full" disabled={!quote || insufficient || tx.busy || tx.state.phase === "review"} onClick={tx.review}>{insufficient ? `Insufficient ${inSymbol} balance` : badInput ? "Enter a valid amount" : quote ? `Review ${side}` : "Enter an amount"}</Button>}
  </section>
}

import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"
import type { Address } from "@solana/kit"
import { Button } from "@/components/ui/button"
import { TokenInput } from "@/components/sol/token-input"
import { paths } from "@/app/paths"
import { formatUnits, formatUsd, parseUnits } from "@/lib/format"
import { quoteSwap, swapInstruction, SWAP_BUY, SWAP_SELL, withSlippage } from "@/lib/program"
import { useTransaction } from "@/lib/tx"
import { transactionFailureMessage } from "@/lib/wallet-ui/transaction-error"
import { tokenIcon } from "@/lib/wallet-ui/token-icon"
import { blockReason, Row, shareBudget, type ParticipantMarket } from "@/routes/app/market-state"

const SLIPPAGE_BPS = 50
export function TradePanel({ market }: { market: ParticipantMarket }) {
  const [side, setSide] = useState<"buy" | "sell">("buy")
  const [amount, setAmount] = useState("")
  const tx = useTransaction(`${side === "buy" ? "Buy" : "Sell"} ${market.pair?.symbol ?? "stock"}`, {
    toastVariant: "solana", successLink: { href: paths.explorer, label: "Public explorer" },
  })
  const qc = useQueryClient()
  const state = market.chain.data
  const pool = state?.pool
  const stockSymbol = market.pair?.symbol ?? "stock"
  const inSymbol = side === "buy" ? "USDC" : stockSymbol
  const outSymbol = side === "buy" ? stockSymbol : "USDC"
  const balance = side === "buy" ? state?.usdcBalance : state?.stockBalance
  const decimalsIn = side === "buy" ? pool?.usdcDecimals : pool?.stockDecimals
  const decimalsOut = side === "buy" ? pool?.stockDecimals : pool?.usdcDecimals
  const quote = useMemo(() => {
    if (!pool || decimalsIn == null) return null
    try {
      const input = parseUnits(amount, decimalsIn)
      if (input <= 0n) return null
      const result = quoteSwap(input, side === "buy" ? pool.reserveUsdc : pool.reserveStock,
        side === "buy" ? pool.reserveStock : pool.reserveUsdc, pool.feeBps)
      if (result.out <= 0n) return null
      return { input, ...result, minimum: withSlippage(result.out, SLIPPAGE_BPS) }
    } catch { return null }
  }, [amount, pool, decimalsIn, side])
  const stockLeg = quote ? side === "buy" ? quote.out : quote.input : 0n
  const counted = quote && state ? (stockLeg * BigInt(state.symbol.multiplierNum) + BigInt(state.symbol.multiplierDen) - 1n) / BigInt(state.symbol.multiplierDen) : 0n
  const remaining = shareBudget(market).remaining
  const capBlock: ReturnType<typeof blockReason> = quote && state && counted > remaining ? { title: "Daily cap reached", detail: "This order exceeds the remaining onchain share budget." } : null
  const block = blockReason(market) ?? capBlock
  const insufficient = !!quote && balance != null && quote.input > balance
  const badInput = !!amount && !quote
  const spot = pool && pool.reserveStock > 0n ? Number(formatUnits(pool.reserveUsdc, pool.usdcDecimals)) / Number(formatUnits(pool.reserveStock, pool.stockDecimals)) : null
  const executionPrice = quote && pool ? side === "buy"
    ? Number(formatUnits(quote.input, pool.usdcDecimals)) / Number(formatUnits(quote.out, pool.stockDecimals))
    : Number(formatUnits(quote.out, pool.usdcDecimals)) / Number(formatUnits(quote.input, pool.stockDecimals)) : null
  const impact = spot && executionPrice ? Math.abs(executionPrice / spot - 1) * 100 : null

  const execute = async () => {
    if (!state || !quote || !market.wallet.signer || !state.ownerStock || !state.ownerUsdc || !market.credential.data || block) return
    const credential = market.credential.data.credential.address as Address
    const ix = swapInstruction({ ...state.addresses, credential },
      { owner: market.wallet.signer, ownerStock: state.ownerStock, ownerUsdc: state.ownerUsdc },
      { direction: side === "buy" ? SWAP_BUY : SWAP_SELL, amountIn: quote.input, minOut: quote.minimum })
    const result = await tx.submit([ix], market.wallet.signer)
    if (result.phase === "confirmed") {
      for (const key of ["market-accounts", "tape", "symbols"]) void qc.invalidateQueries({ queryKey: [key] })
      setAmount("")
    }
  }
  const presets = [{ label: "25%", fraction: 0.25 }, { label: "50%", fraction: 0.5 }, { label: "MAX", fraction: 1 }]
  const preset = (fraction: number) => {
    if (balance == null || decimalsIn == null) return
    setAmount(formatUnits(balance * BigInt(Math.round(fraction * 100)) / 100n, decimalsIn))
    tx.reset()
  }

  return <section className="rounded-xl border bg-card p-4" aria-label="Trade panel">
    <div className="flex items-center justify-between"><h2 className="font-semibold">Trade {stockSymbol}</h2><span className="text-xs text-muted-foreground">Slippage 0.5%</span></div>
    <div className="mt-4 grid grid-cols-2 gap-2" role="tablist" aria-label="Trade direction">{(["buy", "sell"] as const).map((direction) => <Button key={direction} role="tab" aria-selected={side === direction} variant={side === direction ? "default" : "outline"} onClick={() => { setSide(direction); setAmount(""); tx.reset() }}>{direction === "buy" ? "Buy" : "Sell"}</Button>)}</div>
    <div className="mt-4"><label className="mb-2 block text-xs text-muted-foreground">You pay · {inSymbol}</label><TokenInput key={inSymbol} tokens={[{ symbol: inSymbol, icon: tokenIcon(inSymbol) }]} defaultToken={inSymbol}
      ariaLabel={`You pay · ${inSymbol}`} balance={balance == null || decimalsIn == null ? undefined : formatUnits(balance, decimalsIn)} value={amount}
      balanceMessage={!market.wallet.publicKey ? "Connect wallet to view" : undefined}
      onValueChange={(value) => { setAmount(value); tx.reset() }} presets={presets} onPreset={preset} /></div>
    <div className="mt-3 rounded-lg border p-3"><div className="text-xs text-muted-foreground">You receive · {outSymbol}</div><div className="mt-1 flex justify-between gap-2 text-xl"><strong className="tabular-nums">{quote && decimalsOut != null ? formatUnits(quote.out, decimalsOut) : "0.00"}</strong><strong className="text-sm">{outSymbol}</strong></div></div>
    {quote && pool && decimalsIn != null && decimalsOut != null && <dl className="mt-3 text-xs">
      <Row label="Execution price" value={executionPrice ? `$${formatUsd(String(executionPrice), 4)} / ${stockSymbol}` : "Unavailable"} />
      <Row label="Estimated impact incl. fee" value={impact == null ? "Unavailable" : `${impact.toFixed(2)}%`} />
      <Row label="Pool fee" value={`${formatUnits(quote.fee, decimalsIn)} ${inSymbol}`} />
      <Row label="Minimum received" value={`${formatUnits(quote.minimum, decimalsOut)} ${outSymbol}`} />
      <Row label="Shares counted toward daily budget" value={formatUnits(counted, pool.stockDecimals)} />
    </dl>}
    {tx.state.phase === "review" && quote && <div className="mt-4 rounded-lg border p-3 text-sm" role="group" aria-label="Review swap"><strong>Review {side}</strong><p className="mt-2">Pay {amount} {inSymbol} for at least {formatUnits(quote.minimum, decimalsOut!)} {outSymbol}.</p><p className="mt-1 text-muted-foreground">The program checks admission, halt state and share budget at execution.</p><div className="mt-3 flex gap-2"><Button disabled={tx.busy || !!block} onClick={() => void execute()}>Confirm swap</Button><Button variant="outline" onClick={tx.reset}>Cancel</Button></div></div>}
    {tx.busy && <p className="mt-3 text-sm" role="status">{tx.state.phase === "awaiting-signature" ? "Awaiting wallet signature…" : "Pending on chain…"}</p>}
    {tx.state.phase === "failed" && <p role="alert" className="mt-3 rounded-lg border border-destructive p-3 text-sm">{tx.state.venueError ? `Program refusal: ${tx.state.venueError.name}. ` : ""}{transactionFailureMessage(tx.state.error)}</p>}
    {tx.state.phase === "confirmed" && <p role="status" className="mt-3 rounded-lg border p-3 text-sm">Swap confirmed. <Link to={paths.explorer} className="underline">Check the public explorer →</Link>{tx.state.explorer && <> · <a href={tx.state.explorer} target="_blank" rel="noreferrer" className="underline">View transaction ↗</a></>}</p>}
    {block?.action ? <Button nativeButton={false} className="mt-4 w-full" render={<Link to={block.action} />}>Not admitted → Get admitted</Button>
      : <Button className="mt-4 w-full" disabled={!!block || !quote || insufficient || tx.busy || tx.state.phase === "review"} onClick={tx.review}>{block?.title ?? (insufficient ? `Insufficient ${inSymbol} balance` : badInput ? "Enter a valid amount" : quote ? `Review ${side}` : "Enter an amount")}</Button>}
    {block && <p className="mt-2 text-xs text-muted-foreground" role="status">{block.detail}</p>}
  </section>
}

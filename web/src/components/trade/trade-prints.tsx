import { AddressDisplay } from "@/components/sol/address-display"
import { explorerUrl } from "@/lib/cluster"
import { formatUsd } from "@/lib/format"
import type { Print } from "@/lib/api"

export function TradePrints({ prints }: { prints: Print[] }) {
  const recent = prints.slice(0, 30)
  return <>
    <div className="space-y-2 sm:hidden" aria-label="Recent onchain trades">
      {recent.map((print) => <article key={`${print.signature}-${print.event_index}`} className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3"><strong className={print.direction === "buy" ? "text-emerald-700" : "text-rose-700"}>{print.direction === "buy" ? "Buy" : "Sell"}</strong><time className="text-xs text-muted-foreground">{new Date(print.time).toLocaleString()}</time></div>
        <div className="mt-2 flex items-center justify-between gap-3"><span className="text-muted-foreground">Price</span><span>${formatUsd(print.price_usd, 4)}</span></div>
        <div className="mt-1 flex items-center justify-between gap-3"><span className="text-muted-foreground">Shares</span><span>{print.size_shares}</span></div>
        <div className="mt-2 flex items-center justify-between gap-3 border-t pt-2"><span className="text-muted-foreground">Transaction</span><AddressDisplay address={print.signature} href={explorerUrl("tx", print.signature)} /></div>
      </article>)}
    </div>
    <div className="hidden overflow-x-auto sm:block"><table className="w-full min-w-[530px] text-left"><thead><tr className="text-muted-foreground"><th className="pb-2">Time</th><th>Side</th><th>Price</th><th>Shares</th><th>Transaction</th></tr></thead><tbody>{recent.map((print) => <tr className="border-t" key={`${print.signature}-${print.event_index}`}><td className="py-2">{new Date(print.time).toLocaleString()}</td><td className={print.direction === "buy" ? "text-emerald-700" : "text-rose-700"}>{print.direction}</td><td>${formatUsd(print.price_usd, 4)}</td><td>{print.size_shares}</td><td><AddressDisplay address={print.signature} href={explorerUrl("tx", print.signature)} /></td></tr>)}</tbody></table></div>
  </>
}

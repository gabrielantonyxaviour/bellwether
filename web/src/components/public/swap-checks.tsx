import { useState } from "react"
import { formatBps } from "@/components/public/format"
import { cn } from "@/lib/utils"

export interface SwapCheck {
  id: string
  title: string
  summary: string
  detail: string
}

/** The program's check order, from docs/program-contract.md. The fee is the live pool fee when the API has it. */
export function swapChecks(feeBps: number | null): SwapCheck[] {
  const fee = feeBps === null ? "The pool's on-chain fee goes to liquidity providers." : `This pool's fee is ${formatBps(feeBps)}, paid to liquidity providers.`
  return [
    {
      id: "credential",
      title: "Credential",
      summary: "The wallet holds a Solana Attestation Service credential issued after an OFAC screen.",
      detail: "Without a valid credential the program refuses the swap with NotAdmitted. Calling the program directly does not skip the check.",
    },
    {
      id: "halt",
      title: "Halt",
      summary: "The relay mirrors the listing exchange's halt feed onto the symbol.",
      detail: "A posted halt refuses the swap with TradingHalted. A stale relay heartbeat refuses it with HaltDataStale. Trading fails closed.",
    },
    {
      id: "cap",
      title: "Cap",
      summary: "Shares traded today stay inside the symbol's on-chain daily budget.",
      detail: "A swap past the budget is refused with CapReached. A second volume-threshold breach pauses the symbol.",
    },
    {
      id: "swap",
      title: "Swap",
      summary: "The pool is constant-product. Every fill is printed on the public explorer.",
      detail: fee,
    },
  ]
}

export function SwapCheckStrip({ feeBps }: { feeBps: number | null }) {
  const checks = swapChecks(feeBps)
  const [current, setCurrent] = useState(0)
  const selected = checks[current] ?? checks[0]
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">How a swap is checked</h2>
        <p className="text-xs text-muted-foreground">Inside the program, in this order</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="tablist" aria-label="Swap checks">
        {checks.map((check, index) => (
          <button
            key={check.id}
            type="button"
            role="tab"
            id={`check-${check.id}`}
            aria-selected={index === current}
            aria-controls="swap-check-detail"
            className={cn(
              "grid gap-1 rounded-lg border px-3 py-2 text-left",
              index === current ? "border-foreground" : "hover:bg-muted",
            )}
            onClick={() => setCurrent(index)}
          >
            <span className="text-[10px] text-muted-foreground">{index + 1} / {checks.length}</span>
            <span className="text-sm font-medium">{check.title}</span>
            <span className="text-xs text-muted-foreground">{check.summary}</span>
          </button>
        ))}
      </div>
      <div id="swap-check-detail" role="tabpanel" aria-labelledby={`check-${selected.id}`} className="rounded-lg border px-3 py-3 text-sm">
        <p>
          <span className="font-medium">{selected.title}. </span>
          {selected.detail}
        </p>
      </div>
    </div>
  )
}

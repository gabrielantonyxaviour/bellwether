import { activationLabel, activation, TIER1_MAX, TIER2_MAX } from "@/components/operator/budget"
import { SymbolActions } from "@/components/operator/symbol-actions"
import { EmptyBlock, ErrorBlock, LoadingBlock, OperatorPage, Stat } from "@/components/operator/states"
import { useOperatorBook } from "@/components/operator/use-operator"

export function OperatorSymbolsPage() {
  const { chain } = useOperatorBook()
  const counts = chain.data?.rows.reduce((acc, row) => {
    acc[row.symbol.tier === 1 ? "t1" : "t2"] += 1
    const state = activation(row.symbol, chain.data?.chainTime ?? 0)
    if (state.kind === "window") acc.window += 1
    if (state.kind === "objected") acc.objected += 1
    if (state.kind === "active") acc.active += 1
    return acc
  }, { t1: 0, t2: 0, window: 0, objected: 0, active: 0 })
  return (
    <OperatorPage title="Symbols and issuer notices" lede="Register a symbol, record the issuer-notice receipt, file an objection, and activate once the 30-day clock has run. Writes are signed by the venue admin.">
      {chain.isPending && <LoadingBlock label="Reading symbol accounts…" />}
      {chain.isError && <ErrorBlock message={chain.error.message} onRetry={() => void chain.refetch()} />}
      {chain.data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Stat label="Tier 1" value={`${counts?.t1 ?? chain.data.venue.tier1Count} / ${TIER1_MAX}`} detail="Symbol-cap count" />
            <Stat label="Tier 2" value={`${counts?.t2 ?? chain.data.venue.tier2Count} / ${TIER2_MAX}`} detail="Symbol-cap count" />
            <Stat label="Notice clock running" value={String(counts?.window ?? 0)} />
            <Stat label="Objected / active" value={`${counts?.objected ?? 0} / ${counts?.active ?? 0}`} />
          </div>
          {chain.data.rows.length === 0 && <EmptyBlock title="No symbols yet" detail="A registered symbol appears here as soon as the symbol account confirms." />}
          <p className="sr-only">{chain.data.rows.map((row) => activationLabel(activation(row.symbol, chain.data!.chainTime))).join(", ")}</p>
          <SymbolActions book={chain.data} />
        </div>
      )}
    </OperatorPage>
  )
}

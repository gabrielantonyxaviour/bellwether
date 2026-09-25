import { Link } from "react-router"
import { activation, activationLabel, heartbeatAge, sharesUsed, TIER1_MAX, TIER2_MAX } from "@/components/operator/budget"
import { tickerOf } from "@/components/operator/book"
import { EmptyBlock, ErrorBlock, LoadingBlock, OperatorPage, ShareGauge, Stat } from "@/components/operator/states"
import { useOperatorBook } from "@/components/operator/use-operator"
import { paths } from "@/app/paths"
import { Badge } from "@/components/ui/badge"
import { formatUnits } from "@/lib/format"

export function OperatorOverviewPage() {
  const { symbols, chain } = useOperatorBook()
  return (
    <OperatorPage title="Operator overview" lede="Symbols, share-cap gauges, halt status, heartbeat age and the breach ledger, read from the venue account and each symbol record.">
      {chain.isPending && <LoadingBlock label="Reading venue and symbol accounts…" />}
      {chain.isError && <ErrorBlock message={chain.error.message} onRetry={() => void chain.refetch()} />}
      {chain.data && chain.data.rows.length === 0 && <EmptyBlock title="No symbols registered" detail="Register one under Symbols. Counts stay at zero until a symbol account exists." />}
      {chain.data && chain.data.rows.length > 0 && <Overview book={chain.data} tapeDown={symbols.isError ? symbols.error.message : null} />}
    </OperatorPage>
  )
}

function Overview({ book, tapeDown }: { book: NonNullable<ReturnType<typeof useOperatorBook>["chain"]["data"]>; tapeDown: string | null }) {
  const { venue, chainTime, rows } = book
  const ages = rows.map((row) => heartbeatAge(row.symbol.lastHeartbeat, chainTime))
  const known = ages.filter((age): age is number => age != null)
  const oldest = known.length ? Math.max(...known) : null
  const halted = rows.filter((row) => row.symbol.halted).length
  const breaches = rows.filter((row) => row.symbol.breachCount > 0)
  const paused = rows.filter((row) => Number(row.symbol.pausedUntil) > chainTime)
  return (
    <div className="space-y-4">
      {tapeDown && <ErrorBlock message={`Tape totals are unavailable: ${tapeDown}`} />}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Tier 1 symbols" value={`${venue.tier1Count} / ${TIER1_MAX}`} />
        <Stat label="Tier 2 symbols" value={`${venue.tier2Count} / ${TIER2_MAX}`} />
        <Stat label="Oldest heartbeat" value={oldest == null ? "No heartbeat" : `${oldest}s ago`} detail={`Fail closed after ${venue.heartbeatMaxAge}s`} />
        <Stat label="Halted" value={String(halted)} detail={`${breaches.length} with breaches · ${paused.length} paused`} />
      </div>
      <div className="min-w-0 overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Symbol</th>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">Daily share budget</th>
              <th className="px-3 py-2 font-medium">Halt</th>
              <th className="px-3 py-2 font-medium">Heartbeat</th>
              <th className="px-3 py-2 font-medium">Activation</th>
              <th className="px-3 py-2 font-medium">Breaches</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const decimals = row.pool?.stockDecimals ?? 6
              const used = sharesUsed(row.symbol, chainTime, Number(venue.tradeDateCutoff))
              const age = heartbeatAge(row.symbol.lastHeartbeat, chainTime)
              const stale = age != null && age > Number(venue.heartbeatMaxAge)
              const state = activation(row.symbol, chainTime)
              return (
                <tr key={row.address} className="border-b last:border-0">
                  <td className="px-3 py-3 font-medium"><Link className="underline" to={paths.operator.symbols}>{tickerOf(row)}</Link></td>
                  <td className="px-3 py-3">{row.symbol.tier}</td>
                  <td className="px-3 py-3"><ShareGauge label={`${tickerOf(row)} daily share budget`} used={used} cap={row.symbol.capShares} decimals={decimals} /></td>
                  <td className="px-3 py-3">{row.symbol.halted ? <Badge variant="destructive">Halted {row.symbol.haltReason || ""}</Badge> : "Clear"}</td>
                  <td className="px-3 py-3">{age == null ? "No heartbeat yet" : <span className={stale ? "font-medium" : ""}>{age}s ago{stale ? " · stale" : ""}</span>}</td>
                  <td className="px-3 py-3">{activationLabel(state)}</td>
                  <td className="px-3 py-3">{row.symbol.breachCount}{Number(row.symbol.pausedUntil) > chainTime ? ` · paused until ${new Date(Number(row.symbol.pausedUntil) * 1000).toISOString().slice(0, 10)}` : ""}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {breaches.length > 0 && (
        <section className="rounded-xl border p-4 text-sm" aria-label="Breach ledger">
          <h2 className="font-semibold">Breach ledger</h2>
          <ul className="mt-2 space-y-1">
            {breaches.map((row) => (
              <li key={row.address}>{tickerOf(row)} · {row.symbol.breachCount} breach{row.symbol.breachCount === 1 ? "" : "es"} · cap {formatUnits(row.symbol.capShares, row.pool?.stockDecimals ?? 6)} shares</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

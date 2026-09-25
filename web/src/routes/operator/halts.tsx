import { heartbeatAge } from "@/components/operator/budget"
import { tickerOf } from "@/components/operator/book"
import { AddressLink, EmptyBlock, ErrorBlock, LoadingBlock, OperatorPage, Stat } from "@/components/operator/states"
import { useOperatorBook, useOperatorHalts } from "@/components/operator/use-operator"
import { Badge } from "@/components/ui/badge"

export function OperatorHaltsPage() {
  const { chain } = useOperatorBook()
  const halts = useOperatorHalts()
  const rows = halts.data?.halts ?? []
  const relay = halts.data?.relay
  const stale = chain.data?.rows.some((row) => {
    const age = heartbeatAge(row.symbol.lastHeartbeat, chain.data!.chainTime)
    return age == null || age > Number(chain.data!.venue.heartbeatMaxAge)
  }) ?? false
  return (
    <OperatorPage title="Halts and latency" lede="Relay health, how old each symbol's heartbeat is, and the halt ledger with feed, detection and enforcement times.">
      {chain.isPending && <LoadingBlock label="Reading halt state from chain…" />}
      {chain.isError && <ErrorBlock message={chain.error.message} onRetry={() => void chain.refetch()} />}
      {halts.isError && <ErrorBlock message={halts.error.message} onRetry={() => void halts.refetch()} />}
      {chain.data && (
        <div className="space-y-4">
          <div className="rounded-xl border p-4" role="status">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Relay</h2>
              <Badge variant={stale ? "destructive" : "outline"}>{stale ? "Stale: failing closed" : "Healthy"}</Badge>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat label="Last poll" value={relay?.last_poll_at ? new Date(relay.last_poll_at).toLocaleString() : "No poll yet"} detail={relay?.last_poll_ok == null ? undefined : relay.last_poll_ok ? "Last poll succeeded" : "Last poll failed"} />
              <Stat label="Consecutive failures" value={relay?.consecutive_failures == null ? "—" : String(relay.consecutive_failures)} />
              <Stat label="Relay heartbeat" value={relay?.last_heartbeat_at ? new Date(relay.last_heartbeat_at).toLocaleString() : "None recorded"} />
              <Stat label="Feed" value={relay?.source ?? "No source"} />
            </div>
          </div>
          <div className="min-w-0 overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead><tr className="border-b text-xs text-muted-foreground"><th className="px-3 py-2">Symbol</th><th className="px-3 py-2">On-chain halt</th><th className="px-3 py-2">Heartbeat age</th></tr></thead>
              <tbody>
                {chain.data.rows.map((row) => {
                  const age = heartbeatAge(row.symbol.lastHeartbeat, chain.data!.chainTime)
                  return (
                    <tr key={row.address} className="border-b last:border-0">
                      <td className="px-3 py-2">{tickerOf(row)}</td>
                      <td className="px-3 py-2">{row.symbol.halted ? `Halted · ${row.symbol.haltReason || "no reason"}` : "Clear"}</td>
                      <td className="px-3 py-2">{age == null ? "No heartbeat yet" : `${age}s ago`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {halts.isPending && <LoadingBlock label="Reading the halt ledger…" />}
          {!halts.isPending && !halts.isError && rows.length === 0 && <EmptyBlock title="No halt ledger rows" detail="No halt entries are available in the current relay ledger. The on-chain row above shows the current halt state." />}
          {rows.length > 0 && (
            <div className="min-w-0 overflow-x-auto rounded-xl border">
              <table className="w-full min-w-[880px] text-left text-sm" aria-label="Latency ledger">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="px-3 py-2">Symbol</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Feed time</th><th className="px-3 py-2">Seen</th><th className="px-3 py-2">Enforced</th><th className="px-3 py-2">Detection</th><th className="px-3 py-2">Enforcement</th><th className="px-3 py-2">Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.symbol}-${row.tx_signature ?? row.feed_seen_at}`} className="border-b last:border-0">
                      <td className="px-3 py-2">{row.symbol}</td>
                      <td className="px-3 py-2">{row.reason_code ?? "—"}</td>
                      <td className="px-3 py-2">{stamp(row.nasdaq_halt_time)}</td>
                      <td className="px-3 py-2">{stamp(row.feed_seen_at)}</td>
                      <td className="px-3 py-2">{stamp(row.tx_confirmed_at)}{row.resumed_at ? ` · resumed ${stamp(row.resumed_at)}` : ""}</td>
                      <td className="px-3 py-2">{row.detection_ms == null ? "—" : `${row.detection_ms} ms`}</td>
                      <td className="px-3 py-2">{row.enforcement_ms == null ? "—" : `${row.enforcement_ms} ms`}</td>
                      <td className="px-3 py-2"><AddressLink kind="tx" value={row.tx_signature} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </OperatorPage>
  )
}

function stamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—"
}

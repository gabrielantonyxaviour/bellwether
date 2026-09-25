import { AddressLink, EmptyBlock, ErrorBlock, LoadingBlock, OperatorPage, Stat } from "@/components/operator/states"
import type { OperatorRehearsal } from "@/components/operator/schemas"
import { useOperatorRehearsal } from "@/components/operator/use-operator"

export function OperatorRehearsalPage() {
  const report = useOperatorRehearsal()
  return (
    <OperatorPage title="FWDI launch rehearsal" lede="What listing the real mainnet FWDI stock would involve: authorities, the allowlist, its markets, recent activity, the Tier 2 daily share budget, and the halt audit.">
      {report.isPending && <LoadingBlock label="Reading mainnet FWDI…" />}
      {report.isError && <ErrorBlock message={report.error.message} onRetry={() => void report.refetch()} />}
      {report.data && <Report report={report.data} />}
    </OperatorPage>
  )
}

function Report({ report }: { report: OperatorRehearsal }) {
  const frozen = report.markets.found.filter((market) => !market.canTrade)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Supply" value={report.mint.supplyShares.toLocaleString("en-US")} detail={`${report.mint.symbol} · ${report.mint.decimals} decimals`} />
        <Stat label="Markets" value={String(report.markets.found.length)} detail={`${frozen.length} blocked`} />
        <Stat label="Tier" value={report.budget.tier} detail={report.budget.tierLabel} />
        <Stat label="Daily share budget" value={report.budget.dailyShareBudget == null ? "Unavailable" : report.budget.dailyShareBudget.toLocaleString("en-US")} detail={report.budget.month} />
      </div>
      <section className="rounded-xl border p-4 text-sm" aria-label="Authority map">
        <h2 className="font-semibold">Authority map</h2>
        <p className="mt-1 text-muted-foreground">Default account state: {report.mint.defaultAccountState ?? "unknown"}. New accounts stay frozen until the freeze authority thaws them — that is the allowlist.</p>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          <Authority label="Mint" value={report.mint.address} />
          <Authority label="Mint authority" value={report.mint.mintAuthority} />
          <Authority label="Freeze authority" value={report.mint.freezeAuthority} />
          <Authority label="Permanent delegate" value={report.mint.permanentDelegate} />
        </dl>
        <ul className="mt-3 space-y-2">
          {report.mint.authorityMap.map((entry) => (
            <li key={entry.address}><AddressLink kind="account" value={entry.address} network="mainnet" /> · {entry.roles.join(", ")} · {entry.powers.join("; ")}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{report.mint.source.name} · {report.mint.source.fetchedAt}</p>
      </section>
      <section className="rounded-xl border p-4 text-sm" aria-label="Markets">
        <h2 className="font-semibold">Markets</h2>
        {report.markets.found.length === 0 && <EmptyBlock title="No markets found" detail="The rehearsal scan did not attribute an FWDI market." />}
        <div className="mt-3 min-w-0 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <thead><tr className="border-b text-xs text-muted-foreground"><th className="py-2">Program</th><th>Kind</th><th>Vault</th><th>Can trade</th></tr></thead>
            <tbody>
              {report.markets.found.map((market) => (
                <tr key={market.address} className="border-b last:border-0">
                  <td className="py-2">{market.programName}</td>
                  <td>{market.kind}</td>
                  <td>{market.fwdiVault.state ?? (market.fwdiVault.exists ? "present" : "missing")}</td>
                  <td>{market.canTrade ? "Yes" : market.blocker ?? "Blocked"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="rounded-xl border p-4 text-sm" aria-label="On-chain activity">
        <h2 className="font-semibold">On-chain activity</h2>
        <p className="mt-1">{report.activity.signatures} signatures in {report.activity.windowDays} days · {report.activity.trades} trades · {report.activity.succeeded} succeeded · {report.activity.failed} failed{report.activity.truncated ? " · window truncated" : ""}.</p>
      </section>
      <section className="rounded-xl border p-4 text-sm" aria-label="Daily share budget">
        <h2 className="font-semibold">Tier 2 daily share budget</h2>
        <p className="mt-1">Status {report.budget.status}. Prior-month ADV {report.budget.averageDailyShareVolume == null ? "unavailable" : report.budget.averageDailyShareVolume.toLocaleString("en-US")} from {report.budget.primary ?? "no source"}.</p>
        {report.budget.errors.length > 0 && <p className="mt-2">{report.budget.errors.join(" ")}</p>}
      </section>
      <section className="rounded-xl border p-4 text-sm" aria-label="Halt audit">
        <h2 className="font-semibold">Halt audit</h2>
        <p className="mt-1">Status {report.haltAudit.status}. Latest halt {report.haltAudit.latestHaltAt ?? "none"}.</p>
        <p className="mt-2 text-muted-foreground">{report.haltAudit.note}</p>
        {report.haltAudit.halts.length === 0 && <p className="mt-2">No halt rows in the audit window.</p>}
        <ul className="mt-2 space-y-1">
          {report.haltAudit.halts.slice(0, 8).map((halt) => <li key={`${halt.symbol}-${halt.haltAt}`}>{halt.symbol} · {halt.reason} · {halt.haltAt}{halt.resumedAt ? ` · resumed ${halt.resumedAt}` : ""}</li>)}
        </ul>
      </section>
    </div>
  )
}

function Authority({ label, value }: { label: string; value: string | null }) {
  return <div className="flex items-center justify-between gap-2 border-b py-1"><dt>{label}</dt><dd><AddressLink kind="account" value={value} network="mainnet" /></dd></div>
}

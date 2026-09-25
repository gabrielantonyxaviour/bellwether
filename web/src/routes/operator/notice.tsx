import { useState } from "react"
import { AddressLink, EmptyBlock, ErrorBlock, LoadingBlock, OperatorPage, SourceBadge, Stat } from "@/components/operator/states"
import type { OperatorNotice as Notice } from "@/components/operator/schemas"
import { useOperatorNotice } from "@/components/operator/use-operator"
import { Button } from "@/components/ui/button"

type Filter = "all" | "operator-input" | "unresolved"

export function OperatorPublicNoticePage() {
  const notice = useOperatorNotice()
  const [filter, setFilter] = useState<Filter>("all")
  return (
    <OperatorPage title="Public notice" lede="The order's 30 notice items. Chain-read facts are filled. Operator-input items stay flagged until someone writes them. Publishing is a date on this draft, not a transaction.">
      {notice.isPending && <LoadingBlock label="Reading the notice draft…" />}
      {notice.isError && <ErrorBlock message={notice.error.message} onRetry={() => void notice.refetch()} />}
      {notice.data && <Draft draft={notice.data} filter={filter} onFilter={setFilter} />}
    </OperatorPage>
  )
}

function Draft({ draft, filter, onFilter }: { draft: Notice; filter: Filter; onFilter: (filter: Filter) => void }) {
  const items = draft.items.filter((item) => filter === "all" || item.status === filter || (filter === "operator-input" && item.source === "operator-input"))
  const published = draft.schedule.publishedOn
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Filled" value={`${draft.completeness.filled} / ${draft.completeness.total}`} detail={draft.completeness.label} />
        <Stat label="Operator input" value={String(draft.completeness.operatorInput)} />
        <Stat label="Unresolved" value={String(draft.completeness.unresolved)} />
        <Stat label="Earliest operating date" value={draft.schedule.earliestOperatingDate ?? "Not published"} detail={published ? `Published ${published}` : "Draft"} />
      </div>
      <Authorities draft={draft} />
      <section className="rounded-xl border p-4 text-sm">
        <h2 className="font-semibold">Reminders</h2>
        {draft.schedule.reminders.length === 0 && <p className="mt-2 text-muted-foreground">No dated reminders until a publish date is set. The order still requires 5 business days to amend, 20 days before a material change, and a quarterly review.</p>}
        <ul className="mt-2 space-y-2">
          {draft.schedule.reminders.map((reminder) => <li key={`${reminder.kind}-${reminder.due}`}><strong>{reminder.due}</strong> · {reminder.kind} · {reminder.rule}</li>)}
        </ul>
        {draft.schedule.secEmailDue && <p className="mt-2">SEC email due {draft.schedule.secEmailDue}.</p>}
      </section>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter notice items">
        {(["all", "operator-input", "unresolved"] as const).map((name) => (
          <Button key={name} size="sm" variant={filter === name ? "default" : "outline"} onClick={() => onFilter(name)}>{name}</Button>
        ))}
      </div>
      {items.length === 0 && <EmptyBlock title="No items in this filter" detail="Switch back to all to see the full draft." />}
      <div className="divide-y rounded-xl border">
        {items.map((item) => (
          <details key={item.letter} className="p-4 text-sm">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <span className="font-medium">{item.letter}. {item.title}</span>
              <SourceBadge source={item.source} />
              <span className="text-xs text-muted-foreground">{item.status}</span>
            </summary>
            <p className="mt-3 text-muted-foreground">{item.requirement}</p>
            {item.text && <p className="mt-2 whitespace-pre-wrap">{item.text}</p>}
            {item.operatorPrompt && <p className="mt-2"><strong>Operator input.</strong> {item.operatorPrompt}</p>}
            {item.unresolved.length > 0 && <p className="mt-2">Unresolved: {item.unresolved.join("; ")}</p>}
            {item.addenda.length > 0 && <p className="mt-2">Still needed from the operator: {item.addenda.join("; ")}</p>}
            {item.facts.length > 0 && (
              <dl className="mt-3 space-y-1">
                {item.facts.map((fact) => (
                  <div key={fact.key} className="flex flex-wrap justify-between gap-2 border-b py-1">
                    <dt className="text-muted-foreground">{fact.label}</dt>
                    <dd className="text-right">{formatFact(fact.value)} <span className="text-xs text-muted-foreground">({fact.source})</span></dd>
                  </div>
                ))}
              </dl>
            )}
          </details>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{draft.orderCite} · generated {draft.generatedAt}</p>
    </div>
  )
}

function Authorities({ draft }: { draft: Notice }) {
  const program = draft.chain.program
  const venue = draft.chain.venue
  const rows: { label: string; value: string | null }[] = [
    { label: "Upgrade authority", value: program?.upgradeAuthority ?? null },
    { label: "Program", value: program?.id ?? null },
    { label: "Admin", value: venue?.admin ?? null },
    { label: "Relay", value: venue?.relay ?? null },
    { label: "Data authority", value: venue?.dataAuthority ?? null },
    { label: "Credential issuer", value: venue?.credentialIssuer ?? null },
    { label: "SAS credential", value: venue?.sasCredential ?? null },
    { label: "SAS schema", value: venue?.sasSchema ?? null },
  ]
  return (
    <section className="rounded-xl border p-4" aria-label="Chain-read authorities">
      <h2 className="font-semibold">Chain-read authorities</h2>
      <p className="mt-1 text-sm text-muted-foreground">{program?.upgradeable ? "The program is upgradeable." : "Upgrade authority was not readable."} Who can pause or override is the admin and the relay keys below.</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2 border-b py-1">
            <dt>{row.label}</dt>
            <dd><AddressLink kind="account" value={row.value} /></dd>
          </div>
        ))}
      </dl>
      {draft.chain.symbols.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {draft.chain.symbols.map((symbol) => (
            <li key={symbol.ticker}>
              {symbol.ticker}{symbol.pool ? ` · fee ${symbol.pool.feeBps} bps · vaults ` : " · no pool"}
              {symbol.pool && <><AddressLink kind="account" value={symbol.pool.stockVault} /> / <AddressLink kind="account" value={symbol.pool.usdcVault} /></>}
              {symbol.token && <> · mint authority <AddressLink kind="account" value={symbol.token.mintAuthority} /> · freeze <AddressLink kind="account" value={symbol.token.freezeAuthority} /></>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function formatFact(value: string | number | boolean | null): string {
  if (value == null) return "—"
  if (typeof value === "boolean") return value ? "yes" : "no"
  return String(value)
}

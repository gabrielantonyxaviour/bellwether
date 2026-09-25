import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { capPercent } from "@/components/operator/budget"
import { formatUnits } from "@/lib/format"
import { explorerUrl } from "@/lib/cluster"
import { shortAddress } from "@/lib/wallet"

export function OperatorPage({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{lede}</p>
      </header>
      {children}
    </div>
  )
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div role="status" className="space-y-3" aria-busy="true">
      <p className="text-sm text-muted-foreground">{label}</p>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-destructive p-4 text-sm">
      <strong>Unavailable</strong>
      <p className="mt-1">{message}</p>
      {onRetry && <Button variant="outline" className="mt-3" onClick={onRetry}>Retry</Button>}
    </div>
  )
}

export function EmptyBlock({ title, detail }: { title: string; detail: string }) {
  return (
    <div role="status" className="rounded-xl border p-6 text-sm">
      <strong>{title}</strong>
      <p className="mt-1 text-muted-foreground">{detail}</p>
    </div>
  )
}

export function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  )
}

export function ShareGauge({ label, used, cap, decimals }: { label: string; used: bigint; cap: bigint; decimals: number }) {
  const percent = capPercent(used, cap)
  return (
    <div className="min-w-36">
      <div className="flex justify-between gap-2 text-xs">
        <span>{label}</span>
        <span className="tabular-nums">{percent == null ? "Cap not set" : `${percent.toFixed(percent === 100 ? 0 : 1)}%`}</span>
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? 0}
        aria-valuetext={percent == null ? "Cap not set" : `${percent}% of ${formatUnits(cap, decimals)} shares`}
      >
        <div className="h-full bg-foreground" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        {formatUnits(used, decimals)} / {cap === 0n ? "—" : formatUnits(cap, decimals)} shares
      </p>
    </div>
  )
}

export function AddressLink({ kind, value, label }: { kind: "account" | "tx" | "token"; value: string | null; label?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  return (
    <a className="font-mono text-xs underline" href={explorerUrl(kind, value)} target="_blank" rel="noreferrer">
      {label ?? shortAddress(value, 4)}
    </a>
  )
}

export function SourceBadge({ source }: { source: string }) {
  const variant = source === "operator-input" ? "destructive" : source === "chain" ? "default" : "outline"
  return <Badge variant={variant}>{source}</Badge>
}

export function TxNote({ phase, error, signature }: { phase: string; error: string | null; signature: string | null }) {
  if (phase === "confirmed" && signature) return <p role="status" className="text-sm">Confirmed · <AddressLink kind="tx" value={signature} label={shortAddress(signature, 6)} /></p>
  if (phase === "failed" && error) return <p role="alert" className="text-sm">{error}</p>
  if (phase === "awaiting-signature" || phase === "pending") return <p role="status" className="text-sm text-muted-foreground">{phase === "pending" ? "Waiting for confirmation…" : "Approve the transaction in your wallet…"}</p>
  return null
}

export function ReviewPanel({ title, detail, confirmLabel, busy, onConfirm, onCancel }: { title: string; detail: string; confirmLabel: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="region" aria-label="Review transaction" className="rounded-xl border p-4 text-sm">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-muted-foreground">{detail}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

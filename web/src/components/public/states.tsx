import type { ReactNode } from "react"
import { ApiError } from "@/lib/api"

export function statusText(error: unknown): string {
  if (error instanceof ApiError) return error.code ? `${error.message} (${error.code})` : error.message
  if (error instanceof Error) return error.message
  return "The request failed."
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div role="status" className="grid gap-2" aria-label={label}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="h-8 animate-pulse rounded-md bg-muted" />
      <div className="h-8 animate-pulse rounded-md bg-muted" />
    </div>
  )
}

export function ErrorBlock({ title, error, onRetry }: { title: string; error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="grid gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm">
      <p>
        <span className="font-medium">{title}. </span>
        {statusText(error)}
      </p>
      {onRetry && (
        <button type="button" className="w-fit text-sm underline" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

export function EmptyBlock({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="grid place-items-center gap-1 px-4 py-12 text-center">
      <p className="font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{detail}</p>
    </div>
  )
}

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

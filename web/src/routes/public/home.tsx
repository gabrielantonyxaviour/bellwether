import { Link } from "react-router"
import { ChainLink } from "@/components/public/chain-link"
import { ageLabel } from "@/components/public/format"
import { ErrorBlock, LoadingBlock } from "@/components/public/states"
import { SwapCheckStrip } from "@/components/public/swap-checks"
import { paths } from "@/app/paths"
import { useHalts, useSymbols, useVenue, type HaltEntry } from "@/lib/api"
import { clusterConfig, explorerUrl } from "@/lib/cluster"

function openHalt(entry: HaltEntry): boolean {
  return !entry.resumed_at
}

function StatusStrip() {
  const venue = useVenue()
  const halts = useHalts()
  if (venue.isPending || halts.isPending) return <LoadingBlock label="Loading venue status" />
  if (venue.isError) return <ErrorBlock title="Venue status is unavailable" error={venue.error} onRetry={() => void venue.refetch()} />
  const body = venue.data
  const relay = halts.data && "relay" in halts.data ? (halts.data.relay as { last_heartbeat_at?: string | null; last_poll_ok?: boolean; source?: string } | undefined) : undefined
  const open = (halts.data?.halts ?? []).filter(openHalt)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-xs sm:px-6" aria-label="Live venue status">
      <span>
        Program{" "}
        <ChainLink href={explorerUrl("account", body.program)} id={body.program} kind="account" />
      </span>
      <span className="uppercase text-muted-foreground">{body.cluster}</span>
      {body.indexer?.stale && <span className="text-destructive">Indexer stale</span>}
      {halts.isError ? (
        <span>Halt ledger unavailable</span>
      ) : open.length > 0 ? (
        <span>
          Halted now · {open.map((entry) => entry.symbol).join(", ")}
          {open[0]?.reason_code ? ` · ${open[0].reason_code}` : ""}
        </span>
      ) : (
        <span>No open halt{relay?.source ? ` · ${relay.source} heartbeat ${ageLabel(relay.last_heartbeat_at)}` : ""}</span>
      )}
      {relay && relay.last_poll_ok === false && <span className="text-destructive">Halt feed poll failed</span>}
    </div>
  )
}

export function HomePage() {
  const symbols = useSymbols()
  const config = clusterConfig()
  const feeBps = symbols.data?.symbols[0]?.fee_bps ?? null
  const symbol = symbols.data?.symbols[0]?.symbol ?? config.defaultSymbol
  const doors = [
    { href: paths.trade(symbol), title: "Trade", detail: "Get admitted, then swap USDC for the listed token.", cta: "Open trade" },
    { href: paths.explorer, title: "Explorer", detail: "Every print: price, size, pool and signature. No wallet.", cta: "Open explorer" },
    { href: paths.about, title: "About", detail: "Program id, accounts and signatures on Solscan.", cta: "See what runs where" },
  ]
  return (
    <div>
      <StatusStrip />
      <div className="grid gap-8 px-4 py-6 sm:px-6">
        <div className="grid max-w-2xl gap-3">
          <p className="w-fit rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            Solana {config.cluster} · {symbol}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Permissioned pools for tokenized US stocks, with the SEC&apos;s rules in the swap path
          </h1>
          <p className="text-sm text-muted-foreground">
            Every swap checks the credential, the listing-exchange halt and the daily share budget inside the program.
            The app cannot skip those checks.{" "}
            <Link to={paths.operator.overview} className="underline">Operator workbench</Link>
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {doors.map((door) => (
            <Link key={door.href} to={door.href} className="grid gap-2 rounded-lg border p-4 hover:bg-muted">
              <span className="font-medium">{door.title}</span>
              <span className="text-sm text-muted-foreground">{door.detail}</span>
              <span className="text-sm font-medium">{door.cta}</span>
            </Link>
          ))}
        </div>
        {symbols.isError && (
          <p className="text-sm text-muted-foreground">
            Pool fee is not loaded ({symbols.error.message}). The check list still describes the program.
          </p>
        )}
        <SwapCheckStrip feeBps={feeBps} />
      </div>
    </div>
  )
}

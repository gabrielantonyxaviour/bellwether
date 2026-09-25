/** Public + participant shell: header with nav (Trade, Liquidity, Explorer, About) and the wallet and credential slots. */
import type { ReactNode } from "react"
import { NavLink, Outlet } from "react-router"
import { CredentialBadge } from "@/app/credential-badge"
import { paths } from "@/app/paths"
import { WalletButton } from "@/app/wallet-button"
import { clusterConfig } from "@/lib/cluster"
import { cn } from "@/lib/utils"

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn("rounded-md px-2 py-1 text-sm transition-colors hover:text-foreground", isActive ? "text-foreground" : "text-muted-foreground")

export function AppLayout({ walletSlot, credentialSlot }: { walletSlot?: ReactNode; credentialSlot?: ReactNode }) {
  const { defaultSymbol, cluster } = clusterConfig()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 px-4 sm:h-14 sm:flex-nowrap">
          <NavLink to={paths.home} className="flex h-14 items-center font-semibold tracking-tight">Bellwether</NavLink>
          {cluster !== "mainnet" && (
            <span className="rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">{cluster}</span>
          )}
          <nav className="order-last -mx-2 flex w-full items-center gap-1 overflow-x-auto pb-2 sm:order-none sm:mx-0 sm:ml-2 sm:w-auto sm:pb-0" aria-label="Main">
            <NavLink to={paths.trade(defaultSymbol)} className={navClass}>Trade</NavLink>
            <NavLink to={paths.liquidity(defaultSymbol)} className={navClass}>Liquidity</NavLink>
            <NavLink to={paths.explorer} className={navClass}>Explorer</NavLink>
            <NavLink to={paths.about} className={navClass}>About</NavLink>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="hidden sm:block">{credentialSlot ?? <CredentialBadge />}</div>
            {walletSlot ?? <WalletButton />}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full min-w-0 max-w-7xl flex-1">
        <Outlet />
      </main>
    </div>
  )
}

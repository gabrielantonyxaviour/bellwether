/** Operator workbench shell: left sidebar with the six operator pages (a scrolling top bar below md). */
import { NavLink, Outlet } from "react-router"
import { paths } from "@/app/paths"
import { WalletButton } from "@/app/wallet-button"
import { clusterConfig } from "@/lib/cluster"
import { cn } from "@/lib/utils"

const OPERATOR_NAV = [
  { to: paths.operator.overview, label: "Overview", end: true },
  { to: paths.operator.symbols, label: "Symbols" },
  { to: paths.operator.halts, label: "Halts" },
  { to: paths.operator.participants, label: "Participants" },
  { to: paths.operator.publicNotice, label: "Public notice" },
  { to: paths.operator.rehearsal, label: "FWDI rehearsal" },
] as const

const itemClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-sidebar-accent",
    isActive ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground",
  )

export function OperatorLayout() {
  const { cluster } = clusterConfig()
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-b bg-sidebar md:sticky md:top-0 md:h-dvh md:w-56 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex h-14 items-center gap-2 px-4">
          <NavLink to={paths.home} className="font-semibold tracking-tight">Bellwether</NavLink>
          <span className="font-mono text-[10px] uppercase text-muted-foreground">Operator · {cluster}</span>
          <div className="ml-auto md:hidden">
            <WalletButton />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible" aria-label="Operator">
          {OPERATOR_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={"end" in item} className={itemClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="hidden h-14 items-center justify-end gap-2 border-b px-4 md:flex">
          <WalletButton />
        </header>
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

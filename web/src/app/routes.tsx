/**
 * Route table for all 12 surfaces. Screens load lazily from their block's folder:
 *   src/routes/public   (blk_ui_public)       HomePage, TapePage, ProofPage
 *   src/routes/app      (blk_ui_participant)  OnboardPage, TradePage, LiquidityPage
 *   src/routes/operator (blk_ui_operator)     Operator*Page ×6
 * A screen builder replaces its folder's index.tsx exports.
 * /explorer and /about are the public routes; /tape and /proof redirect there.
 */
import { createBrowserRouter, Navigate, type RouteObject } from "react-router"
import { AppLayout } from "@/app/layouts/app-layout"
import { OperatorLayout } from "@/app/layouts/operator-layout"
import { NotFound, RouteError } from "@/app/route-error"
import { clusterConfig } from "@/lib/cluster"

const publicScreen = (name: "HomePage" | "TapePage" | "ProofPage") => async () => ({
  Component: (await import("@/routes/public"))[name],
})
const appScreen = (name: "OnboardPage" | "TradePage" | "LiquidityPage") => async () => ({
  Component: (await import("@/routes/app"))[name],
})
type OperatorScreen =
  | "OperatorOverviewPage"
  | "OperatorSymbolsPage"
  | "OperatorHaltsPage"
  | "OperatorParticipantsPage"
  | "OperatorPublicNoticePage"
  | "OperatorRehearsalPage"
const operatorScreen = (name: OperatorScreen) => async () => ({
  Component: (await import("@/routes/operator"))[name],
})

function DefaultSymbolRedirect({ to }: { to: "trade" | "liquidity" }) {
  return <Navigate replace to={`/app/${to}/${clusterConfig().defaultSymbol}`} />
}

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { path: "/", lazy: publicScreen("HomePage") },
      { path: "/explorer", lazy: publicScreen("TapePage") },
      { path: "/about", lazy: publicScreen("ProofPage") },
      { path: "/tape", element: <Navigate replace to="/explorer" /> },
      { path: "/proof", element: <Navigate replace to="/about" /> },
      { path: "/app", element: <Navigate replace to="/app/onboard" /> },
      { path: "/app/onboard", lazy: appScreen("OnboardPage") },
      { path: "/app/trade", element: <DefaultSymbolRedirect to="trade" /> },
      { path: "/app/trade/:symbol", lazy: appScreen("TradePage") },
      { path: "/app/liquidity", element: <DefaultSymbolRedirect to="liquidity" /> },
      { path: "/app/liquidity/:symbol", lazy: appScreen("LiquidityPage") },
      { path: "*", element: <NotFound /> },
    ],
  },
  {
    path: "/operator",
    element: <OperatorLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, lazy: operatorScreen("OperatorOverviewPage") },
      { path: "symbols", lazy: operatorScreen("OperatorSymbolsPage") },
      { path: "halts", lazy: operatorScreen("OperatorHaltsPage") },
      { path: "participants", lazy: operatorScreen("OperatorParticipantsPage") },
      { path: "public-notice", lazy: operatorScreen("OperatorPublicNoticePage") },
      { path: "rehearsal/fwdi", lazy: operatorScreen("OperatorRehearsalPage") },
    ],
  },
]

export const createRouter = () => createBrowserRouter(routes)

/**
 * Participant screens (blk_ui_participant). Placeholder until the screen builder replaces it.
 * Contract with src/app/routes.tsx: keep these three named exports. Read :symbol with useParams().
 */
import { useParams } from "react-router"
import { ComingSoon } from "@/components/coming-soon"

export function OnboardPage() {
  return <ComingSoon screen="Get admitted" surface="pg_onboard" />
}

export function TradePage() {
  const { symbol } = useParams()
  return <ComingSoon screen={`Trade ${symbol ?? ""}`.trim()} surface="pg_trade" />
}

export function LiquidityPage() {
  const { symbol } = useParams()
  return <ComingSoon screen={`Provide liquidity ${symbol ?? ""}`.trim()} surface="pg_liquidity" />
}

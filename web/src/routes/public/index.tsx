/**
 * Public screens (blk_ui_public). Placeholder until the screen builder replaces it.
 * Contract with src/app/routes.tsx: keep these three named exports.
 */
import { ComingSoon } from "@/components/coming-soon"

export function HomePage() {
  return <ComingSoon screen="Home" surface="pg_home" />
}

export function TapePage() {
  return <ComingSoon screen="Public tape" surface="pg_tape" />
}

export function ProofPage() {
  return <ComingSoon screen="Proof and environments" surface="pg_proof" />
}

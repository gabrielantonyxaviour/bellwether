/**
 * Operator workbench screens (blk_ui_operator). Placeholder until the screen builder replaces it.
 * Contract with src/app/routes.tsx: keep these six named exports.
 */
import { ComingSoon } from "@/components/coming-soon"

export function OperatorOverviewPage() {
  return <ComingSoon screen="Operator overview" surface="pg_op_overview" />
}

export function OperatorSymbolsPage() {
  return <ComingSoon screen="Symbols and issuer notices" surface="pg_op_symbols" />
}

export function OperatorHaltsPage() {
  return <ComingSoon screen="Halts and latency" surface="pg_op_halts" />
}

export function OperatorParticipantsPage() {
  return <ComingSoon screen="Participants" surface="pg_op_participants" />
}

export function OperatorPublicNoticePage() {
  return <ComingSoon screen="Public notice builder" surface="pg_op_notice" />
}

export function OperatorRehearsalPage() {
  return <ComingSoon screen="FWDI launch rehearsal" surface="pg_op_rehearsal" />
}

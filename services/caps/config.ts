/**
 * Caps job configuration: which NMS stock's volume each on-chain ticker follows, the tier rules,
 * and the documented tier overrides used when the iShares holdings files cannot be read.
 */

/** On-chain ticker → the NMS stock whose consolidated volume sets its cap. Unlisted tickers follow themselves. */
export const SYMBOL_MAP: Record<string, { volumeSymbol: string; note: string }> = {
  BWRS: {
    volumeSymbol: "FWDI",
    note: "Bellwether rehearsal stock mirrors FWDI (blk_rehearsal_assets); its cap follows FWDI's prior-month consolidated volume.",
  },
}

export function volumeSymbolFor(ticker: string, map = SYMBOL_MAP): { volumeSymbol: string; note: string | null } {
  const entry = map[ticker]
  return entry ? { volumeSymbol: entry.volumeSymbol, note: entry.note } : { volumeSymbol: ticker, note: null }
}

/**
 * Tier volume caps, order §II.F: Tier 1 0.25%, Tier 2 2.5% of prior-month average daily share
 * volume. Kept as exact fractions so on-chain units are computed without floating point.
 */
export const TIER_RATE = {
  1: { percent: 0.25, num: 25n, den: 10_000n },
  2: { percent: 2.5, num: 25n, den: 1_000n },
} as const

export type Tier = 1 | 2

/**
 * Tier 1 membership lists: iShares funds that hold the S&P 500 (IVV) and the Russell 1000 (IWB).
 * `minRows` rejects a truncated or placeholder file.
 */
export const TIER1_LISTS = {
  ivv: {
    index: "S&P 500",
    url: "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund",
    minRows: 400,
  },
  iwb: {
    index: "Russell 1000",
    url: "https://www.ishares.com/us/products/239707/ishares-russell-1000-etf/1467271812596.ajax?fileType=csv&fileName=IWB_holdings&dataType=fund",
    minRows: 800,
  },
} as const

export type ListKey = keyof typeof TIER1_LISTS

/**
 * Documented tier overrides, used only when the iShares lists cannot settle the tier (a list is
 * unreachable) or to mark an eligible ETP (LULD Plan Appendix A, Schedule 1), which neither list
 * covers. Every entry is reported as inferred. Re-check at each index reconstitution.
 */
export const TIER_OVERRIDES: Record<string, { tier: Tier; reason: string; checked: string }> = {
  FWDI: {
    tier: 2,
    reason: "Forward Industries is a Russell 2000 (small-cap) member, not in the S&P 500 or Russell 1000, and not an ETP on LULD Appendix A Schedule 1.",
    checked: "2026-09-25",
  },
}

/** A Nasdaq vs Yahoo ADV disagreement above this is flagged in provenance. */
export const DISAGREEMENT_THRESHOLD_PCT = 1

/** Default lead: a run within 4 h before a trade-date start computes for that trade date. */
export const DEFAULT_LEAD_SECONDS = 4 * 3600

/**
 * One symbol's daily cap, from volume and tier to on-chain units — no chain access.
 *
 * status 'complete': both volume sources answered and the tier is known → a cap number.
 * status 'partial':  a volume source or the tier is missing → adv and cap are null. The job never
 *                    writes a cap from partial data; the on-chain value stays as it was.
 * A cross-check disagreement above 1% is flagged but keeps Nasdaq (consolidated) as the basis.
 */
import { DEFAULT_LEAD_SECONDS, volumeSymbolFor } from "./config.js"
import { classifyTier, fetchTierList, type TierLists, type TierResult } from "./tier.js"
import { advUnits, capUnits, multiplierRational, targetTradeDate } from "./units.js"
import { fetchMonthVolume, type MonthVolume, type VolumeSource } from "./volume.js"

export type Missing = VolumeSource | "tier"

export interface SymbolCap {
  ticker: string
  volumeSymbol: string
  mapping: string | null
  tradeDate: string
  month: string
  status: "complete" | "partial"
  missing: Missing[]
  volume: MonthVolume
  tier: TierResult
  adv: { shares: number; totalShares: number; days: number } | null
  cap: {
    shares: number
    wholeShares: number
    units: bigint
    advUnits: bigint
    decimals: number
    multiplier: { value: number; num: number; den: number }
  } | null
  errors: string[]
}

export async function loadTierLists(fetchImpl: typeof fetch = fetch): Promise<TierLists> {
  const [ivv, iwb] = await Promise.all([fetchTierList("ivv", fetchImpl), fetchTierList("iwb", fetchImpl)])
  return { ivv, iwb }
}

export interface ComputeOptions {
  ticker: string
  now: Date
  cutoffSeconds: number
  decimals: number
  multiplier: number
  fetchImpl?: typeof fetch
  /** Tier lists loaded once per run; fetched here when omitted. */
  lists?: TierLists
  /** Volume already fetched this run for the same NMS stock and month. */
  volume?: MonthVolume
  leadSeconds?: number
}

export async function computeSymbolCap(o: ComputeOptions): Promise<SymbolCap> {
  const { volumeSymbol, note } = volumeSymbolFor(o.ticker)
  const tradeDate = targetTradeDate(o.now, o.cutoffSeconds, o.leadSeconds ?? DEFAULT_LEAD_SECONDS)
  const volume = o.volume ?? (await fetchMonthVolume(volumeSymbol, tradeDate, o.fetchImpl))
  const tier = classifyTier(volumeSymbol, o.lists ?? (await loadTierLists(o.fetchImpl)))
  const missing: Missing[] = [...volume.missing, ...(tier.tier === null ? (["tier"] as const) : [])]
  const errors = [...volume.errors, ...(tier.tier === null ? [`tier: ${tier.reason}`] : [])]
  const base = { ticker: o.ticker, volumeSymbol, mapping: note, tradeDate, month: volume.month, volume, tier, errors }

  if (missing.length > 0 || !volume.nasdaq || tier.tier === null) {
    return { ...base, status: "partial", missing, adv: null, cap: null }
  }
  const { totalShares, days } = volume.nasdaq
  const multiplier = multiplierRational(o.multiplier)
  const adv = totalShares / days
  const shares = (adv * (tier.percent ?? 0)) / 100
  return {
    ...base, status: "complete", missing,
    adv: { shares: adv, totalShares, days },
    cap: {
      shares, wholeShares: Math.floor(shares),
      units: capUnits(BigInt(totalShares), BigInt(days), o.decimals, tier.tier),
      advUnits: advUnits(BigInt(totalShares), BigInt(days), o.decimals),
      decimals: o.decimals, multiplier: { value: o.multiplier, ...multiplier },
    },
  }
}

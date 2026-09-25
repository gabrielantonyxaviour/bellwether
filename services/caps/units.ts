/**
 * Exact on-chain units and trade dates.
 *
 * The venue program keeps adv_shares and cap_shares in share units (shares × 10^decimals) and
 * converts each swap's token amount to share units with the multiplier num/den (share units per
 * token unit — the Token-2022 ScaledUiAmount multiplier). So the cap itself is shares × 10^decimals
 * and the multiplier travels separately in set_cap; it is never folded into the cap.
 */
import { TIER_RATE, type Tier } from "./config.js"

const DAY = 86_400

/** ⌊total × 10^decimals ÷ days⌋: prior-month ADV in share units. */
export function advUnits(totalShares: bigint, days: bigint, decimals: number): bigint {
  if (days <= 0n) throw new Error("ADV needs at least one trading day")
  return (totalShares * 10n ** BigInt(decimals)) / days
}

/** ⌊total × 10^decimals × rate ÷ days⌋: the daily share budget in share units, rounded down. */
export function capUnits(totalShares: bigint, days: bigint, decimals: number, tier: Tier): bigint {
  if (days <= 0n) throw new Error("a cap needs at least one trading day")
  const rate = TIER_RATE[tier]
  return (totalShares * 10n ** BigInt(decimals) * rate.num) / (days * rate.den)
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b))
const U32_MAX = 0xffff_ffffn

/** A positive multiplier (f64 on the mint) as an exact u32 fraction, or an error if it has no such form. */
export function multiplierRational(m: number): { num: number; den: number } {
  if (!Number.isFinite(m) || m <= 0) throw new Error(`share multiplier ${m} is not a positive number`)
  for (let den = 1n; den <= 1_000_000_000n; den *= 10n) {
    const num = BigInt(Math.round(m * Number(den)))
    if (Math.abs(Number(num) / Number(den) - m) <= Number.EPSILON * Math.max(1, m)) {
      const g = gcd(num, den)
      const [n, d] = [num / g, den / g]
      if (n > 0n && n <= U32_MAX && d <= U32_MAX) return { num: Number(n), den: Number(d) }
    }
  }
  throw new Error(`share multiplier ${m} has no exact u32 fraction`)
}

/** The program's trade-date index: days since 1970-01-01 after the cutoff, Sat/Sun folded into Friday. */
export function tradeDateIndex(unixSeconds: number, cutoffSeconds: number): number {
  const d = Math.floor(Math.max(0, unixSeconds - cutoffSeconds) / DAY)
  const weekday = (d + 4) % 7 // 1970-01-01 was a Thursday: 0 = Sunday … 6 = Saturday
  return weekday === 6 ? d - 1 : weekday === 0 ? d - 2 : d
}

export const dateOfIndex = (index: number) => new Date(index * DAY * 1000).toISOString().slice(0, 10)

/**
 * The trade date a run at `now` sets the cap for: the one in force `leadSeconds` later, so a run
 * shortly before a trade-date start prepares that trade date (and a month's first trade date gets
 * the new month's figure before it opens).
 */
export function targetTradeDate(now: Date, cutoffSeconds: number, leadSeconds: number): string {
  return dateOfIndex(tradeDateIndex(Math.floor(now.getTime() / 1000) + leadSeconds, cutoffSeconds))
}

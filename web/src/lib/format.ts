/** Exact conversions between on-chain base units (bigint) and decimal strings. No floats. */

/** 1234500n, 6 → "1.2345" */
export function formatUnits(units: bigint, decimals: number): string {
  const negative = units < 0n
  const abs = negative ? -units : units
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = decimals > 0 ? (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "") : ""
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`
}

/** "1.2345", 6 → 1234500n. Throws on malformed input or more fractional digits than decimals. */
export function parseUnits(value: string, decimals: number): bigint {
  const v = value.trim()
  const m = v.match(/^(\d*)(?:\.(\d*))?$/)
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new RangeError(`not an amount: "${value}"`)
  const frac = m[2] ?? ""
  if (frac.length > decimals) throw new RangeError(`at most ${decimals} decimal places`)
  return BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")
}

/** "1234.5" → "1,234.50" for USD display; keeps the exact string when it is not numeric. */
export function formatUsd(decimal: string, fractionDigits = 2): string {
  const n = Number(decimal)
  return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }) : decimal
}

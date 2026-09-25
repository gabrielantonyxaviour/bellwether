/** Fixed facts for the FWDI rehearsal: addresses, known programs, verified account layouts. */

export const FWDI_MINT = "7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9"
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
export const SYSTEM_PROGRAM = "11111111111111111111111111111111"
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
export const MANIFEST_PROGRAM = "MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms"

export const DEFAULT_MAINNET_RPC = "https://api.mainnet-beta.solana.com"
export const SYMBOL = "FWDI"
/** Forward Industries traded as FORD on Nasdaq before the FWDI ticker. */
export const HALT_SYMBOLS = ["FWDI", "FORD"] as const
export const TIER_PERCENT = 2.5
export const TIER_LABEL = "Tier 2 (inferred: Russell 2000 member, not S&P 500/Russell 1000)"
export const DISAGREEMENT_THRESHOLD_PCT = 1
export const ACTIVITY_WINDOW_DAYS = 30
/**
 * Nasdaq.com needs a browser-like User-Agent; Yahoo answers 429 to a full Chrome UA string sent
 * without Chrome's other headers but serves the bare "Mozilla/5.0" (verified 2026-09-25).
 */
export const BROWSER_UA = "Mozilla/5.0"

export interface DexLayout {
  program: string
  name: string
  kind: "clob" | "amm" | "clmm" | "dlmm"
  /** Byte offsets of [mint A / base, mint B / quote] and their vaults in the market account. */
  mintOffsets: readonly [number, number]
  vaultOffsets: readonly [number, number]
}

/**
 * Venues that accept Token-2022 mints. Mint and vault offsets were verified on 2026-09-25 by
 * reading three live SOL/USDC markets per program and confirming each vault offset holds a
 * token account of the mint at the matching mint offset.
 */
export const DEX_LAYOUTS: readonly DexLayout[] = [
  { program: MANIFEST_PROGRAM, name: "Manifest", kind: "clob", mintOffsets: [16, 48], vaultOffsets: [80, 112] },
  { program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", name: "Orca Whirlpool", kind: "clmm", mintOffsets: [101, 181], vaultOffsets: [133, 213] },
  { program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", name: "Raydium CLMM", kind: "clmm", mintOffsets: [73, 105], vaultOffsets: [137, 169] },
  { program: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", name: "Raydium CPMM", kind: "amm", mintOffsets: [168, 200], vaultOffsets: [72, 104] },
  { program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", name: "Meteora DLMM", kind: "dlmm", mintOffsets: [88, 120], vaultOffsets: [152, 184] },
  { program: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", name: "Meteora DAMM v2", kind: "amm", mintOffsets: [168, 200], vaultOffsets: [232, 264] },
  { program: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", name: "PumpSwap", kind: "amm", mintOffsets: [43, 75], vaultOffsets: [139, 171] },
]

/** Other DEX/aggregator programs: a transaction invoking one counts as a trade attempt. */
export const OTHER_DEX_PROGRAMS: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: "Phoenix",
  opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: "OpenBook v2",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora DAMM v1",
}

export const LENDING_PROGRAMS: Record<string, string> = {
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: "Kamino Lend",
  "1oopBoJG58DgkUVKkEzKgyG9dvRmpgeEm1AVjoHkF78": "Loopscale",
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FJnsebVacA: "marginfi",
  So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo: "Solend",
}

export const DEX_PROGRAM_NAMES: Record<string, string> = {
  ...Object.fromEntries(DEX_LAYOUTS.map((d) => [d.program, d.name])),
  ...OTHER_DEX_PROGRAMS,
}

export function programLabel(program: string | null): string {
  if (program === null) return "no account (PDA or empty wallet)"
  if (program === SYSTEM_PROGRAM) return "wallet (System)"
  if (program === TOKEN_2022_PROGRAM) return "a Token-2022 account (nested)"
  return DEX_PROGRAM_NAMES[program] ?? LENDING_PROGRAMS[program] ?? `program ${program}`
}

/** The prior calendar month relative to `now`, in UTC. */
export function priorMonth(now: Date): { key: string; from: string; to: string; period1: number; period2: number } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const last = new Date(end.getTime() - 86_400_000)
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  return {
    key: ymd(start).slice(0, 7), from: ymd(start), to: ymd(last),
    period1: Math.floor(start.getTime() / 1000), period2: Math.floor(end.getTime() / 1000),
  }
}

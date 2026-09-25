/**
 * The venue program's custom errors (6000–6016, programs/venue/src/error.rs) as plain states a
 * screen can show, plus extraction of the code from whatever a wallet or RPC threw.
 */
import { isSolanaError, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM } from "@solana/kit"

export const VENUE_ERRORS = {
  6000: { name: "NotAdmitted", message: "Not admitted · Get admitted →", action: "/app/onboard" },
  6001: { name: "TradingHalted", message: "Halted by Nasdaq" },
  6002: { name: "HaltDataStale", message: "Halt data stale · trading paused" },
  6003: { name: "NotActive", message: "Not active yet · issuer notice window" },
  6004: { name: "Paused", message: "Paused 3 months after a second breach" },
  6005: { name: "CapReached", message: "Daily cap reached · resets 04:00 ET" },
  6006: { name: "SlippageExceeded", message: "Price moved past your slippage limit" },
  6007: { name: "SymbolCapReached", message: "Symbol limit for this tier reached" },
  6008: { name: "NoticeWindowOpen", message: "Issuer notice window still open (30 days)" },
  6009: { name: "Objected", message: "Issuer objected · symbol cannot activate" },
  6010: { name: "Unauthorized", message: "This wallet is not authorised for that action" },
  6011: { name: "InvalidAccount", message: "An account in the transaction is not the one the venue expects" },
  6012: { name: "InsufficientShares", message: "Not enough LP shares" },
  6013: { name: "StaleSequence", message: "Relay sequence is out of date" },
  6014: { name: "InvalidAmount", message: "Amount is zero or too small to fill" },
  6015: { name: "AlreadyInitialized", message: "Already set up" },
  6016: { name: "InvalidArgument", message: "Invalid input" },
} as const satisfies Record<number, { name: string; message: string; action?: string }>

export type VenueErrorCode = keyof typeof VENUE_ERRORS
export type VenueErrorName = (typeof VENUE_ERRORS)[VenueErrorCode]["name"]

export interface VenueError {
  code: VenueErrorCode
  name: VenueErrorName
  message: string
  /** In-app route that resolves the state (e.g. onboarding for NotAdmitted). */
  action?: string
}

export function venueError(code: number): VenueError | null {
  const e = (VENUE_ERRORS as Record<number, { name: VenueErrorName; message: string; action?: string }>)[code]
  return e ? { code: code as VenueErrorCode, ...e } : null
}

export function venueErrorByName(name: VenueErrorName): VenueError {
  const code = Number(Object.keys(VENUE_ERRORS).find((k) => VENUE_ERRORS[Number(k) as VenueErrorCode].name === name))
  return venueError(code)!
}

/**
 * Finds a custom program error code in a thrown value: a kit SolanaError, a simulation or RPC
 * error object ({ InstructionError: [i, { Custom: n }] }), or wallet text such as
 * "custom program error: 0x1771".
 */
export function customErrorCode(error: unknown, depth = 0): number | null {
  if (error == null || depth > 6) return null
  if (isSolanaError(error, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return Number(error.context.code)
  if (typeof error === "string") {
    const hex = error.match(/custom program error: 0x([0-9a-f]+)/i)
    if (hex) return parseInt(hex[1], 16)
    const dec = error.match(/"?Custom"?\s*[:(]\s*(\d+)/)
    return dec ? Number(dec[1]) : null
  }
  if (typeof error !== "object") return null
  const o = error as Record<string, unknown>
  // kit's RPC may hand numeric fields back as bigint.
  if (typeof o.Custom === "number" || typeof o.Custom === "bigint") return Number(o.Custom)
  if (Array.isArray(o.InstructionError)) return customErrorCode(o.InstructionError[1], depth + 1)
  for (const key of ["cause", "err", "error", "data", "context", "logs", "message"]) {
    const v = o[key]
    const found = Array.isArray(v) ? v.map((x) => customErrorCode(x, depth + 1)).find((x) => x !== null) : customErrorCode(v, depth + 1)
    if (found != null) return found
  }
  return null
}

/** The plain venue state for a thrown value, or null when it is not a venue rejection. */
export function toVenueError(error: unknown): VenueError | null {
  const code = customErrorCode(error)
  return code === null ? null : venueError(code)
}

/** One line for a toast or inline error: the venue state if known, else the error's own text. */
export function describeError(error: unknown): string {
  const venue = toVenueError(error)
  if (venue) return venue.message
  if (error instanceof Error && /reject|denied|cancel/i.test(error.message)) return "Signature request declined"
  return error instanceof Error ? error.message : "Transaction failed"
}

/**
 * The venue's tape event and how to find it in a transaction's logs.
 *
 * Every swap emits one `Program data:` slice of 228 bytes tagged "BWTRADE1" (layout in
 * docs/program-contract.md, source programs/venue/src/swap.rs). A slice only counts when the
 * venue program itself emitted it: logs are attributed to programs by replaying the
 * invoke/success stack, so another program cannot forge a print by logging the same bytes.
 */
import { getAddressDecoder } from "@solana/kit"

export const EVENT_LEN = 228
export const EVENT_TAG = "BWTRADE1"
export const BUY = 0
export const SELL = 1

export interface TradeEvent {
  ticker: string
  stockMint: string
  usdcMint: string
  pool: string
  program: string
  direction: typeof BUY | typeof SELL
  stockDecimals: number
  usdcDecimals: number
  stockAmount: bigint
  usdcAmount: bigint
  /** USDC base units per one whole stock token (floor). */
  priceUnits: bigint
  /** Unix seconds from the Clock sysvar inside the swap: the time at the pool. */
  time: number
  /** Share units (shares × 10^stockDecimals, after the token's share multiplier). */
  shareUnits: bigint
  /** Day index (days since 1970-01-01) of the venue trade date. */
  tradeDate: number
  sharesTradedToday: bigint
  reserveStock: bigint
  reserveUsdc: bigint
  /** Fee kept by the pool, in the input asset's base units. */
  fee: bigint
}

const addressDecoder = getAddressDecoder()

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function ascii(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) {
    if (b === 0) break
    s += String.fromCharCode(b)
  }
  return s
}

/** Decodes one tape event, or returns null when the bytes are not a BWTRADE1 event. */
export function decodeTradeEvent(bytes: Uint8Array): TradeEvent | null {
  if (bytes.length !== EVENT_LEN || ascii(bytes.subarray(0, 8)) !== EVENT_TAG) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u64 = (o: number) => view.getBigUint64(o, true)
  const i64 = (o: number) => Number(view.getBigInt64(o, true))
  const key = (o: number) => addressDecoder.decode(bytes.subarray(o, o + 32))
  const direction = bytes[144]
  if (direction !== BUY && direction !== SELL) return null
  return {
    ticker: ascii(bytes.subarray(8, 16)),
    stockMint: key(16),
    usdcMint: key(48),
    pool: key(80),
    program: key(112),
    direction,
    stockDecimals: bytes[145],
    usdcDecimals: bytes[146],
    stockAmount: u64(148),
    usdcAmount: u64(156),
    priceUnits: u64(164),
    time: i64(172),
    shareUnits: u64(180),
    tradeDate: i64(188),
    sharesTradedToday: u64(196),
    reserveStock: u64(204),
    reserveUsdc: u64(212),
    fee: u64(220),
  }
}

const INVOKE = /^Program (\S+) invoke \[\d+\]$/
const FINISH = /^Program (\S+) (?:success|failed\b.*)$/
const DATA = /^Program data: (.*)$/

/**
 * `Program data:` payloads emitted directly by `programId`, in log order. Replays the invoke
 * stack; stops at a "Log truncated" marker because attribution after it is unknowable.
 */
export function programDataFrom(logs: readonly string[], programId: string): { payloads: string[][]; truncated: boolean } {
  const stack: string[] = []
  const payloads: string[][] = []
  for (const line of logs) {
    if (line === "Log truncated") return { payloads, truncated: true }
    const invoke = INVOKE.exec(line)
    if (invoke) {
      stack.push(invoke[1])
      continue
    }
    const finish = FINISH.exec(line)
    if (finish) {
      if (stack.at(-1) === finish[1]) stack.pop()
      continue
    }
    const data = DATA.exec(line)
    if (data && stack.at(-1) === programId) payloads.push(data[1].trim().split(/\s+/).filter(Boolean))
  }
  return { payloads, truncated: false }
}

/** Every tape event the venue program emitted in one transaction's logs. */
export function tradeEventsFromLogs(logs: readonly string[], programId: string): { events: TradeEvent[]; truncated: boolean } {
  const { payloads, truncated } = programDataFrom(logs, programId)
  const events: TradeEvent[] = []
  for (const slices of payloads) {
    if (slices.length !== 1) continue
    let bytes: Uint8Array
    try {
      bytes = base64ToBytes(slices[0])
    } catch {
      continue
    }
    const event = decodeTradeEvent(bytes)
    if (event && event.program === programId) events.push(event)
  }
  return { events, truncated }
}

/**
 * The venue program's relay surface (programs/venue/src/rules/halts.rs, state.rs):
 * PDAs, the three relay instructions and read-only views of VenueConfig and SymbolRecord.
 *
 *   17 set_halt   seq u64 | reason [u8; 8] (Nasdaq code, zero-padded) | feed_ts i64 (halt instant, unix s)
 *   18 clear_halt seq u64 (counts as a heartbeat)
 *   19 heartbeat  seq u64
 *   accounts: relay authority (signer), venue, symbol (writable)
 *
 * The sequence is per symbol and strictly increasing across all three; the program refuses a
 * sequence at or below the stored one with StaleSequence (6013).
 */
import {
  AccountRole, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress,
  type AccountSignerMeta, type Address, type Instruction, type TransactionSigner,
} from "@solana/kit"

export const IX = { SET_HALT: 17, CLEAR_HALT: 18, HEARTBEAT: 19 } as const

/** Custom program errors (ProgramError::Custom), programs/venue/src/error.rs. */
export const VENUE_ERRORS = {
  NotAdmitted: 6000, TradingHalted: 6001, HaltDataStale: 6002, NotActive: 6003, Paused: 6004, CapReached: 6005,
  SlippageExceeded: 6006, SymbolCapReached: 6007, NoticeWindowOpen: 6008, Objected: 6009, Unauthorized: 6010,
  InvalidAccount: 6011, InsufficientShares: 6012, StaleSequence: 6013, InvalidAmount: 6014, AlreadyInitialized: 6015,
  InvalidArgument: 6016,
} as const
export type VenueErrorName = keyof typeof VENUE_ERRORS

/** The venue error named in an error string (`"Custom":6001` or `custom program error: 0x1771`), if any. */
export function venueErrorIn(text: string): VenueErrorName | null {
  const m = text.match(/"Custom"\s*:\s*(\d+)/) ?? text.match(/custom program error: (0x[0-9a-f]+)/i)
  if (!m) return null
  const code = Number(m[1])
  return (Object.entries(VENUE_ERRORS).find(([, c]) => c === code)?.[0] as VenueErrorName | undefined) ?? null
}

export const VENUE_LEN = 248
export const SYMBOL_LEN = 168
const SYMBOL_DISC = 2
const VENUE_DISC = 1

const enc = getAddressEncoder()
const dec = getAddressDecoder()
const utf8 = new TextEncoder()

export async function findVenueConfig(programId: Address, admin: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: programId, seeds: ["venue", enc.encode(admin)] })
  return pda
}

export async function findSymbolRecord(programId: Address, venue: Address, stockMint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: programId, seeds: ["symbol", enc.encode(venue), enc.encode(stockMint)] })
  return pda
}

/** ASCII code into a zero-padded 8-byte field (tickers and Nasdaq reason codes). */
export function code8(value: string): Uint8Array {
  const bytes = utf8.encode(value)
  if (bytes.length > 8 || /[^\x20-\x7e]/.test(value)) throw new Error(`"${value}" does not fit an 8-byte ASCII field`)
  const out = new Uint8Array(8)
  out.set(bytes)
  return out
}

function readCode8(d: Uint8Array, at: number): string {
  return new TextDecoder().decode(d.subarray(at, at + 8)).replace(/\0+$/, "")
}

interface RelayIxBase { programId: Address; relay: TransactionSigner; venue: Address; symbol: Address; seq: bigint }

function relayIx(base: RelayIxBase, disc: number, extra: Uint8Array = new Uint8Array(0)): Instruction {
  if (base.seq <= 0n || base.seq >= 1n << 64n) throw new Error(`relay sequence out of range: ${base.seq}`)
  const data = new Uint8Array(9 + extra.length)
  const view = new DataView(data.buffer)
  data[0] = disc
  view.setBigUint64(1, base.seq, true)
  data.set(extra, 9)
  const authority: AccountSignerMeta = { address: base.relay.address, role: AccountRole.READONLY_SIGNER, signer: base.relay }
  return {
    programAddress: base.programId,
    accounts: [
      authority,
      { address: base.venue, role: AccountRole.READONLY },
      { address: base.symbol, role: AccountRole.WRITABLE },
    ],
    data,
  }
}

export function setHaltInstruction(input: RelayIxBase & { reason: string; feedTs: bigint }): Instruction {
  const extra = new Uint8Array(16)
  extra.set(code8(input.reason), 0)
  new DataView(extra.buffer).setBigInt64(8, input.feedTs, true)
  return relayIx(input, IX.SET_HALT, extra)
}

export function clearHaltInstruction(input: RelayIxBase): Instruction {
  return relayIx(input, IX.CLEAR_HALT)
}

export function heartbeatInstruction(input: RelayIxBase): Instruction {
  return relayIx(input, IX.HEARTBEAT)
}

export interface SymbolRecordView {
  tier: number
  sponsored: boolean
  active: boolean
  halted: boolean
  haltReason: string
  ticker: string
  venue: Address
  mint: Address
  lastHeartbeat: bigint
  seq: bigint
  /** Feed timestamp (unix s) of the current halt; 0 when not halted. */
  haltedAt: bigint
}

export function decodeSymbolRecord(d: Uint8Array): SymbolRecordView {
  if (d.length < SYMBOL_LEN || d[0] !== SYMBOL_DISC) throw new Error("not a SymbolRecord account")
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  return {
    tier: d[2], sponsored: d[3] !== 0, active: d[4] !== 0, halted: d[5] !== 0,
    ticker: readCode8(d, 8), haltReason: readCode8(d, 16),
    venue: dec.decode(d.subarray(24, 56)), mint: dec.decode(d.subarray(56, 88)),
    lastHeartbeat: v.getBigInt64(136, true), seq: v.getBigUint64(144, true), haltedAt: v.getBigInt64(160, true),
  }
}

export interface VenueConfigView {
  heartbeatMaxAge: bigint
  admin: Address
  relay: Address
  dataAuthority: Address
}

export function decodeVenueConfig(d: Uint8Array): VenueConfigView {
  if (d.length < VENUE_LEN || d[0] !== VENUE_DISC) throw new Error("not a VenueConfig account")
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  return {
    heartbeatMaxAge: v.getBigInt64(8, true),
    admin: dec.decode(d.subarray(24, 56)), relay: dec.decode(d.subarray(56, 88)), dataAuthority: dec.decode(d.subarray(88, 120)),
  }
}

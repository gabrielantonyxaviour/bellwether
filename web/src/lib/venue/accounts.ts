/**
 * Account decoders for the venue program (docs/program-contract.md, programs/venue/src/state.rs).
 * Every account starts [discriminator u8][bump u8]; integers are little-endian.
 */
import { getAddressDecoder, type Address } from "@solana/kit"

export const DISC = { venue: 1, symbol: 2, pool: 3, lp: 4, member: 5 } as const
export const LEN = { venue: 248, symbol: 168, pool: 192, lp: 80, member: 80 } as const

/** VenueConfig.gate flags. */
export const GATE_SAS = 1
export const GATE_MEMBER = 2

export interface VenueConfig {
  bump: number
  gate: number
  tier1Count: number
  tier2Count: number
  heartbeatMaxAge: bigint
  tradeDateCutoff: bigint
  admin: Address
  relay: Address
  dataAuthority: Address
  credentialIssuer: Address
  sasCredential: Address
  sasSchema: Address
  affiliateGroup: Address
}

export interface SymbolRecord {
  bump: number
  tier: number
  issuerSponsored: boolean
  /** activation_state byte; non-zero = active. */
  active: boolean
  halted: boolean
  objected: boolean
  breachCount: number
  ticker: string
  haltReason: string
  venue: Address
  mint: Address
  advShares: bigint
  capShares: bigint
  multiplierNum: number
  multiplierDen: number
  tradeDate: bigint
  sharesTradedToday: bigint
  pausedUntil: bigint
  lastHeartbeat: bigint
  relaySeq: bigint
  noticeReceivedAt: bigint
  haltedAt: bigint
}

export interface Pool {
  bump: number
  stockDecimals: number
  usdcDecimals: number
  feeBps: number
  symbol: Address
  stockMint: Address
  usdcMint: Address
  stockVault: Address
  usdcVault: Address
  reserveStock: bigint
  reserveUsdc: bigint
  lpTotal: bigint
}

export interface LpPosition {
  bump: number
  pool: Address
  owner: Address
  shares: bigint
}

export interface Member {
  bump: number
  venue: Address
  wallet: Address
  expiresAt: bigint
}

export class AccountDecodeError extends Error {}

const addressDecoder = getAddressDecoder()

class Reader {
  private readonly view: DataView
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  u8 = (o: number) => this.view.getUint8(o)
  bool = (o: number) => this.view.getUint8(o) !== 0
  u16 = (o: number) => this.view.getUint16(o, true)
  u32 = (o: number) => this.view.getUint32(o, true)
  u64 = (o: number) => this.view.getBigUint64(o, true)
  i64 = (o: number) => this.view.getBigInt64(o, true)
  address = (o: number) => addressDecoder.decode(this.data.subarray(o, o + 32))
  /** Fixed [u8; n] text, NUL- and space-padded. */
  text = (o: number, n: number) => new TextDecoder().decode(this.data.subarray(o, o + n)).replace(/[\0\s]+$/, "")
}

function reader(data: Uint8Array, kind: keyof typeof DISC): Reader {
  if (data.length < LEN[kind]) throw new AccountDecodeError(`${kind} account is ${data.length} bytes; expected ${LEN[kind]}`)
  if (data[0] !== DISC[kind]) throw new AccountDecodeError(`${kind} account has discriminator ${data[0]}; expected ${DISC[kind]}`)
  return new Reader(data)
}

export function decodeVenueConfig(data: Uint8Array): VenueConfig {
  const r = reader(data, "venue")
  return {
    bump: r.u8(1), gate: r.u8(2), tier1Count: r.u16(4), tier2Count: r.u16(6),
    heartbeatMaxAge: r.i64(8), tradeDateCutoff: r.i64(16),
    admin: r.address(24), relay: r.address(56), dataAuthority: r.address(88), credentialIssuer: r.address(120),
    sasCredential: r.address(152), sasSchema: r.address(184), affiliateGroup: r.address(216),
  }
}

export function decodeSymbolRecord(data: Uint8Array): SymbolRecord {
  const r = reader(data, "symbol")
  return {
    bump: r.u8(1), tier: r.u8(2), issuerSponsored: r.bool(3), active: r.bool(4), halted: r.bool(5), objected: r.bool(6),
    breachCount: r.u8(7), ticker: r.text(8, 8), haltReason: r.text(16, 8), venue: r.address(24), mint: r.address(56),
    advShares: r.u64(88), capShares: r.u64(96), multiplierNum: r.u32(104), multiplierDen: r.u32(108),
    tradeDate: r.i64(112), sharesTradedToday: r.u64(120), pausedUntil: r.i64(128), lastHeartbeat: r.i64(136),
    relaySeq: r.u64(144), noticeReceivedAt: r.i64(152), haltedAt: r.i64(160),
  }
}

export function decodePool(data: Uint8Array): Pool {
  const r = reader(data, "pool")
  return {
    bump: r.u8(1), stockDecimals: r.u8(2), usdcDecimals: r.u8(3), feeBps: r.u16(4), symbol: r.address(8),
    stockMint: r.address(40), usdcMint: r.address(72), stockVault: r.address(104), usdcVault: r.address(136),
    reserveStock: r.u64(168), reserveUsdc: r.u64(176), lpTotal: r.u64(184),
  }
}

export function decodeLpPosition(data: Uint8Array): LpPosition {
  const r = reader(data, "lp")
  return { bump: r.u8(1), pool: r.address(8), owner: r.address(40), shares: r.u64(72) }
}

export function decodeMember(data: Uint8Array): Member {
  const r = reader(data, "member")
  return { bump: r.u8(1), venue: r.address(8), wallet: r.address(40), expiresAt: r.i64(72) }
}

/**
 * Remaining share budget in share units as of the record's stored trade date (0 when reached).
 * The program resets the counter on the first trade of a new trade date, so a stale
 * tradeDate means the full cap is available again.
 */
export function remainingShares(s: SymbolRecord): bigint {
  return s.capShares > s.sharesTradedToday ? s.capShares - s.sharesTradedToday : 0n
}

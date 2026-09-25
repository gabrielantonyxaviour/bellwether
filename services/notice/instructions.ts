/**
 * Minimal instruction builders for the venue program (docs/program-contract.md): the issuer-notice
 * trio the API sends (21 record_issuer_notice, 22 record_objection, 23 activate_pool) and the setup
 * instructions a fork check needs (0 init_venue, 1 register_symbol, 2 init_pool).
 */
import { AccountRole, address, getAddressEncoder, type Address, type Instruction, type TransactionSigner } from "@solana/kit"

const SYSTEM_PROGRAM = address("11111111111111111111111111111111")
const enc = getAddressEncoder()

const signerMeta = (signer: TransactionSigner, writable: boolean) =>
  ({ address: signer.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer })
const writable = (a: Address) => ({ address: a, role: AccountRole.WRITABLE })
const readonly = (a: Address) => ({ address: a, role: AccountRole.READONLY })

function bytes(size: number, fill: (view: DataView, out: Uint8Array) => void): Uint8Array {
  const out = new Uint8Array(size)
  fill(new DataView(out.buffer), out)
  return out
}

export interface VenueParams {
  /** 1 = SAS attestation, 2 = membership record, 3 = either. */
  gate: number
  heartbeatMaxAgeS: number
  /** Trade-date start, seconds after 00:00 UTC. */
  tradeDateCutoffS: number
  relay: Address; dataAuthority: Address; credentialIssuer: Address
  sasCredential: Address; sasSchema: Address; affiliateGroup: Address
}

export function initVenueInstruction(programId: Address, admin: TransactionSigner, venue: Address, p: VenueParams): Instruction {
  const data = bytes(1 + 17 + 6 * 32, (v, out) => {
    v.setUint8(0, 0)
    v.setUint8(1, p.gate)
    v.setBigInt64(2, BigInt(p.heartbeatMaxAgeS), true)
    v.setBigInt64(10, BigInt(p.tradeDateCutoffS), true)
    const keys = [p.relay, p.dataAuthority, p.credentialIssuer, p.sasCredential, p.sasSchema, p.affiliateGroup]
    keys.forEach((k, i) => out.set(enc.encode(k), 18 + i * 32))
  })
  return { programAddress: programId, accounts: [signerMeta(admin, true), writable(venue), readonly(SYSTEM_PROGRAM)], data }
}

export function registerSymbolInstruction(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address, mint: Address,
  args: { tier: 1 | 2; issuerSponsored: boolean; ticker: string }): Instruction {
  const ticker = new TextEncoder().encode(args.ticker)
  if (ticker.length === 0 || ticker.length > 8) throw new Error(`ticker must be 1–8 bytes: ${args.ticker}`)
  const data = bytes(11, (v, out) => {
    v.setUint8(0, 1); v.setUint8(1, args.tier); v.setUint8(2, args.issuerSponsored ? 1 : 0)
    out.set(ticker, 3)
  })
  return { programAddress: programId, accounts: [signerMeta(admin, true), writable(venue), writable(symbol), readonly(mint), readonly(SYSTEM_PROGRAM)], data }
}

export function initPoolInstruction(programId: Address, admin: TransactionSigner, a: {
  venue: Address; symbol: Address; pool: Address; stockMint: Address; usdcMint: Address; stockVault: Address; usdcVault: Address; feeBps: number
}): Instruction {
  const data = bytes(3, (v) => { v.setUint8(0, 2); v.setUint16(1, a.feeBps, true) })
  return {
    programAddress: programId,
    accounts: [signerMeta(admin, true), readonly(a.venue), readonly(a.symbol), writable(a.pool), readonly(a.stockMint), readonly(a.usdcMint),
      readonly(a.stockVault), readonly(a.usdcVault), readonly(SYSTEM_PROGRAM)],
    data,
  }
}

/** Rulebook instructions 16–23 share accounts [authority (s), venue, symbol (w)]. */
function rulebook(programId: Address, authority: TransactionSigner, venue: Address, symbol: Address, data: Uint8Array): Instruction {
  return { programAddress: programId, accounts: [signerMeta(authority, false), readonly(venue), writable(symbol)], data }
}

/** 21: the unix time the issuer received the Issuer Notice (recorded once; never future-dated). */
export function recordIssuerNoticeInstruction(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address, receivedAt: number): Instruction {
  return rulebook(programId, admin, venue, symbol, bytes(9, (v) => { v.setUint8(0, 21); v.setBigInt64(1, BigInt(receivedAt), true) }))
}

/** 22: a timely Notice of Issuer Objection; the symbol can never be (or stay) available. */
export function recordObjectionInstruction(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address): Instruction {
  return rulebook(programId, admin, venue, symbol, Uint8Array.of(22))
}

/** 23: make the symbol available. Third-party tokens: NoticeWindowOpen (6008) before day 30, Objected (6009) after an objection. */
export function activatePoolInstruction(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address): Instruction {
  return rulebook(programId, admin, venue, symbol, Uint8Array.of(23))
}

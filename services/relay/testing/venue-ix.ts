/**
 * Minimal builders for the venue instructions the relay checks need to stand up a market on a
 * surfnet (programs/venue/src/admin.rs, liquidity.rs, swap.rs, rules/). Test-only: the relay
 * itself only sends set_halt / clear_halt / heartbeat (../program.ts).
 */
import {
  AccountRole, getAddressEncoder, getProgramDerivedAddress,
  type AccountMeta, type AccountSignerMeta, type Address, type Instruction, type TransactionSigner,
} from "@solana/kit"
import { code8 } from "../program.js"

export const SYSTEM = "11111111111111111111111111111111" as Address
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address
export const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address
export const GATE_MEMBERSHIP = 2

const enc = getAddressEncoder()
const w = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE })
const r = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY })
const s = (signer: TransactionSigner, writable = false): AccountSignerMeta =>
  ({ address: signer.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer })

class Bytes {
  private parts: number[] = []
  u8(v: number) { this.parts.push(v & 0xff); return this }
  u16(v: number) { this.parts.push(v & 0xff, (v >> 8) & 0xff); return this }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.parts.push(...b); return this }
  u64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); this.parts.push(...b); return this }
  i64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); this.parts.push(...b); return this }
  raw(b: ArrayLike<number>) { this.parts.push(...Array.from(b)); return this }
  done() { return Uint8Array.from(this.parts) }
}

const ix = (programAddress: Address, accounts: (AccountMeta | AccountSignerMeta)[], data: Uint8Array): Instruction => ({ programAddress, accounts, data })

export async function pda(programId: Address, ...seeds: (string | Address)[]): Promise<Address> {
  const bytes = seeds.map((x, i) => (i === 0 ? x : enc.encode(x as Address)))
  const [out] = await getProgramDerivedAddress({ programAddress: programId, seeds: bytes })
  return out
}

export const findPool = (programId: Address, symbol: Address) => pda(programId, "pool", symbol)
export const findMember = (programId: Address, venue: Address, wallet: Address) => pda(programId, "member", venue, wallet)
export const findLp = (programId: Address, pool: Address, owner: Address) => pda(programId, "lp", pool, owner)

export interface VenueParams {
  gate: number
  heartbeatMaxAge: bigint
  cutoff: bigint
  relay: Address
  dataAuthority: Address
  issuer: Address
  sasCredential: Address
  sasSchema: Address
  affiliateGroup: Address
}

export function initVenue(programId: Address, admin: TransactionSigner, venue: Address, p: VenueParams): Instruction {
  const data = new Bytes().u8(0).u8(p.gate).i64(p.heartbeatMaxAge).i64(p.cutoff)
  for (const key of [p.relay, p.dataAuthority, p.issuer, p.sasCredential, p.sasSchema, p.affiliateGroup]) data.raw(enc.encode(key))
  return ix(programId, [s(admin, true), w(venue), r(SYSTEM)], data.done())
}

export function registerSymbol(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address, mint: Address, tier: number, sponsored: boolean, ticker: string): Instruction {
  return ix(programId, [s(admin, true), w(venue), w(symbol), r(mint), r(SYSTEM)], new Bytes().u8(1).u8(tier).u8(sponsored ? 1 : 0).raw(code8(ticker)).done())
}

export function setCap(programId: Address, dataAuthority: TransactionSigner, venue: Address, symbol: Address, cap: bigint, adv: bigint, num = 1, den = 1): Instruction {
  return ix(programId, [s(dataAuthority), r(venue), w(symbol)], new Bytes().u8(16).u64(cap).u64(adv).u32(num).u32(den).done())
}

export function activatePool(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address): Instruction {
  return ix(programId, [s(admin), r(venue), w(symbol)], Uint8Array.of(23))
}

export interface MarketAccounts {
  venue: Address
  symbol: Address
  pool: Address
  stockMint: Address
  usdcMint: Address
  stockVault: Address
  usdcVault: Address
}

export function initPool(programId: Address, admin: TransactionSigner, m: MarketAccounts, feeBps: number): Instruction {
  return ix(programId, [
    s(admin, true), r(m.venue), r(m.symbol), w(m.pool), r(m.stockMint), r(m.usdcMint), r(m.stockVault), r(m.usdcVault), r(SYSTEM),
  ], new Bytes().u8(2).u16(feeBps).done())
}

export function grantMember(programId: Address, issuer: TransactionSigner, venue: Address, member: Address, wallet: Address, expiresAt: bigint): Instruction {
  return ix(programId, [s(issuer, true), r(venue), w(member), r(wallet), r(SYSTEM)], new Bytes().u8(6).i64(expiresAt).done())
}

export interface TraderAccounts {
  owner: TransactionSigner
  stock: Address
  usdc: Address
  credential: Address
}

export function addLiquidity(programId: Address, m: MarketAccounts, t: TraderAccounts, lp: Address, stockMax: bigint, usdcMax: bigint, minLp = 0n): Instruction {
  return ix(programId, [
    s(t.owner, true), r(m.venue), r(m.symbol), w(m.pool), w(lp), r(m.stockMint), r(m.usdcMint), w(m.stockVault), w(m.usdcVault),
    w(t.stock), w(t.usdc), r(t.credential), r(TOKEN_2022), r(SPL_TOKEN), r(SYSTEM),
  ], new Bytes().u8(3).u64(stockMax).u64(usdcMax).u64(minLp).done())
}

/** direction 0 = buy stock with USDC, 1 = sell stock for USDC. */
export function swap(programId: Address, m: MarketAccounts, t: TraderAccounts, direction: 0 | 1, amountIn: bigint, minOut = 0n): Instruction {
  return ix(programId, [
    s(t.owner), r(m.venue), w(m.symbol), w(m.pool), r(m.stockMint), r(m.usdcMint), w(m.stockVault), w(m.usdcVault),
    w(t.stock), w(t.usdc), r(t.credential), r(TOKEN_2022), r(SPL_TOKEN),
  ], new Bytes().u8(5).u8(direction).u64(amountIn).u64(minOut).done())
}

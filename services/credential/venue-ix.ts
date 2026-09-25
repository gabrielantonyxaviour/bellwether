/**
 * Minimal instruction builders for the Bellwether venue program — the byte layouts in
 * docs/program-contract.md (first byte = discriminator, little-endian). The credential
 * service uses grant_member / revoke_member; the fork check uses the rest.
 */
import {
  AccountRole, getAddressEncoder, getProgramDerivedAddress, type AccountMeta, type AccountSignerMeta, type Address,
  type Instruction, type TransactionSigner,
} from "@solana/kit"

export const GATE_SAS = 1
export const GATE_MEMBER = 2
export const BUY = 0
export const SELL = 1
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address
export const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address
export const SYSTEM = "11111111111111111111111111111111" as Address

/** VenueConfig offsets read by the service. */
export const V_GATE = 2
export const V_ISSUER = 120
/** Member PDA layout. */
export const MEMBER_DISC = 5
export const M_EXPIRES = 72

const enc = getAddressEncoder()
const pda = async (programId: Address, seeds: (string | Address)[]) =>
  (await getProgramDerivedAddress({
    programAddress: programId,
    seeds: seeds.map((s, i) => (i === 0 ? (s as string) : enc.encode(s as Address))),
  }))[0]

export const venuePda = (p: Address, admin: Address) => pda(p, ["venue", admin])
export const symbolPda = (p: Address, venue: Address, mint: Address) => pda(p, ["symbol", venue, mint])
export const poolPda = (p: Address, symbol: Address) => pda(p, ["pool", symbol])
export const lpPda = (p: Address, pool: Address, owner: Address) => pda(p, ["lp", pool, owner])
export const memberPda = (p: Address, venue: Address, wallet: Address) => pda(p, ["member", venue, wallet])

const r = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY })
const w = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE })
const ws = (signer: TransactionSigner): AccountSignerMeta => ({ address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer })
const rs = (signer: TransactionSigner): AccountSignerMeta => ({ address: signer.address, role: AccountRole.READONLY_SIGNER, signer })

class Bytes {
  private parts: number[] = []
  u8(v: number) { this.parts.push(v & 0xff); return this }
  u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.parts.push(...b); return this }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.parts.push(...b); return this }
  u64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); this.parts.push(...b); return this }
  i64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); this.parts.push(...b); return this }
  key(a: Address) { this.parts.push(...enc.encode(a)); return this }
  raw(b: Uint8Array) { this.parts.push(...b); return this }
  done() { return Uint8Array.from(this.parts) }
}

const ix = (programAddress: Address, accounts: (AccountMeta | AccountSignerMeta)[], data: Uint8Array): Instruction =>
  ({ programAddress, accounts, data })

export interface VenueParams {
  gate: number
  heartbeatMaxAge: bigint
  cutoff: bigint
  relay: Address
  dataAuthority: Address
  credentialIssuer: Address
  sasCredential: Address
  sasSchema: Address
  affiliateGroup: Address
}

const venuePayload = (disc: number, p: VenueParams) => {
  const b = new Bytes().u8(disc).u8(p.gate).i64(p.heartbeatMaxAge).i64(p.cutoff)
  for (const k of [p.relay, p.dataAuthority, p.credentialIssuer, p.sasCredential, p.sasSchema, p.affiliateGroup]) b.key(k)
  return b.done()
}

export async function initVenueIx(programId: Address, admin: TransactionSigner, p: VenueParams): Promise<Instruction> {
  return ix(programId, [ws(admin), w(await venuePda(programId, admin.address)), r(SYSTEM)], venuePayload(0, p))
}

export async function updateVenueIx(programId: Address, admin: TransactionSigner, p: VenueParams): Promise<Instruction> {
  return ix(programId, [rs(admin), w(await venuePda(programId, admin.address))], venuePayload(8, p))
}

export function tickerBytes(t: string): Uint8Array {
  const out = new Uint8Array(8)
  out.set(new TextEncoder().encode(t).subarray(0, 8))
  return out
}

export async function registerSymbolIx(programId: Address, admin: TransactionSigner, venue: Address, mint: Address, tier: number, sponsored: boolean, ticker: string): Promise<Instruction> {
  const symbol = await symbolPda(programId, venue, mint)
  return ix(programId, [ws(admin), w(venue), w(symbol), r(mint), r(SYSTEM)],
    new Bytes().u8(1).u8(tier).u8(sponsored ? 1 : 0).raw(tickerBytes(ticker)).done())
}

export interface PoolKeys {
  venue: Address
  symbol: Address
  pool: Address
  stockMint: Address
  usdcMint: Address
  stockVault: Address
  usdcVault: Address
}

export function initPoolIx(programId: Address, admin: TransactionSigner, k: PoolKeys, feeBps: number): Instruction {
  return ix(programId, [
    ws(admin), r(k.venue), r(k.symbol), w(k.pool), r(k.stockMint), r(k.usdcMint), r(k.stockVault), r(k.usdcVault), r(SYSTEM),
  ], new Bytes().u8(2).u16(feeBps).done())
}

const tradeTail = (k: PoolKeys, stock: Address, usdc: Address, cred: Address) => [
  r(k.stockMint), r(k.usdcMint), w(k.stockVault), w(k.usdcVault), w(stock), w(usdc), r(cred), r(TOKEN_2022), r(SPL_TOKEN),
]

export async function addLiquidityIx(programId: Address, k: PoolKeys, owner: TransactionSigner, stock: Address, usdc: Address, cred: Address, stockMax: bigint, usdcMax: bigint, minLp: bigint): Promise<Instruction> {
  const lp = await lpPda(programId, k.pool, owner.address)
  return ix(programId, [ws(owner), r(k.venue), r(k.symbol), w(k.pool), w(lp), ...tradeTail(k, stock, usdc, cred), r(SYSTEM)],
    new Bytes().u8(3).u64(stockMax).u64(usdcMax).u64(minLp).done())
}

export function swapIx(programId: Address, k: PoolKeys, trader: TransactionSigner, stock: Address, usdc: Address, cred: Address, dir: number, amountIn: bigint, minOut: bigint): Instruction {
  return ix(programId, [rs(trader), r(k.venue), w(k.symbol), w(k.pool), ...tradeTail(k, stock, usdc, cred)],
    new Bytes().u8(5).u8(dir).u64(amountIn).u64(minOut).done())
}

/** Rulebook instructions share [authority (s), venue, symbol (w)]. */
const rule = (programId: Address, who: TransactionSigner, venue: Address, symbol: Address, data: Uint8Array) =>
  ix(programId, [rs(who), r(venue), w(symbol)], data)

export const setCapIx = (p: Address, dataAuthority: TransactionSigner, venue: Address, symbol: Address, cap: bigint, adv: bigint, num: number, den: number) =>
  rule(p, dataAuthority, venue, symbol, new Bytes().u8(16).u64(cap).u64(adv).u32(num).u32(den).done())
export const heartbeatIx = (p: Address, relay: TransactionSigner, venue: Address, symbol: Address, seq: bigint) =>
  rule(p, relay, venue, symbol, new Bytes().u8(19).u64(seq).done())
export const activatePoolIx = (p: Address, admin: TransactionSigner, venue: Address, symbol: Address) =>
  rule(p, admin, venue, symbol, new Bytes().u8(23).done())

export async function grantMemberIx(programId: Address, issuer: TransactionSigner, venue: Address, wallet: Address, expiresAt: bigint): Promise<Instruction> {
  const member = await memberPda(programId, venue, wallet)
  return ix(programId, [ws(issuer), r(venue), w(member), r(wallet), r(SYSTEM)], new Bytes().u8(6).i64(expiresAt).done())
}

export async function revokeMemberIx(programId: Address, issuer: TransactionSigner, venue: Address, wallet: Address): Promise<Instruction> {
  const member = await memberPda(programId, venue, wallet)
  return ix(programId, [ws(issuer), r(venue), w(member)], new Bytes().u8(7).done())
}

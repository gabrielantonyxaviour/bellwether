/**
 * Minimal instruction builders and PDA derivations for the venue program, enough to stand a
 * market up and swap on it (used by checks/tape.ts; account order from docs/program-contract.md
 * and programs/venue/src). Integers are little-endian; byte 0 of the data is the discriminator.
 */
import {
  AccountRole, address, getAddressEncoder, getProgramDerivedAddress,
  type AccountMeta, type AccountSignerMeta, type Address, type Instruction, type TransactionSigner,
} from "@solana/kit"

export const SYSTEM_PROGRAM = address("11111111111111111111111111111111")
export const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
export const SPL_TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
export const GATE_SAS = 1
export const GATE_MEMBER = 2

const enc = getAddressEncoder()
const text = new TextEncoder()

const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY })
const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE })
const s = (signer: TransactionSigner): AccountSignerMeta => ({ address: signer.address, role: AccountRole.READONLY_SIGNER, signer })
const ws = (signer: TransactionSigner): AccountSignerMeta => ({ address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer })

class Data {
  private bytes: number[] = []
  u8(v: number) { this.bytes.push(v & 0xff); return this }
  u16(v: number) { return this.le(BigInt(v), 2) }
  u32(v: number) { return this.le(BigInt(v), 4) }
  u64(v: bigint) { return this.le(v, 8) }
  i64(v: bigint) { return this.le(BigInt.asUintN(64, v), 8) }
  key(a: Address) { this.bytes.push(...enc.encode(a)); return this }
  raw(b: Uint8Array) { this.bytes.push(...b); return this }
  done() { return Uint8Array.from(this.bytes) }
  private le(v: bigint, n: number) {
    for (let i = 0; i < n; i++) this.bytes.push(Number((v >> BigInt(8 * i)) & 0xffn))
    return this
  }
}

const ix = (program: Address, accounts: (AccountMeta | AccountSignerMeta)[], data: Uint8Array): Instruction =>
  ({ programAddress: program, accounts, data }) as Instruction

async function pda(program: Address, seeds: (string | Address)[]): Promise<Address> {
  const [found] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: seeds.map((seed, i) => (i === 0 ? text.encode(seed) : enc.encode(seed as Address))),
  })
  return found
}

export const venuePda = (program: Address, admin: Address) => pda(program, ["venue", admin])
export const symbolPda = (program: Address, venue: Address, mint: Address) => pda(program, ["symbol", venue, mint])
export const poolPda = (program: Address, symbol: Address) => pda(program, ["pool", symbol])
export const lpPda = (program: Address, pool: Address, owner: Address) => pda(program, ["lp", pool, owner])
export const memberPda = (program: Address, venue: Address, wallet: Address) => pda(program, ["member", venue, wallet])

export function tickerBytes(ticker: string): Uint8Array {
  const b = new Uint8Array(8)
  b.set(text.encode(ticker).subarray(0, 8))
  return b
}

export interface VenueConfigArgs {
  gate: number
  heartbeatMaxAge: bigint
  tradeDateCutoff: bigint
  relay: Address
  dataAuthority: Address
  credentialIssuer: Address
  sasCredential: Address
  sasSchema: Address
  affiliateGroup: Address
}

export function initVenue(program: Address, a: { admin: TransactionSigner; venue: Address } & VenueConfigArgs): Instruction {
  const d = new Data().u8(0).u8(a.gate).i64(a.heartbeatMaxAge).i64(a.tradeDateCutoff)
    .key(a.relay).key(a.dataAuthority).key(a.credentialIssuer).key(a.sasCredential).key(a.sasSchema).key(a.affiliateGroup)
  return ix(program, [ws(a.admin), w(a.venue), ro(SYSTEM_PROGRAM)], d.done())
}

export function registerSymbol(program: Address, a: { admin: TransactionSigner; venue: Address; symbol: Address; stockMint: Address; tier: 1 | 2; sponsored: boolean; ticker: string }): Instruction {
  const d = new Data().u8(1).u8(a.tier).u8(a.sponsored ? 1 : 0).raw(tickerBytes(a.ticker))
  return ix(program, [ws(a.admin), w(a.venue), w(a.symbol), ro(a.stockMint), ro(SYSTEM_PROGRAM)], d.done())
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

export function initPool(program: Address, a: { admin: TransactionSigner; feeBps: number } & MarketAccounts): Instruction {
  return ix(program, [
    ws(a.admin), ro(a.venue), ro(a.symbol), w(a.pool), ro(a.stockMint), ro(a.usdcMint), ro(a.stockVault), ro(a.usdcVault), ro(SYSTEM_PROGRAM),
  ], new Data().u8(2).u16(a.feeBps).done())
}

export function addLiquidity(program: Address, a: MarketAccounts & {
  owner: TransactionSigner; lp: Address; ownerStock: Address; ownerUsdc: Address; credential: Address; stockMax: bigint; usdcMax: bigint; minLp: bigint
}): Instruction {
  return ix(program, [
    ws(a.owner), ro(a.venue), ro(a.symbol), w(a.pool), w(a.lp), ro(a.stockMint), ro(a.usdcMint), w(a.stockVault), w(a.usdcVault),
    w(a.ownerStock), w(a.ownerUsdc), ro(a.credential), ro(TOKEN_2022_PROGRAM), ro(SPL_TOKEN_PROGRAM), ro(SYSTEM_PROGRAM),
  ], new Data().u8(3).u64(a.stockMax).u64(a.usdcMax).u64(a.minLp).done())
}

export const BUY = 0
export const SELL = 1

export function swap(program: Address, a: MarketAccounts & {
  trader: TransactionSigner; traderStock: Address; traderUsdc: Address; credential: Address; direction: typeof BUY | typeof SELL; amountIn: bigint; minOut: bigint
}): Instruction {
  return ix(program, [
    s(a.trader), ro(a.venue), w(a.symbol), w(a.pool), ro(a.stockMint), ro(a.usdcMint), w(a.stockVault), w(a.usdcVault),
    w(a.traderStock), w(a.traderUsdc), ro(a.credential), ro(TOKEN_2022_PROGRAM), ro(SPL_TOKEN_PROGRAM),
  ], new Data().u8(5).u8(a.direction).u64(a.amountIn).u64(a.minOut).done())
}

export function grantMember(program: Address, a: { issuer: TransactionSigner; venue: Address; member: Address; wallet: Address; expiresAt: bigint }): Instruction {
  return ix(program, [ws(a.issuer), ro(a.venue), w(a.member), ro(a.wallet), ro(SYSTEM_PROGRAM)], new Data().u8(6).i64(a.expiresAt).done())
}

const rule = (program: Address, disc: number, authority: TransactionSigner, venue: Address, symbol: Address, data: Data) =>
  ix(program, [s(authority), ro(venue), w(symbol)], new Data().u8(disc).raw(data.done()).done())

export function setCap(program: Address, a: { dataAuthority: TransactionSigner; venue: Address; symbol: Address; capShares: bigint; advShares: bigint; multiplierNum: number; multiplierDen: number }): Instruction {
  return rule(program, 16, a.dataAuthority, a.venue, a.symbol, new Data().u64(a.capShares).u64(a.advShares).u32(a.multiplierNum).u32(a.multiplierDen))
}

export function heartbeat(program: Address, a: { relay: TransactionSigner; venue: Address; symbol: Address; seq: bigint }): Instruction {
  return rule(program, 19, a.relay, a.venue, a.symbol, new Data().u64(a.seq))
}

export function activatePool(program: Address, a: { admin: TransactionSigner; venue: Address; symbol: Address }): Instruction {
  return rule(program, 23, a.admin, a.venue, a.symbol, new Data())
}

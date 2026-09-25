/**
 * Browser-side instruction builders for the participant instructions of the venue program
 * (docs/program-contract.md): swap (5), add_liquidity (3), remove_liquidity (4); plus the PDAs
 * those instructions and the screens need. Account order matches programs/venue/src.
 */
import {
  AccountRole,
  getAddressEncoder,
  getProgramDerivedAddress,
  type AccountMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit"
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "@/lib/cluster"

export const IX = { swap: 5, addLiquidity: 3, removeLiquidity: 4 } as const
export const SWAP_BUY = 0 // USDC in, stock out
export const SWAP_SELL = 1 // stock in, USDC out
export type SwapDirection = typeof SWAP_BUY | typeof SWAP_SELL

export const SAS_PROGRAM = "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG" as Address

const enc = getAddressEncoder()
const text = (s: string) => new TextEncoder().encode(s)

/** A PDA from a string tag followed by 32-byte address seeds. */
async function pda(programAddress: Address, tag: string, ...keys: Address[]): Promise<Address> {
  const seeds = [text(tag), ...keys.map((k) => enc.encode(k))]
  const [found] = await getProgramDerivedAddress({ programAddress, seeds })
  return found
}

export const venuePda = (programId: Address, admin: Address) => pda(programId, "venue", admin)
export const symbolPda = (programId: Address, venue: Address, stockMint: Address) => pda(programId, "symbol", venue, stockMint)
export const poolPda = (programId: Address, symbol: Address) => pda(programId, "pool", symbol)
export const lpPda = (programId: Address, pool: Address, owner: Address) => pda(programId, "lp", pool, owner)
export const memberPda = (programId: Address, venue: Address, wallet: Address) => pda(programId, "member", venue, wallet)
/** SAS attestation PDA ["attestation", credential, schema, wallet]: the credential slot under the SAS gate. */
export const attestationPda = (credential: Address, schema: Address, wallet: Address) =>
  pda(SAS_PROGRAM, "attestation", credential, schema, wallet)

/** u8 discriminator followed by the given u8/u64 fields, little-endian. */
export function encodeData(disc: number, fields: readonly (["u8", number] | ["u64", bigint])[]): Uint8Array {
  const size = 1 + fields.reduce((n, [kind]) => n + (kind === "u8" ? 1 : 8), 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out[0] = disc
  let o = 1
  for (const [kind, value] of fields) {
    if (kind === "u8") {
      view.setUint8(o, value)
      o += 1
    } else {
      if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError(`u64 out of range: ${value}`)
      view.setBigUint64(o, value, true)
      o += 8
    }
  }
  return out
}

/** The accounts every participant instruction names for one market. */
export interface MarketAccounts {
  programId: Address
  venue: Address
  symbol: Address
  pool: Address
  stockMint: Address
  usdcMint: Address
  stockVault: Address
  usdcVault: Address
  /** SAS attestation (or membership PDA) for the signing wallet. */
  credential: Address
  /** Token program of the stock mint; Token-2022 for FWDI and BWRS. */
  stockTokenProgram?: Address
  /** Token program of the USDC mint; classic SPL Token on every cluster. */
  usdcTokenProgram?: Address
}

export interface OwnerAccounts {
  owner: TransactionSigner
  ownerStock: Address
  ownerUsdc: Address
}

const ro = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY })
const w = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE })
const signerMeta = (signer: TransactionSigner, writable: boolean) =>
  ({ address: signer.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer }) as AccountMeta

export interface SwapArgs {
  direction: SwapDirection
  amountIn: bigint
  minOut: bigint
}

/** 5 swap: trader (s), venue, symbol (w), pool (w), mints, vaults (w), trader ATAs (w), credential, token programs. */
export function swapInstruction(m: MarketAccounts, o: OwnerAccounts, args: SwapArgs): Instruction {
  return {
    programAddress: m.programId,
    accounts: [
      signerMeta(o.owner, false), ro(m.venue), w(m.symbol), w(m.pool), ro(m.stockMint), ro(m.usdcMint),
      w(m.stockVault), w(m.usdcVault), w(o.ownerStock), w(o.ownerUsdc), ro(m.credential),
      ro(m.stockTokenProgram ?? TOKEN_2022_PROGRAM), ro(m.usdcTokenProgram ?? TOKEN_PROGRAM),
    ],
    data: encodeData(IX.swap, [["u8", args.direction], ["u64", args.amountIn], ["u64", args.minOut]]),
  }
}

export interface AddLiquidityArgs {
  stockMax: bigint
  usdcMax: bigint
  minLp: bigint
  /** LpPosition PDA ["lp", pool, owner]; created on first deposit. */
  lp: Address
}

/** 3 add_liquidity: owner (s,w), venue, symbol, pool (w), lp (w), mints, vaults (w), owner ATAs (w), credential, token programs, system. */
export function addLiquidityInstruction(m: MarketAccounts, o: OwnerAccounts, args: AddLiquidityArgs): Instruction {
  return {
    programAddress: m.programId,
    accounts: [...liquidityAccounts(m, o, args.lp), ro(SYSTEM_PROGRAM)],
    data: encodeData(IX.addLiquidity, [["u64", args.stockMax], ["u64", args.usdcMax], ["u64", args.minLp]]),
  }
}

export interface RemoveLiquidityArgs {
  lpShares: bigint
  minStock: bigint
  minUsdc: bigint
  lp: Address
}

/** 4 remove_liquidity: same accounts as add minus system. Allowed while halted or paused. */
export function removeLiquidityInstruction(m: MarketAccounts, o: OwnerAccounts, args: RemoveLiquidityArgs): Instruction {
  return {
    programAddress: m.programId,
    accounts: liquidityAccounts(m, o, args.lp),
    data: encodeData(IX.removeLiquidity, [["u64", args.lpShares], ["u64", args.minStock], ["u64", args.minUsdc]]),
  }
}

function liquidityAccounts(m: MarketAccounts, o: OwnerAccounts, lp: Address): AccountMeta[] {
  return [
    signerMeta(o.owner, true), ro(m.venue), ro(m.symbol), w(m.pool), w(lp), ro(m.stockMint), ro(m.usdcMint),
    w(m.stockVault), w(m.usdcVault), w(o.ownerStock), w(o.ownerUsdc), ro(m.credential),
    ro(m.stockTokenProgram ?? TOKEN_2022_PROGRAM), ro(m.usdcTokenProgram ?? TOKEN_PROGRAM),
  ]
}

/** Constant-product quote mirroring the program: fee (ceil) off the input, then x·y=k (floor). */
export function quoteSwap(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): { out: bigint; fee: bigint } {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return { out: 0n, fee: 0n }
  const fee = (amountIn * BigInt(feeBps) + 9_999n) / 10_000n
  const net = amountIn - fee
  return { out: (net * reserveOut) / (reserveIn + net), fee }
}

/** min_out after a slippage tolerance in basis points. */
export function withSlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n
}

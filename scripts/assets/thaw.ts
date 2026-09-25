/**
 * Admission helpers for the rehearsal stock. With DefaultAccountState = Frozen every new token
 * account — an admitted participant's wallet account or a pool vault owned by the pool PDA — is
 * born frozen, and only the venue's freeze authority can thaw it (FWDI works the same way, with
 * Superstate's transfer agent holding that key).
 */
import type { Address, Instruction, TransactionSigner } from "@solana/kit"
import {
  TOKEN_2022_PROGRAM_ADDRESS, fetchToken, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
  getFreezeAccountInstruction, getMintToCheckedInstruction, getThawAccountInstruction, type AccountState,
} from "@solana-program/token-2022"
import { REHEARSAL } from "./rehearsal-mint.js"
import type { Chain, Rpc } from "./tx.js"

export async function associatedStockAccount(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  return ata
}

export function createStockAccountInstruction(payer: TransactionSigner, owner: Address, mint: Address, ata: Address): Instruction {
  return getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
}

export function thawInstruction(account: Address, mint: Address, freezeAuthority: TransactionSigner): Instruction {
  return getThawAccountInstruction({ account, mint, owner: freezeAuthority })
}

export function freezeInstruction(account: Address, mint: Address, freezeAuthority: TransactionSigner): Instruction {
  return getFreezeAccountInstruction({ account, mint, owner: freezeAuthority })
}

/**
 * Admit an owner (a wallet, or a pool PDA for its vault): create its stock account if missing and
 * thaw it, in one transaction — the same shape as Superstate's createIdempotent + thawAccount.
 */
export async function admitInstructions(input: {
  payer: TransactionSigner; owner: Address; mint: Address; freezeAuthority: TransactionSigner
}): Promise<{ account: Address; instructions: Instruction[] }> {
  const account = await associatedStockAccount(input.owner, input.mint)
  return {
    account,
    instructions: [
      createStockAccountInstruction(input.payer, input.owner, input.mint, account),
      thawInstruction(account, input.mint, input.freezeAuthority),
    ],
  }
}

export async function ensureTokenAccount(chain: Chain, input: { payer: TransactionSigner; owner: Address; mint: Address }): Promise<Address> {
  const ata = await associatedStockAccount(input.owner, input.mint)
  await chain.send([createStockAccountInstruction(input.payer, input.owner, input.mint, ata)], input.payer)
  return ata
}

export async function thawTokenAccount(chain: Chain, input: {
  payer: TransactionSigner; account: Address; mint: Address; freezeAuthority: TransactionSigner
}): Promise<string> {
  return chain.send([thawInstruction(input.account, input.mint, input.freezeAuthority)], input.payer)
}

export async function admitOwner(chain: Chain, input: {
  payer: TransactionSigner; owner: Address; mint: Address; freezeAuthority: TransactionSigner
}): Promise<{ account: Address; signature: string }> {
  const { account, instructions } = await admitInstructions(input)
  const signature = await chain.send(instructions, input.payer)
  return { account, signature }
}

export async function readTokenAccount(rpc: Rpc, account: Address): Promise<{ owner: Address; mint: Address; amount: bigint; state: AccountState }> {
  const { data } = await fetchToken(rpc, account)
  return { owner: data.owner, mint: data.mint, amount: data.amount, state: data.state }
}

/** Mint whole shares (raw = shares × 10^6; the scaled-UI multiplier is 1) to a thawed account. */
export async function mintRehearsalStock(chain: Chain, input: {
  payer: TransactionSigner; mint: Address; to: Address; mintAuthority: TransactionSigner; shares: bigint
}): Promise<string> {
  const amount = input.shares * 10n ** BigInt(REHEARSAL.decimals)
  return chain.send([
    getMintToCheckedInstruction({ mint: input.mint, token: input.to, mintAuthority: input.mintAuthority, amount, decimals: REHEARSAL.decimals }),
  ], input.payer)
}

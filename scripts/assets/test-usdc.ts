/**
 * Devnet only: a classic SPL Token mint with USDC's shape (6 decimals, no freeze authority),
 * standing in for USDC where real USDC does not exist. Mainnet and the fork use real USDC.
 */
import type { Address, TransactionSigner } from "@solana/kit"
import { getCreateAccountInstruction } from "@solana-program/system"
import {
  TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction, getMintSize, getMintToCheckedInstruction,
} from "@solana-program/token"
import type { Chain } from "./tx.js"

export const TEST_USDC_DECIMALS = 6

export async function createTestUsdc(chain: Chain, input: {
  payer: TransactionSigner; mint: TransactionSigner; mintAuthority: Address
}): Promise<{ mint: Address; signature: string }> {
  const space = getMintSize()
  const lamports = await chain.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send()
  const signature = await chain.send([
    getCreateAccountInstruction({ payer: input.payer, newAccount: input.mint, lamports, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: input.mint.address, decimals: TEST_USDC_DECIMALS, mintAuthority: input.mintAuthority }),
  ], input.payer)
  return { mint: input.mint.address, signature }
}

/** Mint whole test dollars to an owner's associated account, creating it if needed. */
export async function mintTestUsdc(chain: Chain, input: {
  payer: TransactionSigner; mint: Address; mintAuthority: TransactionSigner; owner: Address; dollars: bigint
}): Promise<{ account: Address; signature: string }> {
  const [account] = await findAssociatedTokenPda({ owner: input.owner, mint: input.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const signature = await chain.send([
    getCreateAssociatedTokenIdempotentInstruction({ payer: input.payer, ata: account, owner: input.owner, mint: input.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getMintToCheckedInstruction({
      mint: input.mint, token: account, mintAuthority: input.mintAuthority,
      amount: input.dollars * 10n ** BigInt(TEST_USDC_DECIMALS), decimals: TEST_USDC_DECIMALS,
    }),
  ], input.payer)
  return { account, signature }
}

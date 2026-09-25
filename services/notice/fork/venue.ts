/**
 * Fork-only venue setup for the notice check: init the venue with throwaway keys, register listed
 * mints (real mainnet mints the fork copies on first touch), and create a pool with vaults owned by
 * the pool PDA. Returns every address the check later compares the draft against.
 */
import { address, generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit"
import { findAssociatedTokenPda as findStockAta, getCreateAssociatedTokenIdempotentInstruction as createStockAta, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022"
import { findAssociatedTokenPda as findUsdcAta, getCreateAssociatedTokenIdempotentInstruction as createUsdcAta, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token"
import type { Chain } from "../../../scripts/assets/tx.js"
import { initPoolInstruction, initVenueInstruction, registerSymbolInstruction, type VenueParams } from "../instructions.js"
import { poolPda, symbolPda, venuePda } from "../layout.js"

export const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")

export interface Listing { ticker: string; mint: Address; tier: 1 | 2; issuerSponsored: boolean; pool: boolean }

export interface VenueKeys {
  admin: KeyPairSigner; relay: KeyPairSigner; dataAuthority: KeyPairSigner; credentialIssuer: KeyPairSigner
  sasCredential: Address; sasSchema: Address; affiliateGroup: Address
}

export interface ForkVenue {
  venue: Address
  params: VenueParams
  symbols: Record<string, { address: Address; mint: Address; pool: { address: Address; stockVault: Address; usdcVault: Address; feeBps: number } | null }>
}

export async function throwawayVenueKeys(): Promise<VenueKeys> {
  const [admin, relay, dataAuthority, credentialIssuer, cred, schema, group] = await Promise.all(Array.from({ length: 7 }, () => generateKeyPairSigner()))
  return { admin, relay, dataAuthority, credentialIssuer, sasCredential: cred.address, sasSchema: schema.address, affiliateGroup: group.address }
}

export async function setupForkVenue(chain: Chain, programId: Address, keys: VenueKeys, listings: Listing[], options: {
  heartbeatMaxAgeS?: number; tradeDateCutoffS?: number; feeBps?: number
} = {}): Promise<ForkVenue> {
  const { admin } = keys
  const venue = await venuePda(programId, admin.address)
  const params: VenueParams = {
    gate: 1, heartbeatMaxAgeS: options.heartbeatMaxAgeS ?? 180, tradeDateCutoffS: options.tradeDateCutoffS ?? 72_000,
    relay: keys.relay.address, dataAuthority: keys.dataAuthority.address, credentialIssuer: keys.credentialIssuer.address,
    sasCredential: keys.sasCredential, sasSchema: keys.sasSchema, affiliateGroup: keys.affiliateGroup,
  }
  await chain.send([initVenueInstruction(programId, admin, venue, params)], admin)

  const symbols: ForkVenue["symbols"] = {}
  for (const listing of listings) {
    const symbol = await symbolPda(programId, venue, listing.mint)
    await chain.send([registerSymbolInstruction(programId, admin, venue, symbol, listing.mint, listing)], admin)
    symbols[listing.ticker] = { address: symbol, mint: listing.mint, pool: null }
    if (!listing.pool) continue
    const pool = await poolPda(programId, symbol)
    const [stockVault] = await findStockAta({ owner: pool, mint: listing.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    const [usdcVault] = await findUsdcAta({ owner: pool, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    await chain.send([
      createStockAta({ payer: admin, ata: stockVault, owner: pool, mint: listing.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      createUsdcAta({ payer: admin, ata: usdcVault, owner: pool, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    ], admin)
    const feeBps = options.feeBps ?? 30
    await chain.send([initPoolInstruction(programId, admin, { venue, symbol, pool, stockMint: listing.mint, usdcMint: USDC_MINT, stockVault, usdcVault, feeBps })], admin)
    symbols[listing.ticker].pool = { address: pool, stockVault, usdcVault, feeBps }
  }
  return { venue, params, symbols }
}

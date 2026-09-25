/**
 * A rehearsal venue on the fork, built only from public instructions: the BWRS rehearsal mint
 * (scripts/assets), init_venue, a sponsored Tier-1 symbol with a share budget, activation,
 * pool vaults thawed by the venue key, init_pool and a first relay heartbeat.
 */
import { generateKeyPairSigner, type Address, type KeyPairSigner, type TransactionSigner } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token"
import { MAINNET_USDC_MINT } from "../../../config/clusters.js"
import { createRehearsalMint } from "../../../scripts/assets/rehearsal-mint.js"
import { admitInstructions } from "../../../scripts/assets/thaw.js"
import type { Chain } from "../../../scripts/assets/tx.js"
import {
  activatePoolIx, heartbeatIx, initPoolIx, initVenueIx, poolPda, registerSymbolIx, setCapIx, symbolPda, updateVenueIx,
  venuePda, type PoolKeys, type VenueParams,
} from "../venue-ix.js"
import { deployProgram } from "./surfnet.js"

export interface ForkVenue {
  programId: Address
  admin: KeyPairSigner
  relay: KeyPairSigner
  mintAuthority: KeyPairSigner
  params: VenueParams
  keys: PoolKeys
  /** Point the venue at a different gate (1 SAS, 2 membership). */
  setGate(gate: number): Promise<void>
}

export async function deployVenue(opts: {
  chain: Chain
  rpcUrl: string
  so: Uint8Array
  payer: TransactionSigner
  /** The venue key: BWRS freeze authority, thaws pool vaults. */
  venueKey: TransactionSigner
  issuer: Address
  sas: { credential: Address; schema: Address }
  gate: number
}): Promise<ForkVenue> {
  const { chain, payer, venueKey } = opts
  const [program, admin, relay, dataAuthority, mintAuthority, mint] = await Promise.all(Array.from({ length: 6 }, () => generateKeyPairSigner()))
  for (const k of [admin, relay, dataAuthority, mintAuthority]) await chain.fundSol(k.address, 2_000_000_000n)
  const programId = program.address
  await deployProgram(opts.rpcUrl, programId, opts.so)
  await createRehearsalMint(chain, { payer, mint, mintAuthority, freezeAuthority: venueKey.address })

  const venue = await venuePda(programId, admin.address)
  const symbol = await symbolPda(programId, venue, mint.address)
  const pool = await poolPda(programId, symbol)
  const params: VenueParams = {
    gate: opts.gate, heartbeatMaxAge: 3_600n, cutoff: 28_800n, relay: relay.address, dataAuthority: dataAuthority.address,
    credentialIssuer: opts.issuer, sasCredential: opts.sas.credential, sasSchema: opts.sas.schema, affiliateGroup: admin.address,
  }
  await chain.send([
    await initVenueIx(programId, admin, params),
    await registerSymbolIx(programId, admin, venue, mint.address, 1, true, "BWRS"),
  ], admin)

  const stock = await admitInstructions({ payer, owner: pool, mint: mint.address, freezeAuthority: venueKey })
  const [usdcVault] = await findAssociatedTokenPda({ owner: pool, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  await chain.send([
    setCapIx(programId, dataAuthority, venue, symbol, 10_000_000n * 1_000_000n, 1_000_000n * 1_000_000n, 1, 1),
    activatePoolIx(programId, admin, venue, symbol),
    ...stock.instructions,
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: usdcVault, owner: pool, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
  ], payer)

  const keys: PoolKeys = { venue, symbol, pool, stockMint: mint.address, usdcMint: MAINNET_USDC_MINT, stockVault: stock.account, usdcVault }
  await chain.send([initPoolIx(programId, admin, keys, 30), heartbeatIx(programId, relay, venue, symbol, 1n)], admin)

  return {
    programId, admin, relay, mintAuthority, params, keys,
    async setGate(gate) {
      params.gate = gate
      await chain.send([await updateVenueIx(programId, admin, params)], admin)
    },
  }
}

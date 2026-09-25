/**
 * Stands up one BWRS market on a surfnet with throwaway keypairs funded by cheatcodes:
 * the prebuilt venue program, the rehearsal stock (Token-2022, mirrors FWDI), a test USDC mint,
 * a membership-gated venue whose relay is a fresh key, the BWRS SymbolRecord (issuer-sponsored,
 * so it activates directly), a seeded pool and one admitted trader. Test-only.
 */
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token"
import { createRehearsalMint } from "../../../scripts/assets/rehearsal-mint.js"
import { createTestUsdc, mintTestUsdc } from "../../../scripts/assets/test-usdc.js"
import { admitOwner, mintRehearsalStock } from "../../../scripts/assets/thaw.js"
import { createChain } from "../../../scripts/assets/tx.js"
import { createRpcChain, describeError } from "../chain.js"
import { findSymbolRecord, findVenueConfig, heartbeatInstruction, venueErrorIn, type VenueErrorName } from "../program.js"
import { deployVenueProgram, setLamports, type Surfnet } from "./fork.js"
import {
  GATE_MEMBERSHIP, activatePool, addLiquidity, findLp, findMember, findPool, grantMember, initPool, initVenue,
  registerSymbol, setCap, swap, type MarketAccounts, type TraderAccounts,
} from "./venue-ix.js"

export const TICKER = "BWRS"

export interface TestMarket {
  programId: Address
  admin: KeyPairSigner
  relay: KeyPairSigner
  accounts: MarketAccounts
  trader: TraderAccounts
  /** Buys a little BWRS with USDC as the admitted trader; resolves on success, rejects otherwise. */
  swap(): Promise<string>
  /** Runs a swap and returns "ok" or the venue error it failed with (throws on any other failure). */
  trySwap(): Promise<"ok" | VenueErrorName>
}

export async function setupMarket(net: Surfnet, options: { heartbeatMaxAge: bigint; relay?: KeyPairSigner }): Promise<TestMarket> {
  const programId = await deployVenueProgram(net)
  const [admin, generatedRelay, traderKey, stockMintKey, usdcMintKey] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()))
  const relay = options.relay ?? generatedRelay
  await setLamports(net, admin.address, 50_000_000_000n)
  await setLamports(net, relay.address, 1_000_000_000n)
  await setLamports(net, traderKey.address, 1_000_000_000n)
  const chain = createChain(net.rpcUrl)
  const send = (ixs: Parameters<typeof chain.send>[0]) => chain.send(ixs, admin)

  // Assets: the rehearsal stock (admin is issuer and freeze authority) and a test USDC.
  await createRehearsalMint(chain, { payer: admin, mint: stockMintKey, mintAuthority: admin, freezeAuthority: admin.address })
  await createTestUsdc(chain, { payer: admin, mint: usdcMintKey, mintAuthority: admin.address })
  const stockMint = stockMintKey.address
  const usdcMint = usdcMintKey.address

  // Venue, symbol, caps and activation.
  const venue = await findVenueConfig(programId, admin.address)
  const zero = "11111111111111111111111111111111" as Address
  await send([initVenue(programId, admin, venue, {
    gate: GATE_MEMBERSHIP, heartbeatMaxAge: options.heartbeatMaxAge, cutoff: 8n * 3600n, relay: relay.address,
    dataAuthority: admin.address, issuer: admin.address, sasCredential: zero, sasSchema: zero, affiliateGroup: zero,
  })])
  const symbol = await findSymbolRecord(programId, venue, stockMint)
  await send([
    registerSymbol(programId, admin, venue, symbol, stockMint, 1, true, TICKER),
    setCap(programId, admin, venue, symbol, 10n ** 15n, 10n ** 15n),
    activatePool(programId, admin, venue, symbol),
  ])

  // Pool and its vaults (stock vault thawed by the freeze authority).
  const pool = await findPool(programId, symbol)
  const { account: stockVault } = await admitOwner(chain, { payer: admin, owner: pool, mint: stockMint, freezeAuthority: admin })
  const [usdcVault] = await findAssociatedTokenPda({ owner: pool, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  await send([getCreateAssociatedTokenIdempotentInstruction({ payer: admin, ata: usdcVault, owner: pool, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })])
  const accounts: MarketAccounts = { venue, symbol, pool, stockMint, usdcMint, stockVault, usdcVault }
  await send([initPool(programId, admin, accounts, 30)])

  // Memberships for the LP (admin) and the trader, valid for ten years (survives time travel).
  const expires = BigInt(Math.floor(Date.now() / 1000) + 10 * 365 * 86_400)
  const adminMember = await findMember(programId, venue, admin.address)
  const traderMember = await findMember(programId, venue, traderKey.address)
  await send([
    grantMember(programId, admin, venue, adminMember, admin.address, expires),
    grantMember(programId, admin, venue, traderMember, traderKey.address, expires),
  ])

  // Seed liquidity. Deposits face the heartbeat check, so the relay key heartbeats once first (seq 1).
  const relayChain = createRpcChain(net.rpcUrl, relay)
  await relayChain.send([heartbeatInstruction({ programId, relay, venue, symbol, seq: 1n })])
  const { account: adminStock } = await admitOwner(chain, { payer: admin, owner: admin.address, mint: stockMint, freezeAuthority: admin })
  await mintRehearsalStock(chain, { payer: admin, mint: stockMint, to: adminStock, mintAuthority: admin, shares: 100_000n })
  const { account: adminUsdc } = await mintTestUsdc(chain, { payer: admin, mint: usdcMint, mintAuthority: admin, owner: admin.address, dollars: 2_000_000n })
  const lp = await findLp(programId, pool, admin.address)
  await send([addLiquidity(programId, accounts, { owner: admin, stock: adminStock, usdc: adminUsdc, credential: adminMember }, lp, 10_000n * 10n ** 6n, 150_000n * 10n ** 6n)])

  // One admitted trader with USDC and a thawed stock account.
  const { account: traderStock } = await admitOwner(chain, { payer: admin, owner: traderKey.address, mint: stockMint, freezeAuthority: admin })
  const { account: traderUsdc } = await mintTestUsdc(chain, { payer: admin, mint: usdcMint, mintAuthority: admin, owner: traderKey.address, dollars: 10_000n })
  const trader: TraderAccounts = { owner: traderKey, stock: traderStock, usdc: traderUsdc, credential: traderMember }

  const traderChain = createRpcChain(net.rpcUrl, traderKey)
  let nonce = 0n
  const doSwap = async () => (await traderChain.send([swap(programId, accounts, trader, 0, 10_000_000n + ++nonce)])).signature
  async function trySwap(): Promise<"ok" | VenueErrorName> {
    try {
      await doSwap()
      return "ok"
    } catch (error) {
      const text = describeError(error)
      const name = venueErrorIn(text)
      if (!name) throw new Error(`swap failed without a venue error: ${text.slice(0, 600)}`)
      return name
    }
  }
  return { programId, admin, relay, accounts, trader, swap: doSwap, trySwap }
}

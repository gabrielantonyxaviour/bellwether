/**
 * Stand a real venue market up on a local Surfpool fork with throwaway keys: deploy the prebuilt
 * program by cheatcode, create the rehearsal stock (FWDI-shaped Token-2022, born frozen), pair it
 * with the fork's real mainnet USDC funded by cheatcode, seed liquidity and admit a trader.
 * Fork-only: every cheatcode refuses on a cluster without them.
 */
import { generateKeyPairSigner, type Address, type KeyPairSigner, type Signature } from "@solana/kit"
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token"
import { MAINNET_USDC_MINT } from "../../config/clusters.js"
import { REHEARSAL, createRehearsalMint } from "../../scripts/assets/rehearsal-mint.js"
import { admitInstructions, mintRehearsalStock } from "../../scripts/assets/thaw.js"
import type { Chain } from "../../scripts/assets/tx.js"
import * as v from "./venue-ix.js"

const ZERO = "11111111111111111111111111111111" as Address

async function cheat(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method} failed on ${rpcUrl}: ${body.error.message}`)
  return body.result
}

/** Writes the program ELF at `programId` (an upgradeable program owned by the loader). */
export async function deployProgram(rpcUrl: string, programId: Address, elf: Uint8Array): Promise<void> {
  const CHUNK = 16_384
  for (let offset = 0; offset < elf.length; offset += CHUNK) {
    await cheat(rpcUrl, "surfnet_writeProgram", [programId, Buffer.from(elf.subarray(offset, offset + CHUNK)).toString("hex"), offset])
  }
}

export async function setTokenBalance(rpcUrl: string, owner: Address, mint: Address, amount: bigint): Promise<void> {
  await cheat(rpcUrl, "surfnet_setTokenAccount", [owner, mint, { amount: Number(amount) }, TOKEN_PROGRAM_ADDRESS])
}

export interface Participant {
  signer: KeyPairSigner
  stock: Address
  usdc: Address
  member: Address
}

export interface ForkVenue extends v.MarketAccounts {
  program: Address
  admin: KeyPairSigner
  ticker: string
  feeBps: number
  lp: Participant
  trader: Participant
  swap(direction: typeof v.BUY | typeof v.SELL, amountIn: bigint): Promise<Signature>
}

const usd = (dollars: bigint) => dollars * 1_000_000n
const shares = (n: bigint) => n * 10n ** BigInt(REHEARSAL.decimals)

export async function bootstrapForkVenue(chain: Chain, opts: {
  program: Address
  ticker?: string
  feeBps?: number
  seed?: { stockShares: bigint; usdcDollars: bigint }
  traderUsdcDollars?: bigint
}): Promise<ForkVenue> {
  const { program } = opts
  const ticker = opts.ticker ?? REHEARSAL.symbol
  const feeBps = opts.feeBps ?? 30
  const seed = opts.seed ?? { stockShares: 10_000n, usdcDollars: 250_000n }
  const [admin, issuer, transferAgent, mint, traderKey] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()))
  for (const k of [admin, issuer, transferAgent, traderKey]) await chain.fundSol(k.address, 20_000_000_000n)

  // Stock: the rehearsal mint, frozen by default, thawed per admitted owner by the transfer agent.
  await createRehearsalMint(chain, { payer: admin, mint, mintAuthority: issuer, freezeAuthority: transferAgent.address })
  const stockMint = mint.address
  const usdcMint = MAINNET_USDC_MINT

  const venue = await v.venuePda(program, admin.address)
  const symbol = await v.symbolPda(program, venue, stockMint)
  const pool = await v.poolPda(program, symbol)
  await chain.send([v.initVenue(program, {
    admin, venue, gate: v.GATE_MEMBER, heartbeatMaxAge: 3_600n, tradeDateCutoff: 8n * 3_600n,
    relay: admin.address, dataAuthority: admin.address, credentialIssuer: admin.address,
    sasCredential: ZERO, sasSchema: ZERO, affiliateGroup: ZERO,
  })], admin)
  await chain.send([v.registerSymbol(program, { admin, venue, symbol, stockMint, tier: 1, sponsored: true, ticker })], admin)

  // Vaults: token accounts owned by the pool PDA (the stock vault must be thawed to receive).
  const stockVaultAdmit = await admitInstructions({ payer: admin, owner: pool, mint: stockMint, freezeAuthority: transferAgent })
  const [usdcVault] = await findAssociatedTokenPda({ owner: pool, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  await chain.send([
    ...stockVaultAdmit.instructions,
    getCreateAssociatedTokenIdempotentInstruction({ payer: admin, ata: usdcVault, owner: pool, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
  ], admin)
  const market: v.MarketAccounts = { venue, symbol, pool, stockMint, usdcMint, stockVault: stockVaultAdmit.account, usdcVault }
  await chain.send([v.initPool(program, { admin, feeBps, ...market })], admin)

  // Rulebook state a swap needs: a share budget, a fresh heartbeat, and activation (sponsored).
  await chain.send([
    v.setCap(program, { dataAuthority: admin, venue, symbol, capShares: shares(1_000_000n), advShares: shares(10_000_000n), multiplierNum: 1, multiplierDen: 1 }),
    v.heartbeat(program, { relay: admin, venue, symbol, seq: 1n }),
    v.activatePool(program, { admin, venue, symbol }),
  ], admin)

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400)
  const admit = async (signer: KeyPairSigner): Promise<Participant> => {
    const member = await v.memberPda(program, venue, signer.address)
    const stock = await admitInstructions({ payer: admin, owner: signer.address, mint: stockMint, freezeAuthority: transferAgent })
    await chain.send([
      v.grantMember(program, { issuer: admin, venue, member, wallet: signer.address, expiresAt }),
      ...stock.instructions,
    ], admin)
    const [usdc] = await findAssociatedTokenPda({ owner: signer.address, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    return { signer, stock: stock.account, usdc, member }
  }

  const lp = await admit(admin)
  await mintRehearsalStock(chain, { payer: admin, mint: stockMint, to: lp.stock, mintAuthority: issuer, shares: seed.stockShares })
  await setTokenBalance(chain.rpcUrl, admin.address, usdcMint, usd(seed.usdcDollars))
  await chain.send([v.addLiquidity(program, {
    owner: admin, ...market, lp: await v.lpPda(program, pool, admin.address), ownerStock: lp.stock, ownerUsdc: lp.usdc,
    credential: lp.member, stockMax: shares(seed.stockShares), usdcMax: usd(seed.usdcDollars), minLp: 0n,
  })], admin)

  const trader = await admit(traderKey)
  await setTokenBalance(chain.rpcUrl, traderKey.address, usdcMint, usd(opts.traderUsdcDollars ?? 10_000n))

  return {
    program, admin, ticker, feeBps, lp, trader, ...market,
    swap: (direction, amountIn) => chain.send([v.swap(program, {
      trader: trader.signer, ...market, traderStock: trader.stock, traderUsdc: trader.usdc, credential: trader.member,
      direction, amountIn, minOut: 1n,
    })], trader.signer),
  }
}

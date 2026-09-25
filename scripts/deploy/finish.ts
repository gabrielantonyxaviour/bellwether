/** Complete a real SAS-gated BWRS pool and seed it against the live FWDI previous close. */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { type Address, type KeyPairSigner } from "@solana/kit"
import { getMintToCheckedInstruction as mintStockIx, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022"
import { getCreateAssociatedTokenIdempotentInstruction, getMintToCheckedInstruction, TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token"
import { getThawAccountInstruction } from "@solana-program/token-2022"
import { createChain, type Chain } from "../assets/tx.js"
import { associatedStockAccount, createStockAccountInstruction, readTokenAccount } from "../assets/thaw.js"
import { setTokenBalance } from "../../services/credential/fork/surfnet.js"
import { sasBackend, type SasIdentity } from "../../services/credential/sas.js"
import * as v from "../../services/credential/venue-ix.js"
import { mark, type Deployment } from "./state.js"

interface Args {
  chain: Chain
  record: Deployment
  payer: KeyPairSigner
  admin: KeyPairSigner
  relay: KeyPairSigner
  dataAuthority: KeyPairSigner
  issuer: KeyPairSigner
  freezeAuthority: KeyPairSigner
  mintAuthority: KeyPairSigner
  stockMint: KeyPairSigner
  usdcMint: Address
  sas: SasIdentity
  seedUsdc: number
  close: { price: number; source: string; date: string }
}

function serviceEnv(cluster: string): NodeJS.ProcessEnv {
  const suffix = cluster === "fork" && process.env.BELLWETHER_FORK_PORT && process.env.BELLWETHER_FORK_PORT !== "8899"
    ? `fork-${process.env.BELLWETHER_FORK_PORT}` : cluster
  const file = `services/.env.${suffix}`
  const env = { ...process.env }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue
    const split = line.indexOf("=")
    if (split < 1) throw new Error(`malformed ${file} line`)
    env[line.slice(0, split)] = line.slice(split + 1)
  }
  return env
}

export async function finishVenue(a: Args): Promise<void> {
  const { chain, record: d, payer, admin, relay, issuer, freezeAuthority, mintAuthority, stockMint, usdcMint, sas } = a
  if (!d.programId || !d.venue || !d.symbol || !d.pool || !d.stockVault || !d.usdcVault) throw new Error("venue setup incomplete")
  const program = d.programId as Address
  const venue = d.venue as Address
  const symbol = d.symbol as Address
  const pool = d.pool as Address
  const done = (step: string) => d.completed.includes(step)
  const backend = sasBackend({ chain, payer, issuer, identity: sas })
  await backend.ensureReady()

  if (!done("lpAdmitted")) {
    const credential = await backend.read(payer.address)
    if (!credential.exists) {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400)
      const sig = await chain.send(await backend.issueInstructions(payer.address, expiry), payer)
      d.signatures.lpCredential = sig
    }
    const stockAccount = await associatedStockAccount(payer.address, stockMint.address)
    const exists = (await chain.rpc.getAccountInfo(stockAccount, { encoding: "base64" }).send()).value !== null
    if (!exists) {
      d.signatures.lpStockAccount = await chain.send([
        createStockAccountInstruction(payer, payer.address, stockMint.address, stockAccount),
        getThawAccountInstruction({ account: stockAccount, mint: stockMint.address, owner: freezeAuthority }),
      ], payer)
    } else if ((await readTokenAccount(chain.rpc, stockAccount)).state === 2) {
      d.signatures.lpThaw = await chain.send([getThawAccountInstruction({ account: stockAccount, mint: stockMint.address, owner: freezeAuthority })], payer)
    }
    mark(d, "lpAdmitted")
  }

  if (!done("heartbeat")) mark(d, "heartbeat", await chain.send([v.heartbeatIx(program, relay, venue, symbol, 1n)], payer))
  if (!done("cap")) {
    const output = execFileSync("npx", ["tsx", "services/caps/run.ts"], { env: serviceEnv(d.cluster), encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 })
    process.stdout.write(output)
    const signatures = await chain.rpc.getSignaturesForAddress(symbol, { limit: 1 }).send()
    mark(d, "cap", signatures[0]?.signature)
  }

  const usdcRaw = BigInt(Math.round(a.seedUsdc * 1_000_000))
  const stockRaw = BigInt(Math.round((a.seedUsdc / a.close.price) * 1_000_000))
  if (usdcRaw <= 0n || stockRaw <= 0n) throw new Error("seed amount rounds to zero")
  const stockAccount = await associatedStockAccount(payer.address, stockMint.address)
  const [usdcAccount] = await findAssociatedTokenPda({ owner: payer.address, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  if (!done("lpUsdc")) {
    if (d.cluster === "fork") {
      // Fork-only funding of the real mainnet USDC mint; devnet creates and mints its own labelled test USDC.
      await setTokenBalance(chain.rpcUrl, payer.address, usdcMint, usdcRaw, TOKEN_PROGRAM_ADDRESS)
      mark(d, "lpUsdc")
    } else if (d.cluster === "devnet") {
      mark(d, "lpUsdc", await chain.send([
        getCreateAssociatedTokenIdempotentInstruction({ payer, ata: usdcAccount, owner: payer.address, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        getMintToCheckedInstruction({ mint: usdcMint, token: usdcAccount, mintAuthority: payer, amount: usdcRaw, decimals: 6 }),
      ], payer))
    } else {
      const balance = await chain.rpc.getTokenAccountBalance(usdcAccount).send()
      if (BigInt(balance.value.amount) < usdcRaw) throw new Error(`mainnet LP requires ${usdcRaw} real USDC base units`)
      mark(d, "lpUsdc")
    }
  }
  if (!done("lpStock")) mark(d, "lpStock", await chain.send([
    mintStockIx({ mint: stockMint.address, token: stockAccount, mintAuthority, amount: stockRaw, decimals: 6 }),
  ], payer))
  if (!done("seedLiquidity")) {
    const keys: v.PoolKeys = { venue, symbol, pool, stockMint: stockMint.address, usdcMint,
      stockVault: d.stockVault as Address, usdcVault: d.usdcVault as Address }
    const credential = await sasIdentityAddress(sas, payer.address)
    const sig = await chain.send([await v.addLiquidityIx(program, keys, payer, stockAccount, usdcAccount,
      credential, stockRaw, usdcRaw, 1n)], payer)
    mark(d, "seedLiquidity", sig)
    process.stdout.write(`seeded ${a.seedUsdc} USDC and ${Number(stockRaw) / 1_000_000} BWRS at FWDI previous close $${a.close.price} (${a.close.source}, read ${a.close.date})\n`)
  }
}

async function sasIdentityAddress(identity: SasIdentity, wallet: Address): Promise<Address> {
  const { attestationAddress } = await import("../../services/credential/sas.js")
  return attestationAddress(identity, wallet)
}

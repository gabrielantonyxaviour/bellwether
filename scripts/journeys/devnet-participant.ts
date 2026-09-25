/** Isolated devnet participant transactions for the Circuit trade and liquidity journeys. */
import { address, createSolanaRpc, AccountRole, type Address, type Instruction, type KeyPairSigner } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token"
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda as stockAta } from "@solana-program/token-2022"
import { z } from "zod"
import { fetchRaw } from "../../services/credential/backend.js"
import { attestationAddress, sasIdentity } from "../../services/credential/sas.js"
import { addLiquidityIx, lpPda, swapIx, BUY, type PoolKeys } from "../../services/credential/venue-ix.js"
import { createDeploymentChain } from "../deploy/chain.js"
import { key, loadDeployment } from "../deploy/state.js"

const API = "https://bellwether-api.larinova.com"
const mode = z.enum(["trade", "liquidity"]).parse(process.argv[2])
const response = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(120_000) })
  const body: unknown = await res.json()
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body
}
const emit = (event: string, fields: Record<string, unknown>) => process.stdout.write(JSON.stringify({ event, ...fields }) + "\n")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const u64 = (value: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, value, true); return b }

async function main() {
  const d = loadDeployment("devnet")
  if (!d?.programId || !d.venue || !d.symbol || !d.pool || !d.stockMint || !d.usdcMint || !d.stockVault || !d.usdcVault || !d.sasCredential) {
    throw new Error("Incomplete devnet deployment journal")
  }
  const programId = address(d.programId)
  const pool: PoolKeys = {
    venue: address(d.venue), symbol: address(d.symbol), pool: address(d.pool), stockMint: address(d.stockMint),
    usdcMint: address(d.usdcMint), stockVault: address(d.stockVault), usdcVault: address(d.usdcVault),
  }
  const signer = await key("devnet", mode === "trade" ? "integration-trade" : "integration-liquidity")
  const chain = createDeploymentChain(d.rpcUrl)
  const rpc = createSolanaRpc(d.rpcUrl)
  const [stock] = await stockAta({ owner: signer.address, mint: pool.stockMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const [usdc] = await findAssociatedTokenPda({ owner: signer.address, mint: pool.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const issuer = await key("devnet", "credential-issuer")
  const credential = await attestationAddress(await sasIdentity(issuer.address), signer.address)
  emit("wallet", { mode, wallet: signer.address })

  const challenge = z.object({ wallet: z.string(), message: z.string().min(1) }).parse(
    await response(`/admit/challenge?wallet=${signer.address}`))
  if (challenge.wallet !== signer.address) throw new Error("Challenge wallet mismatch")
  const signed = Buffer.from(await crypto.subtle.sign("Ed25519", signer.keyPair.privateKey,
    new TextEncoder().encode(challenge.message))).toString("base64")
  const admission = z.object({ status: z.literal("admitted"), signature: z.string().nullable(),
    funding: z.object({ status: z.enum(["funded", "already_funded"]), signature: z.string().nullable() }).nullable(),
  }).parse(await response("/admit", { method: "POST", headers: { "content-type": "application/json",
    origin: "https://bellwether.larinova.com" }, body: JSON.stringify({ wallet: signer.address,
    message: challenge.message, signature: signed }) }))
  const status = z.object({ status: z.literal("admitted"), stockAccount: z.object({ state: z.literal("thawed") }) })
    .parse(await response(`/credential/${signer.address}`))
  emit("admitted", { wallet: signer.address, signature: admission.signature,
    funding: admission.funding?.signature, stockState: status.stockAccount.state })

  const beforePool = await fetchRaw(rpc, pool.pool)
  const beforeSymbol = await fetchRaw(rpc, pool.symbol)
  if (!beforePool || !beforeSymbol) throw new Error("Pool or symbol account missing")
  const reserves = (data: Uint8Array) => { const view = new DataView(data.buffer, data.byteOffset)
    return { stock: view.getBigUint64(168, true), usdc: view.getBigUint64(176, true), lp: view.getBigUint64(184, true) } }
  const before = reserves(beforePool.data)
  const sharesBefore = new DataView(beforeSymbol.data.buffer, beforeSymbol.data.byteOffset).getBigUint64(120, true)
  const amountIn = 50_000n // 0.05 test USDC, six decimals.
  const buy = await chain.send([swapIx(programId, pool, signer, stock, usdc, credential, BUY, amountIn, 1n)], signer)
  const afterPool = await fetchRaw(rpc, pool.pool)
  const afterSymbol = await fetchRaw(rpc, pool.symbol)
  if (!afterPool || !afterSymbol) throw new Error("Pool or symbol account missing after swap")
  const after = reserves(afterPool.data)
  const sharesAfter = new DataView(afterSymbol.data.buffer, afterSymbol.data.byteOffset).getBigUint64(120, true)
  if (after.stock >= before.stock || after.usdc <= before.usdc || sharesAfter <= sharesBefore) {
    throw new Error("Swap did not advance reserves and daily share count")
  }
  emit("swap", { wallet: signer.address, signature: buy, usdcIn: amountIn.toString(),
    stockOut: (before.stock - after.stock).toString(), shareCountBefore: sharesBefore.toString(),
    shareCountAfter: sharesAfter.toString(), reservesBefore: { stock: before.stock.toString(), usdc: before.usdc.toString() },
    reservesAfter: { stock: after.stock.toString(), usdc: after.usdc.toString() } })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const tape = z.object({ prints: z.array(z.object({ signature: z.string(), symbol: z.string() }).passthrough()) })
      .passthrough().parse(await response("/tape?symbol=BWRS"))
    const print = tape.prints.find((item) => item.signature === buy)
    if (print) { emit("tape", { signature: buy, print }); break }
    await pause(2_000)
  }
  const finalTape = JSON.stringify(await response("/tape?symbol=BWRS"))
  if (!finalTape.includes(buy)) throw new Error(`Public tape did not index ${buy}`)
  if (mode === "trade") return

  const stockMax = 1_000n // 0.001 BWRS; leave the rest of the acquired stock in this wallet.
  const usdcMax = (stockMax * after.usdc + after.stock - 1n) / after.stock + 10n
  const position = await lpPda(programId, pool.pool, signer.address)
  const deposit = await chain.send([await addLiquidityIx(programId, pool, signer, stock, usdc, credential,
    stockMax, usdcMax, 1n)], signer)
  const lpRaw = await fetchRaw(rpc, position)
  if (!lpRaw) throw new Error("LP position missing after deposit")
  const lpView = new DataView(lpRaw.data.buffer, lpRaw.data.byteOffset)
  const shares = lpView.getBigUint64(72, true)
  if (shares === 0n) throw new Error("LP position has zero shares")
  emit("deposit", { wallet: signer.address, signature: deposit, position, shares: shares.toString(),
    stockMax: stockMax.toString(), usdcMax: usdcMax.toString() })

  const accounts = [
    { address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer },
    { address: pool.venue, role: AccountRole.READONLY }, { address: pool.symbol, role: AccountRole.READONLY },
    { address: pool.pool, role: AccountRole.WRITABLE }, { address: position, role: AccountRole.WRITABLE },
    { address: pool.stockMint, role: AccountRole.READONLY }, { address: pool.usdcMint, role: AccountRole.READONLY },
    { address: pool.stockVault, role: AccountRole.WRITABLE }, { address: pool.usdcVault, role: AccountRole.WRITABLE },
    { address: stock, role: AccountRole.WRITABLE }, { address: usdc, role: AccountRole.WRITABLE },
    { address: credential, role: AccountRole.READONLY }, { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
  ] as const
  const withdrawIx: Instruction = { programAddress: programId, accounts,
    data: Uint8Array.from([4, ...u64(shares), ...u64(1n), ...u64(1n)]) }
  const withdrawal = await chain.send([withdrawIx], signer)
  const afterLp = await fetchRaw(rpc, position)
  const sharesRemaining = afterLp ? new DataView(afterLp.data.buffer, afterLp.data.byteOffset).getBigUint64(72, true) : 0n
  if (sharesRemaining !== 0n) throw new Error("LP shares remained after full withdrawal")
  emit("withdraw", { wallet: signer.address, signature: withdrawal, position, sharesRemaining: "0" })
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })

/** Real failed devnet swap from an unadmitted wallet, with a recorded transaction signature. */
import { address, appendTransactionMessageInstructions, createTransactionMessage, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit"
import { getTransferSolInstruction } from "@solana-program/system"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token"
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda as stockAta,
  getCreateAssociatedTokenIdempotentInstruction as createStockAta } from "@solana-program/token-2022"
import { attestationAddress, sasIdentity } from "../../services/credential/sas.js"
import { swapIx, BUY, type PoolKeys } from "../../services/credential/venue-ix.js"
import { createDeploymentChain } from "../deploy/chain.js"
import { key, loadDeployment } from "../deploy/state.js"
import { errorText } from "../assets/tx.js"

const emit = (event: string, detail: Record<string, unknown>) => process.stdout.write(JSON.stringify({ event, ...detail }) + "\n")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const d = loadDeployment("devnet")
  if (!d?.programId || !d.venue || !d.symbol || !d.pool || !d.stockMint || !d.usdcMint || !d.stockVault || !d.usdcVault) {
    throw new Error("Incomplete devnet deployment journal")
  }
  const programId = address(d.programId)
  const chain = createDeploymentChain(d.rpcUrl)
  const wallet = await key("devnet", "integration-unadmitted")
  const payer = await key("devnet", "integration-trade")
  const issuer = await key("devnet", "credential-issuer")
  const market: PoolKeys = { venue: address(d.venue), symbol: address(d.symbol), pool: address(d.pool),
    stockMint: address(d.stockMint), usdcMint: address(d.usdcMint), stockVault: address(d.stockVault),
    usdcVault: address(d.usdcVault) }
  const [stock] = await stockAta({ owner: wallet.address, mint: market.stockMint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const [usdc] = await findAssociatedTokenPda({ owner: wallet.address, mint: market.usdcMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const status = await (await fetch(`https://bellwether-api.larinova.com/credential/${wallet.address}`)).json() as { status: string }
  if (status.status !== "not_admitted") throw new Error(`Wallet already has admission status ${status.status}`)
  emit("wallet", { address: wallet.address, admission: status.status })
  const balance = (await chain.rpc.getBalance(wallet.address).send()).value
  const funding = balance < 1_000_000n ? await chain.send([getTransferSolInstruction({ source: payer, destination: wallet.address,
    amount: 1_000_000n - balance })], payer) : null
  const stockExists = (await chain.rpc.getAccountInfo(stock, { encoding: "base64" }).send()).value !== null
  const usdcExists = (await chain.rpc.getAccountInfo(usdc, { encoding: "base64" }).send()).value !== null
  const createAccounts = stockExists && usdcExists ? null : await chain.send([
    createStockAta({ payer, ata: stock, owner: wallet.address, mint: market.stockMint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: usdc, owner: wallet.address, mint: market.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS }),
  ], payer)
  emit("prepared", { funding, createAccounts, stockAccount: stock, usdcAccount: usdc })

  const credential = await attestationAddress(await sasIdentity(issuer.address), wallet.address)
  const { value: blockhash } = await chain.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
  const message = pipe(createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(wallet, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([swapIx(programId, market, wallet,
      stock, usdc, credential, BUY, 1_000n, 1n)], m))
  const signed = await signTransactionMessageWithSigners(message)
  const signature = getSignatureFromTransaction(signed)
  emit("signed", { signature })
  const submitted = await chain.rpc.sendTransaction(getBase64EncodedWireTransaction(signed), {
    encoding: "base64", skipPreflight: true, preflightCommitment: "confirmed",
  }).send()
  if (submitted !== signature) throw new Error(`RPC returned ${submitted}, expected ${signature}`)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const { value } = await chain.rpc.getSignatureStatuses([signature]).send()
    if (value[0]?.err) break
    if (value[0]?.confirmationStatus === "finalized") throw new Error("Unadmitted swap unexpectedly succeeded")
    await pause(500)
  }
  type FailedTx = { slot: number; meta: { err: unknown; logMessages: string[] | null } }
  let transaction: FailedTx | null = null
  while (Date.now() < deadline && !transaction) {
    const res = await fetch(d.rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
        params: [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] }) })
    const body = await res.json() as { result?: FailedTx | null; error?: { message: string } }
    if (body.error) throw new Error(`getTransaction: ${body.error.message}`)
    transaction = body.result ?? null
    if (!transaction) await pause(500)
  }
  if (!transaction) throw new Error(`Transaction ${signature} was not available after confirmation`)
  const meta = transaction?.meta
  if (!meta?.err) throw new Error(`Failed transaction ${signature} was not available with error metadata`)
  const logs = meta.logMessages ?? []
  const joined = logs.join("\n")
  if (!joined.includes("custom program error: 0x1770")) {
    throw new Error(`Expected NotAdmitted 6000 (0x1770), got ${JSON.stringify(meta.err)} and ${joined}`)
  }
  const after = await (await fetch(`https://bellwether-api.larinova.com/credential/${wallet.address}`)).json() as { status: string }
  if (after.status !== "not_admitted") throw new Error(`Wallet admission changed to ${after.status}`)
  emit("failed_swap", { wallet: wallet.address, signature, slot: transaction.slot, err: meta.err,
    logs, programError: "NotAdmitted", code: 6000, hex: "0x1770",
    solscan: `https://solscan.io/tx/${signature}?cluster=devnet` })
}

main().catch((error) => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1 })

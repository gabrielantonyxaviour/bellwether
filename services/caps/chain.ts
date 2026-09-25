/**
 * The caps job's chain access: an RPC, a send-and-confirm that polls signature status (so it
 * behaves the same on Surfpool, devnet and mainnet), and the data-authority keypair loader.
 */
import { readFileSync } from "node:fs"
import {
  appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Instruction, type KeyPairSigner, type Signature, type TransactionSigner,
} from "@solana/kit"
import { z } from "zod"

export type CapsRpc = ReturnType<typeof createSolanaRpc>
export type SendFn = (instructions: Instruction[], feePayer: TransactionSigner) => Promise<Signature>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))

export function createCapsChain(rpcUrl: string, confirmTimeoutMs = 90_000): { rpc: CapsRpc; send: SendFn } {
  const rpc = createSolanaRpc(rpcUrl)
  const send: SendFn = async (instructions, feePayer) => {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
    const signed = await signTransactionMessageWithSigners(message)
    const signature = getSignatureFromTransaction(signed)
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send()
    const deadline = Date.now() + confirmTimeoutMs
    while (Date.now() < deadline) {
      const status = (await rpc.getSignatureStatuses([signature]).send()).value[0]
      if (status?.err) throw new Error(`transaction ${signature} failed: ${show(status.err)}`)
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature
      await sleep(400)
    }
    throw new Error(`transaction ${signature} not confirmed within ${confirmTimeoutMs / 1000}s`)
  }
  return { rpc, send }
}

const keypairBytes = z.array(z.number().int().min(0).max(255)).length(64)

/** A Solana CLI keypair (JSON array of 64 bytes), from a file path or the JSON itself. Never logs the bytes. */
export async function loadKeypair(source: string): Promise<KeyPairSigner> {
  const raw = source.trim().startsWith("[") ? source : readFileSync(source, "utf8")
  const parsed = keypairBytes.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error("the data-authority keypair is not a 64-byte Solana keypair")
  return createKeyPairSignerFromBytes(Uint8Array.from(parsed.data))
}

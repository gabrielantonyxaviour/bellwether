/** Deployment transaction sender: transient retries reuse the exact signed wire and signature. */
import {
  appendTransactionMessageInstructions, createTransactionMessage, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Instruction, type TransactionSigner,
} from "@solana/kit"
import { createChain, type Chain } from "../assets/tx.js"
import { withRetry } from "../../services/credential/retry.js"

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createDeploymentChain(rpcUrl: string): Chain {
  const base = createChain(rpcUrl)
  const { rpc } = base
  async function send(instructions: Instruction[], feePayer: TransactionSigner) {
    const { value: blockhash } = await withRetry(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send(), 7, 1_000)
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
    const signed = await signTransactionMessageWithSigners(message)
    const signature = getSignatureFromTransaction(signed)
    const wire = getBase64EncodedWireTransaction(signed)
    await withRetry(() => rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send(), 7, 1_000)
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const { value } = await withRetry(() => rpc.getSignatureStatuses([signature]).send(), 5, 800)
      const status = value[0]
      if (status?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`)
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return signature
      await pause(500)
    }
    throw new Error(`transaction ${signature} not confirmed in 90 seconds; inspect this signature before retrying`)
  }
  return { ...base, send }
}

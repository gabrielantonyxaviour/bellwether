/**
 * The relay's view of a Solana cluster over plain JSON-RPC: read an account, send one
 * transaction paid and signed by the relay key and poll its status until confirmed (no
 * websocket, so it behaves the same on Surfpool, devnet and mainnet), and identify the cluster.
 */
import {
  appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, isSolanaError, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction, type TransactionSigner,
} from "@solana/kit"
import type { RelayChain } from "./relay.js"

export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
export type ClusterKind = "surfnet" | "mainnet" | "other"

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Message, Solana error context (custom program error codes, logs) and causes in one string. */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    if (!(current instanceof Error)) { parts.push(json(current)); break }
    parts.push(current.message)
    if (isSolanaError(current)) parts.push(json(current.context))
    current = (current as Error & { cause?: unknown }).cause
  }
  return parts.join(" | ")
}

export function createRpcChain(rpcUrl: string, payer: TransactionSigner, confirmTimeoutMs = 60_000): RelayChain & {
  rpcUrl: string
  clusterKind(): Promise<ClusterKind>
} {
  const rpc = createSolanaRpc(rpcUrl)

  async function getAccount(address: Address): Promise<Uint8Array | null> {
    const { value } = await rpc.getAccountInfo(address, { encoding: "base64", commitment: "confirmed" }).send()
    return value ? Uint8Array.from(Buffer.from(value.data[0], "base64")) : null
  }

  async function send(instructions: Instruction[]): Promise<{ signature: string; slot: bigint | null }> {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
    const signed = await signTransactionMessageWithSigners(message)
    const signature = getSignatureFromTransaction(signed)
    try {
      await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send()
    } catch (error) {
      throw new Error(`send ${signature}: ${describeError(error)}`)
    }
    const deadline = Date.now() + confirmTimeoutMs
    while (Date.now() < deadline) {
      const { value } = await rpc.getSignatureStatuses([signature]).send()
      const status = value[0]
      if (status?.err) throw new Error(`transaction ${signature} failed: ${json(status.err)}`)
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        return { signature, slot: status.slot }
      }
      await sleep(400)
    }
    throw new Error(`transaction ${signature} not confirmed within ${confirmTimeoutMs} ms`)
  }

  /** Surfpool answers getVersion with surfnet-version; mainnet is recognised by its genesis hash. */
  async function clusterKind(): Promise<ClusterKind> {
    const version = await rpc.getVersion().send() as Record<string, unknown>
    if (typeof version["surfnet-version"] === "string") return "surfnet"
    return (await rpc.getGenesisHash().send()) === MAINNET_GENESIS ? "mainnet" : "other"
  }

  return { rpcUrl, getAccount, send, clusterKind }
}

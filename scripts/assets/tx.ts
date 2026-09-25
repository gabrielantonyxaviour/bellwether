/**
 * Minimal chain context for the asset scripts: an RPC, a send-and-confirm that polls
 * signature status (no websocket needed, so it behaves the same on Surfpool, devnet and
 * mainnet), keypair loading, and the fork-only SOL cheatcode.
 */
import { readFileSync } from "node:fs"
import {
  appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, isSolanaError, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction, type KeyPairSigner, type Signature, type TransactionSigner,
} from "@solana/kit"
import { z } from "zod"

export type Rpc = ReturnType<typeof createSolanaRpc>

export interface Chain {
  rpcUrl: string
  rpc: Rpc
  send(instructions: Instruction[], feePayer: TransactionSigner): Promise<Signature>
  /** Surfpool cheatcode: set an account's lamports. Throws on a cluster without cheatcodes. */
  fundSol(target: Address, lamports: bigint): Promise<void>
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  } catch {
    return String(value)
  }
}

/** Everything useful about a failure in one string: message, logs, custom error codes, causes. */
export function errorText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      parts.push(current.message)
      if (isSolanaError(current)) parts.push(stringify(current.context))
      current = (current as Error & { cause?: unknown }).cause
    } else {
      parts.push(stringify(current))
      break
    }
  }
  return parts.join(" | ")
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createChain(rpcUrl: string, rpc: Rpc = createSolanaRpc(rpcUrl)): Chain {

  async function send(instructions: Instruction[], feePayer: TransactionSigner): Promise<Signature> {
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
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const { value } = await rpc.getSignatureStatuses([signature]).send()
      const status = value[0]
      if (status?.err) throw new Error(`transaction ${signature} failed: ${stringify(status.err)}`)
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return signature
      await sleep(400)
    }
    throw new Error(`transaction ${signature} not confirmed within 90s`)
  }

  async function fundSol(target: Address, lamports: bigint): Promise<void> {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_setAccount", params: [target, { lamports: Number(lamports) }] }),
    })
    const body = (await response.json()) as { error?: { message: string } }
    if (body.error) throw new Error(`surfnet_setAccount failed on ${rpcUrl}: ${body.error.message}`)
  }

  return { rpcUrl, rpc, send, fundSol }
}

const keypairFile = z.array(z.number().int().min(0).max(255)).length(64)

/** Load a Solana CLI keypair file (a JSON array of 64 bytes). Never logs the bytes. */
export async function loadKeypairSigner(path: string): Promise<KeyPairSigner> {
  const parsed = keypairFile.safeParse(JSON.parse(readFileSync(path, "utf8")))
  if (!parsed.success) throw new Error(`${path} is not a 64-byte Solana keypair file`)
  return createKeyPairSignerFromBytes(Uint8Array.from(parsed.data))
}

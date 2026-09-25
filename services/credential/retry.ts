/**
 * Bounded retries for transient RPC failures that happen before a transaction executes: rate
 * limits, dropped connections, and a fork failing to lazily fetch an account from its
 * upstream ("Failed to fetch accounts from remote"). Kit surfaces an RPC rejection that carries
 * no simulation data as a TypeError; the credential RPC transport preserves the raw message
 * so only known transient failures are retried.
 * An executed-and-failed transaction or a confirmation timeout is never retried.
 */
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from "@solana/kit"
import { createChain, errorText, type Chain, type Rpc } from "../../scripts/assets/tx.js"

const TRANSIENT =
  /Failed to fetch accounts from remote|error sending request|Too Many Requests|\b429\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up/i

export const isTransient = (error: unknown) => TRANSIENT.test(errorText(error))

/** Surfpool can return -32002 without `error.data`; Kit otherwise masks its message with a TypeError. */
export function preserveMissingPreflightData(payload: unknown, response: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("method" in payload) || payload.method !== "sendTransaction") return response
  if (!response || typeof response !== "object" || !("error" in response)) return response
  const error = response.error
  if (!error || typeof error !== "object" || !("code" in error) || (error.code !== -32002 && error.code !== -32002n) ||
      ("data" in error && error.data !== undefined && error.data !== null)) return response
  const message = "message" in error && typeof error.message === "string" ? error.message : "Transaction preflight failed without simulation data"
  throw new Error(`RPC preflight rejected without simulation data: ${message}`)
}

export function createCredentialChain(rpcUrl: string): Chain {
  const transport = createDefaultRpcTransport({ url: rpcUrl })
  const rpc = createSolanaRpcFromTransport((async (request) =>
    preserveMissingPreflightData(request.payload, await transport(request))) as typeof transport) as Rpc
  return resilientChain(createChain(rpcUrl, rpc))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseMs = 800): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i >= attempts || !isTransient(error)) throw error
      await sleep(baseMs * 2 ** (i - 1))
    }
  }
}

export function resilientChain(chain: Chain): Chain {
  return {
    ...chain,
    send: (instructions, feePayer) => withRetry(() => chain.send(instructions, feePayer)),
    fundSol: (target, lamports) => withRetry(() => chain.fundSol(target, lamports)),
  }
}

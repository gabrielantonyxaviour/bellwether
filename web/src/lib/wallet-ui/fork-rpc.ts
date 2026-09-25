import { createDefaultRpcTransport, createSolanaRpcFromTransport, type Base64EncodedWireTransaction } from "@solana/kit"

const upstreamFetchFailure = /Failed to fetch accounts from remote/i

export function isRetryableForkSendError(error: unknown): boolean {
  return error instanceof Error && upstreamFetchFailure.test(error.message)
}

/** Surfpool omits `error.data` on some send failures, which Kit otherwise masks with a TypeError. */
export function preserveForkSendError(payload: unknown, response: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("method" in payload) || payload.method !== "sendTransaction") return response
  if (!response || typeof response !== "object" || !("error" in response)) return response
  const error = response.error
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== -32002 ||
      ("data" in error && error.data !== undefined && error.data !== null)) return response
  const message = "message" in error && typeof error.message === "string" ? error.message : "Transaction preflight failed without simulation data"
  throw new Error(`RPC preflight rejected without simulation data: ${message}`)
}

/** Retry only a fork's upstream account fetch, which fails before transaction execution. */
export async function sendForkTransaction(rpcUrl: string, wire: string) {
  const transport = createDefaultRpcTransport({ url: rpcUrl })
  const rpc = createSolanaRpcFromTransport((async (request) =>
    preserveForkSendError(request.payload, await transport(request))) as typeof transport)
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64", skipPreflight: true, preflightCommitment: "confirmed" }).send()
    } catch (error) {
      if (attempt >= 2 || !isRetryableForkSendError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt))
    }
  }
}

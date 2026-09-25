import { z } from "zod"

const upstreamFetchFailure = /Failed to fetch accounts from remote/i
const sendResponse = z.object({ result: z.string().optional(), error: z.object({ message: z.string() }).optional() })

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

/**
 * Send without Kit's response parser. Surfpool's preflight error has no `data`, and Kit
 * turns that into "Cannot destructure property 'err'". Retry the upstream account fetch.
 */
export async function sendForkTransaction(rpcUrl: string, wire: string) {
  let last = "fork send failed"
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [wire, { encoding: "base64", skipPreflight: true }] }),
        signal: AbortSignal.timeout(8_000),
      })
      const body = sendResponse.parse(await response.json())
      if (typeof body.result === "string" && body.result.length > 0) return body.result
      last = body.error?.message ?? `HTTP ${response.status}`
      if (!upstreamFetchFailure.test(last)) throw new Error(last)
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
      const timedOut = error instanceof DOMException || /aborted|timeout/i.test(last)
      if (attempt === 3 || (!timedOut && !upstreamFetchFailure.test(last))) throw error instanceof Error ? error : new Error(last)
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(last)
}

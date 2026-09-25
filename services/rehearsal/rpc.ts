/**
 * A polite JSON-RPC client for the public mainnet endpoint: serialised calls with a minimum
 * spacing (public RPC allows ~40 calls per method per 10 s), and exponential backoff with
 * jitter on HTTP 429/5xx, JSON-RPC 429 errors and network failures (honouring Retry-After).
 */
import { DEFAULT_MAINNET_RPC } from "./constants.js"

export interface RpcClient {
  url: string
  call<T>(method: string, params: unknown[], options?: { maxRetries?: number }): Promise<{ result: T; fetchedAt: string }>
}

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly rateLimited = false) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createRpcClient(options: {
  url?: string; minIntervalMs?: number; maxRetries?: number; timeoutMs?: number; fetchImpl?: typeof fetch
} = {}): RpcClient {
  const url = options.url ?? process.env.BELLWETHER_MAINNET_RPC_URL ?? DEFAULT_MAINNET_RPC
  const minInterval = options.minIntervalMs ?? 260
  const fetchImpl = options.fetchImpl ?? fetch
  let queue: Promise<unknown> = Promise.resolve()
  let lastAt = 0
  let id = 0

  async function once<T>(method: string, params: unknown[]): Promise<T> {
    const wait = lastAt + minInterval - Date.now()
    if (wait > 0) await sleep(wait)
    lastAt = Date.now()
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      })
    } catch (error) {
      throw new RpcError(`${method}: network error ${error instanceof Error ? error.message : String(error)}`, undefined, true)
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after"))
      if (retryAfter > 0) await sleep(Math.min(retryAfter, 30) * 1000)
      throw new RpcError(`${method}: HTTP ${response.status}`, response.status, true)
    }
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string } }
    if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code, body.error.code === 429)
    return body.result as T
  }

  async function withRetry<T>(method: string, params: unknown[], maxRetries: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once<T>(method, params)
      } catch (error) {
        const retryable = error instanceof RpcError && error.rateLimited
        if (!retryable || attempt >= maxRetries) throw error
        await sleep(Math.min(1000 * 2 ** attempt, 16_000) + Math.floor(Math.random() * 400))
      }
    }
  }

  return {
    url,
    call<T>(method: string, params: unknown[], callOptions: { maxRetries?: number } = {}) {
      const run = queue.then(async () => {
        const result = await withRetry<T>(method, params, callOptions.maxRetries ?? options.maxRetries ?? 6)
        return { result, fetchedAt: new Date().toISOString() }
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}

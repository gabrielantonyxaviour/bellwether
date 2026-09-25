/** Narrow Solana JSON-RPC gateway for the browser. Upstream credentials stay server-side. */
import { z } from "zod"

const ReadMethod = z.enum([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance",
  "getTokenAccountBalance", "getLatestBlockhash", "getBlockHeight", "getSignatureStatuses",
  "getTransaction", "simulateTransaction",
])
const Method = z.union([ReadMethod, z.literal("sendTransaction")])
const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(128), z.number().int().safe(), z.null()]),
  method: Method,
  params: z.array(z.unknown()).max(8),
}).strict()
const MAX_BODY = 200_000
const CACHE_MS = 3_000
const PUBLIC_DEVNET = "https://api.devnet.solana.com"

type RpcRequest = z.infer<typeof Request>
type RpcResponse = { status: number; body: unknown }
export type RpcGateway = (body: string) => Promise<RpcResponse>

function validParams(request: RpcRequest): boolean {
  if (request.method === "getLatestBlockhash" || request.method === "getBlockHeight") return request.params.length <= 1
  if (request.method === "getSignatureStatuses") {
    return Array.isArray(request.params[0]) && request.params[0].length <= 256 && request.params[0].every((item) => typeof item === "string")
  }
  if (request.method === "getMultipleAccounts") {
    return Array.isArray(request.params[0]) && request.params[0].length <= 100 && request.params[0].every((item) => typeof item === "string")
  }
  if (request.method === "sendTransaction" || request.method === "simulateTransaction") {
    const wire = request.params[0]
    return typeof wire === "string" && wire.length <= 180_000 && wire.length > 0 && /^[A-Za-z0-9+/=]+$/.test(wire)
  }
  return typeof request.params[0] === "string" && request.params[0].length > 0 && request.params[0].length <= 128
}

function error(status: number, code: string, message: string): RpcResponse {
  return { status, body: { error: message, code } }
}

export function createRpcGateway(options: {
  primary?: string
  fallbacks?: string[]
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}): RpcGateway {
  const primary = options.primary || PUBLIC_DEVNET
  const urls = [...new Set([primary, ...(options.fallbacks ?? [PUBLIC_DEVNET])])]
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random
  const cache = new Map<string, { until: number; value: unknown }>()
  const inFlight = new Map<string, Promise<unknown>>()

  async function upstream(url: string, request: RpcRequest): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetchImpl(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(request), signal: AbortSignal.timeout(8_000),
      })
      if (response.status === 429 && attempt < 3) {
        await sleep(Math.floor(150 * 2 ** attempt + 150 * random()))
        continue
      }
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`)
      const body = await response.json() as Record<string, unknown>
      if (!body || body.jsonrpc !== "2.0" || body.id !== request.id ||
        (!Object.hasOwn(body, "result") && !Object.hasOwn(body, "error"))) throw new Error("invalid upstream response")
      return body
    }
    throw new Error("upstream rate limited")
  }

  async function call(request: RpcRequest): Promise<unknown> {
    for (const url of urls) {
      try { return await upstream(url, request) } catch { /* next configured upstream */ }
    }
    throw new Error("all upstreams unavailable")
  }

  return async (body) => {
    if (body.length > MAX_BODY) return error(413, "rpc_body_too_large", "RPC request is too large")
    let input: unknown
    try { input = JSON.parse(body) } catch { return error(400, "invalid_rpc", "invalid JSON-RPC request") }
    const parsed = Request.safeParse(input)
    if (!parsed.success || !validParams(parsed.data)) return error(400, "invalid_rpc", "invalid JSON-RPC request")
    const request = parsed.data
    const cacheable = ReadMethod.safeParse(request.method).success && request.method !== "simulateTransaction"
    const cacheKey = cacheable ? JSON.stringify([request.method, request.params]) : ""
    const cached = cacheable ? cache.get(cacheKey) : null
    if (cached && cached.until > now()) return { status: 200, body: { jsonrpc: "2.0", id: request.id, result: cached.value } }
    try {
      // The upstream id belongs to the first caller; the envelope below restores each caller's id.
      let pending = cacheable ? inFlight.get(cacheKey) : undefined
      if (!pending) {
        pending = call(request)
        if (cacheable) inFlight.set(cacheKey, pending)
      }
      const result = await pending
      const rpc = result as { result?: unknown; error?: unknown }
      if (request.method === "sendTransaction" && !rpc.error) cache.clear()
      if (cacheable && !rpc.error) {
        if (cache.size >= 512) cache.clear()
        const immutableTx = request.method === "getTransaction" && rpc.result != null &&
          (request.params[1] == null || (typeof request.params[1] === "object" &&
            [undefined, "confirmed", "finalized"].includes((request.params[1] as { commitment?: string }).commitment)))
        cache.set(cacheKey, { until: immutableTx ? Number.POSITIVE_INFINITY : now() + CACHE_MS, value: rpc.result })
      }
      return { status: 200, body: { jsonrpc: "2.0", id: request.id, ...(rpc.error ? { error: rpc.error } : { result: rpc.result }) } }
    } catch { return error(503, "rpc_unavailable", "devnet RPC is unavailable") }
    finally { if (cacheable) inFlight.delete(cacheKey) }
  }
}

/**
 * The few Solana JSON-RPC reads the indexer makes, over fetch (works in Node and Workers).
 * Retries 429 / 5xx / network errors with backoff so a public RPC's rate limit slows the
 * indexer down instead of stopping it.
 */

export interface SignatureInfo {
  signature: string
  slot: number
  err: unknown
  blockTime: number | null
}

export interface TransactionLogs {
  slot: number
  blockTime: number | null
  err: unknown
  logs: string[]
}

export interface ProgramAccount {
  pubkey: string
  data: Uint8Array
}

export interface IndexerRpc {
  signaturesForAddress(address: string, opts: { before?: string; until?: string; limit: number }): Promise<SignatureInfo[]>
  /** null when the node does not have the transaction (yet). */
  transactionLogs(signature: string): Promise<TransactionLogs | null>
  programAccounts(programId: string, filters: unknown[]): Promise<ProgramAccount[]>
  multipleAccounts(addresses: string[]): Promise<{ slot: number; accounts: (Uint8Array | null)[] }>
  blockTime(slot: number): Promise<number | null>
}

export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export function createIndexerRpc(url: string, opts: { commitment?: "confirmed" | "finalized"; retries?: number; timeoutMs?: number } = {}): IndexerRpc {
  const commitment = opts.commitment ?? "confirmed"
  const retries = opts.retries ?? 5
  let id = 0

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(8_000, 250 * 2 ** attempt))
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        })
        if (res.status === 429 || res.status >= 500) {
          last = new RpcError(`${method}: HTTP ${res.status}`, res.status)
          continue
        }
        const body = (await res.json()) as { result?: T; error?: { code: number; message: string } }
        if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code)
        return body.result as T
      } catch (error) {
        if (error instanceof RpcError) throw error
        last = error
      }
    }
    throw last instanceof Error ? last : new Error(`${method} failed`)
  }

  return {
    async signaturesForAddress(address, o) {
      return call<SignatureInfo[]>("getSignaturesForAddress", [address, { commitment, limit: o.limit, before: o.before, until: o.until }])
    },
    async transactionLogs(signature) {
      const tx = await call<{ slot: number; blockTime: number | null; meta: { err: unknown; logMessages: string[] | null } | null } | null>(
        "getTransaction",
        [signature, { commitment, encoding: "json", maxSupportedTransactionVersion: 0 }],
      )
      if (!tx || !tx.meta) return null
      return { slot: tx.slot, blockTime: tx.blockTime, err: tx.meta.err, logs: tx.meta.logMessages ?? [] }
    },
    async programAccounts(programId, filters) {
      const rows = await call<{ pubkey: string; account: { data: [string, string] } }[]>(
        "getProgramAccounts",
        [programId, { commitment, encoding: "base64", filters }],
      )
      return rows.map((r) => ({ pubkey: r.pubkey, data: b64(r.account.data[0]) }))
    },
    async multipleAccounts(addresses) {
      const res = await call<{ context: { slot: number }; value: ({ data: [string, string] } | null)[] }>(
        "getMultipleAccounts",
        [addresses, { commitment, encoding: "base64" }],
      )
      return { slot: res.context.slot, accounts: res.value.map((a) => (a ? b64(a.data[0]) : null)) }
    },
    async blockTime(slot) {
      try {
        return await call<number | null>("getBlockTime", [slot])
      } catch {
        return null
      }
    },
  }
}

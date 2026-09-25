/**
 * logsSubscribe over a websocket (the global WebSocket in Node ≥ 22 and in Workers), filtered
 * to transactions that mention the venue program. Reconnects with backoff and resubscribes;
 * anything missed while disconnected is picked up by the indexer's signature backfill.
 */

export interface LogsNotification {
  signature: string
  slot: number
  err: unknown
  logs: string[]
}

export interface LogsSubscription {
  close(): void
  connected(): boolean
}

export function subscribeProgramLogs(opts: {
  wsUrl: string
  programId: string
  commitment?: "confirmed" | "finalized"
  onLogs: (n: LogsNotification) => void
  onState?: (state: "open" | "subscribed" | "closed", detail?: string) => void
}): LogsSubscription {
  let socket: WebSocket | null = null
  let closed = false
  let subscribed = false
  let backoff = 1_000
  let timer: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (closed) return
    const ws = new WebSocket(opts.wsUrl)
    socket = ws
    ws.addEventListener("open", () => {
      opts.onState?.("open")
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "logsSubscribe",
        params: [{ mentions: [opts.programId] }, { commitment: opts.commitment ?? "confirmed" }],
      }))
    })
    ws.addEventListener("message", (ev) => {
      let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: string[] } } } }
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer))
      } catch {
        return
      }
      if (msg.id === 1) {
        if (msg.error) opts.onState?.("closed", `logsSubscribe refused: ${msg.error.message}`)
        else {
          subscribed = true
          backoff = 1_000
          opts.onState?.("subscribed")
        }
        return
      }
      const value = msg.params?.result?.value
      if (msg.method === "logsNotification" && value?.signature) {
        opts.onLogs({ signature: value.signature, slot: msg.params?.result?.context?.slot ?? 0, err: value.err ?? null, logs: value.logs ?? [] })
      }
    })
    const retry = (detail: string) => {
      if (socket !== ws) return
      subscribed = false
      socket = null
      opts.onState?.("closed", detail)
      if (closed) return
      timer = setTimeout(connect, backoff)
      backoff = Math.min(30_000, backoff * 2)
    }
    ws.addEventListener("close", (ev) => retry(`closed ${ev.code}`))
    ws.addEventListener("error", () => {
      try { ws.close() } catch { /* already closing */ }
      retry("error")
    })
  }

  connect()
  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      try { socket?.close() } catch { /* already closed */ }
      socket = null
    },
    connected: () => subscribed,
  }
}

/**
 * The tape indexer: live prints from logsSubscribe, a signature backfill that also runs on a
 * timer as a safety net, periodic pool-account snapshots for end-of-day pool size (liquidity
 * adds and removals emit no event), and retention pruning. Every write is idempotent, so the
 * websocket and the backfill may see the same transaction.
 */
import { decodePool, decodeSymbol, POOL_KIND, POOL_LEN } from "./accounts.js"
import { tradeEventsFromLogs } from "./event.js"
import { subscribeProgramLogs, type LogsSubscription } from "./logs-ws.js"
import { toPrint } from "./print.js"
import type { IndexerRpc, SignatureInfo } from "./rpc.js"
import { ACCOUNT_ORD, DAY_S, STATUS_KEY, type IndexerStatus, type TapeStore } from "./store.js"

export interface IndexerOptions {
  store: TapeStore
  rpc: IndexerRpc
  programId: string
  /** Known pool addresses on a private fork; normal indexers discover every pool. */
  poolAccounts?: string[]
  /** Omit to run on the backfill poll alone. */
  wsUrl?: string
  pollMs: number
  poolRefreshMs: number
  retentionDays: number
  backfillMax: number
  now?: () => number
  log?: (line: string) => void
}

const PAGE = 1_000

export class TapeIndexer {
  private sub: LogsSubscription | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  private running = false
  private backfilling: Promise<number> | null = null
  private backfillAgain = false
  private readonly now: () => number
  private readonly log: (line: string) => void
  readonly state: IndexerStatus

  constructor(private readonly o: IndexerOptions) {
    this.now = o.now ?? Date.now
    this.log = o.log ?? (() => {})
    this.state = {
      program: o.programId, ws: o.wsUrl ? "connecting" : "off", lastSlot: 0, lastBackfillAt: null,
      lastPoolRefreshAt: null, printsIndexed: 0, lastError: null, updatedAt: this.now(),
    }
  }

  private get cursorKey() {
    return `cursor:${this.o.programId}`
  }

  /** Decodes and stores every print in one transaction's logs. Returns how many were new. */
  async ingest(tx: { signature: string; slot: number; err: unknown; logs: string[] }): Promise<number> {
    if (tx.err) return 0
    const { events, truncated } = tradeEventsFromLogs(tx.logs, this.o.programId)
    if (truncated) this.log(`warn logs truncated in ${tx.signature}; prints after the cut are unknowable from logs`)
    let fresh = 0
    for (const [eventIndex, event] of events.entries()) {
      const print = toPrint(event, { signature: tx.signature, eventIndex, slot: tx.slot, indexedAt: this.now() })
      await this.o.store.upsertPool({
        pool: event.pool, program: event.program, ticker: event.ticker, stockMint: event.stockMint, usdcMint: event.usdcMint,
        stockDecimals: event.stockDecimals, usdcDecimals: event.usdcDecimals, symbolRecord: null, feeBps: null,
        halted: null, active: null, updatedAt: this.now(),
      })
      // Two swaps on one pool in one slot share (slot, ord); the next account snapshot settles the order.
      await this.o.store.insertSnapshot({
        pool: event.pool, time: event.time, slot: tx.slot, ord: eventIndex,
        reserveStock: event.reserveStock, reserveUsdc: event.reserveUsdc, source: "print",
      })
      if (await this.o.store.insertPrint(print)) {
        fresh++
        this.log(`print ${event.ticker} ${print.side} ${tx.signature}#${eventIndex} slot ${tx.slot}`)
      }
    }
    this.state.printsIndexed += fresh
    this.state.lastSlot = Math.max(this.state.lastSlot, tx.slot)
    return fresh
  }

  /** Walks signatures newer than the cursor (or back to the retention horizon), oldest first. */
  backfill(): Promise<number> {
    // A request during a running walk (e.g. the websocket just subscribed) queues one more walk,
    // so nothing that landed after the running walk listed its signatures is left to the timer.
    if (this.backfilling) {
      this.backfillAgain = true
      return this.backfilling
    }
    this.backfilling = (async () => {
      let fresh = 0
      do {
        this.backfillAgain = false
        fresh += await this.runBackfill()
      } while (this.backfillAgain)
      this.state.lastError = null
      return fresh
    })().finally(() => { this.backfilling = null })
    return this.backfilling
  }

  private async runBackfill(): Promise<number> {
    const cursor = (await this.o.store.getMeta(this.cursorKey)) ?? undefined
    const horizon = Math.floor(this.now() / 1000) - this.o.retentionDays * DAY_S
    const pending: SignatureInfo[] = []
    let before: string | undefined
    for (;;) {
      const page = await this.o.rpc.signaturesForAddress(this.o.programId, { before, until: cursor, limit: PAGE })
      let reachedHorizon = false
      for (const s of page) {
        if (!cursor && s.blockTime !== null && s.blockTime < horizon) { reachedHorizon = true; break }
        pending.push(s)
      }
      if (reachedHorizon || page.length < PAGE || pending.length >= this.o.backfillMax) break
      before = page[page.length - 1].signature
    }
    if (pending.length >= this.o.backfillMax) this.log(`warn backfill capped at ${this.o.backfillMax} signatures; older ones are skipped`)
    let fresh = 0
    let lastDone: string | undefined
    for (const s of pending.slice(0, this.o.backfillMax).reverse()) {
      if (!s.err) {
        const tx = await this.o.rpc.transactionLogs(s.signature)
        if (!tx) break // not served yet: stop here and retry from this point next round
        fresh += await this.ingest({ signature: s.signature, slot: tx.slot, err: tx.err, logs: tx.logs })
      }
      lastDone = s.signature
    }
    if (lastDone) await this.o.store.setMeta(this.cursorKey, lastDone)
    this.state.lastBackfillAt = this.now()
    return fresh
  }

  /** Snapshots every pool account (reserves, fee, the symbol's halt and activation flags). */
  async refreshPools(): Promise<number> {
    const found = this.o.poolAccounts
      ? await this.knownPools()
      : await this.o.rpc.programAccounts(this.o.programId, [
        { dataSize: POOL_LEN }, { memcmp: { offset: 0, bytes: "4" } }, // base58 of [3] = pool kind
      ])
    const pools = found.flatMap((a) => (decodePool(a.data) ? [a.pubkey] : []))
    this.state.lastPoolRefreshAt = this.now()
    if (pools.length === 0) return 0
    const symbolsOf = pools.map((p) => decodePool(found.find((a) => a.pubkey === p)!.data)!.symbol)
    const { slot, accounts } = await this.o.rpc.multipleAccounts([...pools, ...symbolsOf])
    const time = (await this.o.rpc.blockTime(slot)) ?? Math.floor(this.now() / 1000)
    let changed = 0
    for (const [i, address] of pools.entries()) {
      const pool = accounts[i] ? decodePool(accounts[i]!) : null
      if (!pool) continue
      const symbolData = accounts[pools.length + i]
      const symbol = symbolData ? decodeSymbol(symbolData) : null
      if (!symbol) continue
      await this.o.store.upsertPool({
        pool: address, program: this.o.programId, ticker: symbol.ticker, stockMint: pool.stockMint, usdcMint: pool.usdcMint,
        stockDecimals: pool.stockDecimals, usdcDecimals: pool.usdcDecimals, symbolRecord: pool.symbol, feeBps: pool.feeBps,
        halted: symbol.halted, active: symbol.active, updatedAt: this.now(),
      })
      const last = await this.o.store.latestSnapshot(address)
      if (last && last.reserveStock === pool.reserveStock && last.reserveUsdc === pool.reserveUsdc) continue
      if (last && last.slot > slot) continue
      await this.o.store.insertSnapshot({
        pool: address, time, slot, ord: ACCOUNT_ORD, reserveStock: pool.reserveStock, reserveUsdc: pool.reserveUsdc, source: "account",
      })
      changed++
    }
    return changed
  }

  private async knownPools() {
    const pools = this.o.poolAccounts!
    const { accounts } = await this.o.rpc.multipleAccounts(pools)
    return pools.map((pubkey, index) => {
      const data = accounts[index]
      if (!data || !decodePool(data)) throw new Error(`configured pool ${pubkey} is missing or invalid`)
      return { pubkey, data }
    })
  }

  async prune(): Promise<number> {
    return this.o.store.prune(Math.floor(this.now() / 1000) - this.o.retentionDays * DAY_S)
  }

  private async saveStatus(error?: unknown) {
    if (error !== undefined) this.state.lastError = error instanceof Error ? error.message : String(error)
    this.state.updatedAt = this.now()
    await this.o.store.setMeta(STATUS_KEY, JSON.stringify(this.state)).catch(() => {})
  }

  private every(ms: number, job: () => Promise<unknown>, label: string) {
    const run = async () => {
      if (!this.running) return
      try {
        await job()
        await this.saveStatus()
      } catch (error) {
        this.log(`error ${label}: ${error instanceof Error ? error.message : String(error)}`)
        await this.saveStatus(error)
      }
      if (this.running) this.timers.push(setTimeout(run, ms))
    }
    void run()
  }

  start(): void {
    if (this.running) return
    this.running = true
    if (this.o.wsUrl) {
      this.sub = subscribeProgramLogs({
        wsUrl: this.o.wsUrl,
        programId: this.o.programId,
        onLogs: (n) => {
          this.ingest(n).then(() => this.saveStatus(), (error) => this.saveStatus(error))
        },
        onState: (s, detail) => {
          this.state.ws = s
          this.log(`ws ${s}${detail ? ` (${detail})` : ""}`)
          void this.saveStatus()
          if (s === "subscribed") void this.backfill().catch((error) => this.saveStatus(error))
        },
      })
    }
    this.every(this.o.poolRefreshMs, () => this.refreshPools(), "pool refresh")
    this.every(this.o.pollMs, () => this.backfill(), "backfill")
    this.every(3_600_000, () => this.prune(), "prune")
  }

  async stop(): Promise<void> {
    this.running = false
    this.sub?.close()
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    await this.backfilling?.catch(() => 0)
  }
}

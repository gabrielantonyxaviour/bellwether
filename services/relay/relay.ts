/**
 * One relay cycle: claim a poll slot (≥ 60 s apart), fetch and parse the Nasdaq halt feed, and for
 * every mapped symbol send exactly one relay instruction — set_halt for a halt the chain does not
 * enforce yet, clear_halt for a halt that has lifted, otherwise heartbeat. Each carries the next
 * per-symbol sequence, read from the SymbolRecord. A failed poll sends nothing, so the program's
 * heartbeat_max_age check fails closed (HaltDataStale) if the feed stays unreachable.
 */
import type { Address, Instruction, TransactionSigner } from "@solana/kit"
import { FeedUnavailable, haltStateFor, parseHaltFeed, type HaltItem } from "./feed.js"
import { type HaltLedgerEntry, type RelayState, type RelayStore } from "./ledger.js"
import { clearHaltInstruction, decodeSymbolRecord, heartbeatInstruction, setHaltInstruction, type SymbolRecordView } from "./program.js"
import { PollGate, systemClock, type Clock } from "./scheduler.js"

export interface RelayChain {
  getAccount(address: Address): Promise<Uint8Array | null>
  send(instructions: Instruction[]): Promise<{ signature: string; slot: bigint | null }>
}

export interface ResolvedSymbol {
  /** Nasdaq IssueSymbol the on-chain symbol follows (e.g. FWDI). */
  nasdaq: string
  /** On-chain ticker (e.g. BWRS). */
  ticker: string
  stockMint: Address
  symbolRecord: Address
}

export type RelayAction = "set_halt" | "clear_halt" | "heartbeat"
export type RelayEvent =
  | { kind: "halt" | "resume"; symbol: ResolvedSymbol; entry: HaltLedgerEntry }
  | { kind: "poll-failed"; error: string }

export interface CycleResult {
  ok: boolean
  at: string
  source: "nasdaq" | "nyse-fallback" | null
  error?: string
  actions: { nasdaq: string; action: RelayAction | "failed"; seq: string | null; signature?: string; error?: string }[]
}

export interface RelayOptions {
  programId: Address
  venue: Address
  relay: TransactionSigner
  symbols: ResolvedSymbol[]
  chain: RelayChain
  store: RelayStore
  fetchFeed: () => Promise<string>
  clock?: Clock
  gate?: PollGate
  /** NYSE current halts: recorded as a cross-check each successful cycle. */
  crossCheck?: () => Promise<HaltItem[]>
  /** Use crossCheck as the source when the Nasdaq poll fails (off by default: a failed poll then skips the heartbeat). */
  nyseFallback?: boolean
  /** Participant notification hook (halt / resume) and failure reporting. */
  onEvent?: (event: RelayEvent) => void
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

export function createRelay(options: RelayOptions) {
  const clock = options.clock ?? systemClock
  const gate = options.gate ?? new PollGate()
  const iso = (ms: number) => new Date(ms).toISOString()

  async function poll(): Promise<{ items: HaltItem[]; source: "nasdaq" | "nyse-fallback"; publishedAt: string | null }> {
    try {
      const feed = parseHaltFeed(await options.fetchFeed())
      return { items: feed.items, source: "nasdaq", publishedAt: feed.publishedAt }
    } catch (error) {
      const failure = error instanceof FeedUnavailable ? error : new FeedUnavailable("network", errText(error))
      if (!options.nyseFallback || !options.crossCheck) throw failure
      try {
        return { items: await options.crossCheck(), source: "nyse-fallback", publishedAt: null }
      } catch (fallbackError) {
        throw new FeedUnavailable(failure.kind, `${failure.message}; NYSE fallback: ${errText(fallbackError)}`)
      }
    }
  }

  function ledgerFor(state: RelayState, sym: ResolvedSymbol, item: HaltItem, seenAt: number): HaltLedgerEntry {
    const id = `${sym.nasdaq}|${iso(item.haltAt)}`
    let entry = state.ledger.find((e) => e.id === id)
    if (!entry) {
      entry = {
        id, nasdaqSymbol: sym.nasdaq, ticker: sym.ticker, symbolRecord: sym.symbolRecord, reasonCode: item.reasonCode,
        nasdaqHaltTime: iso(item.haltAt), feedSeenAt: iso(seenAt), haltSignature: null, haltConfirmedAt: null, haltSlot: null,
        detectionMs: seenAt - item.haltAt, enforcementMs: null, resumedAt: item.resumedAt === null ? null : iso(item.resumedAt),
        resumeSeenAt: null, clearSignature: null, clearConfirmedAt: null, status: "pending",
      }
      state.ledger.push(entry)
    }
    if (item.resumedAt !== null) entry.resumedAt = iso(item.resumedAt)
    return entry
  }

  async function relaySymbol(state: RelayState, sym: ResolvedSymbol, items: HaltItem[], pollAt: number, seenAt: number) {
    const data = await options.chain.getAccount(sym.symbolRecord)
    if (!data) throw new Error(`SymbolRecord ${sym.symbolRecord} (${sym.ticker}) not found`)
    const record: SymbolRecordView = decodeSymbolRecord(data)
    const want = haltStateFor(items, sym.nasdaq, pollAt)
    const entry = want.item ? ledgerFor(state, sym, want.item, seenAt) : null
    const seq = record.seq + 1n
    const base = { programId: options.programId, relay: options.relay, venue: options.venue, symbol: sym.symbolRecord, seq }
    let action: RelayAction = "heartbeat"
    let ix = heartbeatInstruction(base)
    if (want.halted && want.item && (!record.halted || record.haltedAt !== BigInt(Math.floor(want.item.haltAt / 1000)))) {
      action = "set_halt"
      const reason = want.item.reasonCode.replace(/[^\x20-\x7e]/g, "?").slice(0, 8)
      ix = setHaltInstruction({ ...base, reason, feedTs: BigInt(Math.floor(want.item.haltAt / 1000)) })
    } else if (!want.halted && record.halted) {
      action = "clear_halt"
      ix = clearHaltInstruction(base)
    } else if (entry && !want.halted && entry.status === "pending") {
      entry.status = "missed"
    }
    const sent = await options.chain.send([ix])
    const confirmedAt = clock.now()
    state.status.lastHeartbeatAt = iso(confirmedAt)
    state.status.lastHeartbeatSignature = sent.signature
    const halted = action === "set_halt" ? true : action === "clear_halt" ? false : record.halted
    state.status.symbols[sym.nasdaq] = {
      ticker: sym.ticker, symbolRecord: sym.symbolRecord, halted, reasonCode: halted ? (want.item?.reasonCode ?? record.haltReason) : null,
      seq: seq.toString(), lastAction: action, lastActionAt: iso(confirmedAt),
    }
    const enforced = state.ledger.filter((e) => e.nasdaqSymbol === sym.nasdaq && e.status === "halted" && e !== entry)
    if (action === "set_halt" && entry) {
      // A new halt replaces whatever halt the chain enforced before.
      for (const prior of enforced) Object.assign(prior, { resumeSeenAt: iso(seenAt), status: "resumed" })
      Object.assign(entry, { haltSignature: sent.signature, haltConfirmedAt: iso(confirmedAt), haltSlot: sent.slot?.toString() ?? null, status: "halted" })
      entry.enforcementMs = confirmedAt - Date.parse(entry.nasdaqHaltTime)
      options.onEvent?.({ kind: "halt", symbol: sym, entry })
    }
    if (action === "clear_halt") {
      if (entry && entry.status === "pending") entry.status = "missed"
      for (const open of entry?.status === "halted" ? [entry, ...enforced] : enforced) {
        Object.assign(open, { resumeSeenAt: iso(seenAt), clearSignature: sent.signature, clearConfirmedAt: iso(confirmedAt), status: "resumed" })
        options.onEvent?.({ kind: "resume", symbol: sym, entry: open })
      }
    }
    return { nasdaq: sym.nasdaq, action, seq: seq.toString(), signature: sent.signature }
  }

  async function crossCheck(state: RelayState, items: HaltItem[], at: number) {
    if (!options.crossCheck) return
    try {
      const nyse = await options.crossCheck()
      const disagreements = options.symbols
        .filter((s) => haltStateFor(items, s.nasdaq, at).halted !== haltStateFor(nyse, s.nasdaq, at).halted)
        .map((s) => s.nasdaq)
      state.status.crossCheck = { at: iso(clock.now()), ok: disagreements.length === 0, disagreements, error: null }
    } catch (error) {
      state.status.crossCheck = { at: iso(clock.now()), ok: false, disagreements: [], error: errText(error) }
    }
  }

  /** One poll-and-relay cycle. Throws PollTooSoon (before any network call) inside the 60 s window. */
  async function cycle(): Promise<CycleResult> {
    const pollAt = clock.now()
    gate.acquire(pollAt)
    const state = await options.store.load()
    state.status.relay = options.relay.address
    state.status.lastPollAt = iso(pollAt)
    let feed: Awaited<ReturnType<typeof poll>>
    try {
      feed = await poll()
    } catch (error) {
      const message = errText(error)
      Object.assign(state.status, { lastPollOk: false, lastPollError: message, lastSource: null })
      state.status.consecutiveFailures += 1
      await options.store.save(state)
      options.onEvent?.({ kind: "poll-failed", error: message })
      return { ok: false, at: iso(pollAt), source: null, error: message, actions: [] }
    }
    const seenAt = clock.now()
    Object.assign(state.status, { lastPollOk: true, lastPollError: null, lastSource: feed.source, feedPublishedAt: feed.publishedAt, consecutiveFailures: 0 })
    const actions: CycleResult["actions"] = []
    let txError: string | null = null
    for (const sym of options.symbols) {
      try {
        actions.push(await relaySymbol(state, sym, feed.items, pollAt, seenAt))
      } catch (error) {
        txError = `${sym.nasdaq}: ${errText(error)}`
        actions.push({ nasdaq: sym.nasdaq, action: "failed", seq: null, error: txError })
      }
    }
    state.status.lastTxError = txError
    if (feed.source === "nasdaq") await crossCheck(state, feed.items, pollAt)
    await options.store.save(state)
    return { ok: txError === null, at: iso(pollAt), source: feed.source, actions, ...(txError ? { error: txError } : {}) }
  }

  return { cycle, gate }
}

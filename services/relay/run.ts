/**
 * The halt relay as a long-running Node process:
 *   npx tsx services/relay/run.ts            (environment: see config.ts)
 *
 * Startup refuses to run unless the venue names this keypair as its relay, every mapped
 * SymbolRecord exists with the configured mint, and — on mainnet — RELAY_CONFIRM_MAINNET=1.
 * It then polls at most once per RELAY_POLL_INTERVAL_MS (≥ 60 s, also across restarts) and
 * writes one JSON line per cycle to stdout.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { address, createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit"
import { z } from "zod"
import { createRpcChain, describeError } from "./chain.js"
import { parseRelayConfig, type RelayConfig } from "./config.js"
import { fetchHaltFeed } from "./feed.js"
import { jsonFileStore } from "./ledger.js"
import { fetchNyseCurrent } from "./nyse.js"
import { decodeSymbolRecord, decodeVenueConfig, findSymbolRecord } from "./program.js"
import { createRelay, type RelayChain, type ResolvedSymbol } from "./relay.js"
import { PollGate, runLoop } from "./scheduler.js"

const line = (record: Record<string, unknown>) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n")

export async function loadRelayKeypair(path: string): Promise<KeyPairSigner> {
  const parsed = z.array(z.number().int().min(0).max(255)).length(64).safeParse(JSON.parse(readFileSync(path, "utf8")))
  if (!parsed.success) throw new Error(`${path} is not a 64-byte Solana keypair file`)
  return createKeyPairSignerFromBytes(Uint8Array.from(parsed.data))
}

/** Derives and verifies each mapped SymbolRecord against the chain. */
export async function resolveSymbols(config: Pick<RelayConfig, "programId" | "venue" | "symbols">, chain: RelayChain): Promise<ResolvedSymbol[]> {
  const out: ResolvedSymbol[] = []
  for (const m of config.symbols) {
    const record = m.symbolRecord ? address(m.symbolRecord) : await findSymbolRecord(address(config.programId), address(config.venue), address(m.stockMint))
    const data = await chain.getAccount(record)
    if (!data) throw new Error(`no SymbolRecord for ${m.nasdaq} at ${record}`)
    const view = decodeSymbolRecord(data)
    if (view.mint !== m.stockMint || view.venue !== config.venue) throw new Error(`SymbolRecord ${record} is not ${m.stockMint} on venue ${config.venue}`)
    if (m.ticker && view.ticker !== m.ticker) throw new Error(`SymbolRecord ${record} has ticker ${view.ticker}, config says ${m.ticker}`)
    out.push({ nasdaq: m.nasdaq, ticker: view.ticker, stockMint: address(m.stockMint), symbolRecord: record })
  }
  return out
}

async function main() {
  const config = parseRelayConfig()
  const signer = await loadRelayKeypair(config.keypairPath)
  const chain = createRpcChain(config.rpcUrl, signer)
  const kind = await chain.clusterKind()
  if (kind === "mainnet" && !config.confirmMainnet) throw new Error("refusing to send relay transactions to mainnet without RELAY_CONFIRM_MAINNET=1")
  const venueData = await chain.getAccount(address(config.venue))
  if (!venueData) throw new Error(`no VenueConfig at ${config.venue}`)
  const venue = decodeVenueConfig(venueData)
  if (venue.relay !== signer.address) throw new Error(`venue relay is ${venue.relay}, but the keypair is ${signer.address}`)
  const symbols = await resolveSymbols(config, chain)
  const store = jsonFileStore(config.dataDir)
  const last = (await store.load()).status.lastPollAt
  const gate = new PollGate(config.pollIntervalMs, last ? Date.parse(last) : null)
  const relay = createRelay({
    programId: address(config.programId), venue: address(config.venue), relay: signer, symbols, chain, store, gate,
    fetchFeed: () => fetchHaltFeed(config.feedUrl),
    crossCheck: config.nyseCrossCheck || config.nyseFallback ? () => fetchNyseCurrent(config.nyseUrl) : undefined,
    nyseFallback: config.nyseFallback,
    onEvent: (event) => line(event.kind === "poll-failed" ? event : { kind: event.kind, symbol: event.symbol.nasdaq, entry: event.entry }),
  })
  line({ kind: "start", cluster: kind, relay: signer.address, heartbeatMaxAge: venue.heartbeatMaxAge.toString(), symbols: symbols.map((s) => `${s.nasdaq}→${s.ticker}`), pollIntervalMs: config.pollIntervalMs })
  const abort = new AbortController()
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => abort.abort())
  await runLoop({
    gate, intervalMs: config.pollIntervalMs, signal: abort.signal,
    cycle: async () => line({ kind: "cycle", ...(await relay.cycle()) }),
    onError: (error) => line({ kind: "cycle-error", error: describeError(error) }),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`relay failed: ${describeError(error)}\n`)
    process.exit(1)
  })
}

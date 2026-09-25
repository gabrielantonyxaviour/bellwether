/**
 * The caps job: for every symbol registered on the venue, compute the prior-month daily cap and,
 * when the data is complete, send set_cap with the data-authority key. Partial data is withheld
 * (the on-chain value stays as it was — 0 for a new symbol, which refuses every swap). A value
 * already on chain is not re-sent. Every run is stored as provenance JSON.
 */
import type { Address, KeyPairSigner } from "@solana/kit"
import type { CapsRpc, SendFn } from "./chain.js"
import { computeSymbolCap, loadTierLists, type SymbolCap } from "./compute.js"
import { DEFAULT_LEAD_SECONDS, volumeSymbolFor } from "./config.js"
import { writeProvenance, type ProvenanceRun, type SymbolProvenance } from "./provenance.js"
import { targetTradeDate } from "./units.js"
import { priorMonth } from "../rehearsal/constants.js"
import { listSymbols, readMintUnits, readVenue, setCapIx, type SymbolRecord } from "./venue.js"
import type { MonthVolume } from "./volume.js"

export interface CapsJobOptions {
  rpc: CapsRpc
  send: SendFn
  programId: Address
  venue: Address
  /** The venue's data authority. null computes and records without sending (dry run). */
  dataAuthority: KeyPairSigner | null
  now?: Date
  fetchImpl?: typeof fetch
  /** Restrict the run to these on-chain tickers. */
  tickers?: string[]
  provenanceDir?: string | null
  leadSeconds?: number
  rpcHost?: string
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

type MintUnits = Awaited<ReturnType<typeof readMintUnits>>

function toProvenance(rec: SymbolRecord, mint: MintUnits | null, mintError: string | null, c: SymbolCap, onchain: SymbolProvenance["onchain"]): SymbolProvenance {
  const partialMint = mint === null
  return {
    ticker: rec.ticker, symbolAccount: rec.address,
    mint: mint && { address: rec.mint, ...mint },
    volumeSymbol: c.volumeSymbol, mapping: c.mapping, tradeDate: c.tradeDate, month: c.month,
    status: partialMint ? "partial" : c.status,
    missing: partialMint ? [...c.missing, "mint"] : c.missing,
    tier: { ...c.tier, onchainTier: rec.tier, matchesOnchain: c.tier.tier === null ? null : c.tier.tier === rec.tier },
    volume: c.volume,
    adv: partialMint ? null : c.adv,
    cap: partialMint || !c.cap ? null : { ...c.cap, units: c.cap.units.toString(), advUnits: c.cap.advUnits.toString() },
    onchain,
    errors: mintError ? [...c.errors, `mint: ${mintError}`] : c.errors,
  }
}

export async function runCapsJob(o: CapsJobOptions): Promise<ProvenanceRun> {
  const venueCfg = await readVenue(o.rpc, o.programId, o.venue)
  if (o.dataAuthority && o.dataAuthority.address !== venueCfg.dataAuthority) {
    throw new Error(`${o.dataAuthority.address} is not the venue's data authority (${venueCfg.dataAuthority}); refusing to send set_cap`)
  }
  const now = o.now ?? new Date()
  const leadSeconds = o.leadSeconds ?? DEFAULT_LEAD_SECONDS
  const tradeDate = targetTradeDate(now, venueCfg.cutoffSeconds, leadSeconds)
  const registered = await listSymbols(o.rpc, o.programId, o.venue)
  const wanted = o.tickers?.map((t) => t.toUpperCase())
  const records = wanted ? registered.filter((r) => wanted.includes(r.ticker.toUpperCase())) : registered
  const lists = await loadTierLists(o.fetchImpl)
  const volumes = new Map<string, Promise<MonthVolume>>()
  const symbols: SymbolProvenance[] = []

  for (const rec of records) {
    let mint: MintUnits | null = null
    let mintError: string | null = null
    try {
      mint = await readMintUnits(o.rpc, rec.mint, now)
    } catch (e) {
      mintError = message(e)
    }
    const { volumeSymbol } = volumeSymbolFor(rec.ticker)
    const shared = volumes.get(volumeSymbol)
    const c = await computeSymbolCap({
      ticker: rec.ticker, now, cutoffSeconds: venueCfg.cutoffSeconds, leadSeconds, lists, fetchImpl: o.fetchImpl,
      decimals: mint?.decimals ?? 0, multiplier: mint?.multiplier ?? 1, volume: shared ? await shared : undefined,
    })
    if (!shared) volumes.set(volumeSymbol, Promise.resolve(c.volume))

    const before = { capUnits: rec.capUnits.toString(), advUnits: rec.advUnits.toString(), multNum: rec.multNum, multDen: rec.multDen, tier: rec.tier }
    const onchain: SymbolProvenance["onchain"] = { before, action: "withheld", signature: null, error: null }
    if (c.status === "complete" && c.cap && mint) {
      const same = rec.capUnits === c.cap.units && rec.advUnits === c.cap.advUnits && rec.multNum === c.cap.multiplier.num && rec.multDen === c.cap.multiplier.den
      if (same) onchain.action = "unchanged"
      else if (!o.dataAuthority) onchain.action = "dry-run"
      else {
        try {
          onchain.signature = await o.send([setCapIx({
            programId: o.programId, authority: o.dataAuthority, venue: o.venue, symbol: rec.address,
            capUnits: c.cap.units, advUnits: c.cap.advUnits, num: c.cap.multiplier.num, den: c.cap.multiplier.den,
          })], o.dataAuthority)
          onchain.action = "sent"
        } catch (e) {
          onchain.action = "failed"
          onchain.error = message(e)
        }
      }
    }
    symbols.push(toProvenance(rec, mint, mintError, c, onchain))
  }

  const count = (f: (s: SymbolProvenance) => boolean) => symbols.filter(f).length
  const run: ProvenanceRun = {
    schemaVersion: 1, job: "caps-data", ranAt: new Date().toISOString(), now: now.toISOString(), tradeDate,
    month: priorMonth(new Date(`${tradeDate}T00:00:00Z`)).key, programId: o.programId, venue: o.venue,
    dataAuthority: o.dataAuthority?.address ?? venueCfg.dataAuthority, rpcHost: o.rpcHost ?? "unknown",
    summary: {
      complete: count((s) => s.status === "complete"), partial: count((s) => s.status === "partial"),
      sent: count((s) => s.onchain.action === "sent"), unchanged: count((s) => s.onchain.action === "unchanged"),
      withheld: count((s) => s.onchain.action === "withheld"), failed: count((s) => s.onchain.action === "failed"),
    },
    symbols,
  }
  if (o.provenanceDir) writeProvenance(o.provenanceDir, run)
  return run
}

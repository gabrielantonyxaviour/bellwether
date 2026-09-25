/**
 * Accept check for blk_caps_data:
 *   npx tsx checks/caps-data.ts
 *
 * 1. Offline, from the recorded August 2026 FWDI bars (services/caps/fixtures/fwdi-2026-08.json):
 *    the computed ADV and daily cap equal a hand calculation, the Yahoo cross-check agrees within
 *    1%, the tier falls back to the documented override (Tier 2, inferred) because the iShares
 *    holdings URLs served an HTML page, and any missing source yields 'partial' with no number.
 * 2. On this check's own Surfpool fork (RPC 8920, ws 8921): deploys the prebuilt venue program,
 *    registers BWRS (the rehearsal stock, which follows FWDI's volume), FWDI (the real mainnet mint
 *    read through the fork) and a symbol with no data, runs the caps job with the data-authority
 *    key, and reads each SymbolRecord back. A partial run writes nothing. The fork it started is
 *    stopped by pid.
 * Exits non-zero on any mismatch.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { address, generateKeyPairSigner } from "@solana/kit"
import { computeSymbolCap, loadTierLists } from "../services/caps/compute.js"
import { fixtureFetch, loadFixture, ishareSampleCsv } from "../services/caps/fixture-fetch.js"
import { classifyTier } from "../services/caps/tier.js"
import { runCapsJob } from "../services/caps/job.js"
import { provenanceRunSchema, symbolProvenanceSchema } from "../services/caps/provenance.js"
import { createCapsChain } from "../services/caps/chain.js"
import { startOwnSurfpool, deployProgram, setMintAccount, fundSol, VENUE_SO } from "../services/caps/fork.js"
import { initVenueIx, registerSymbolIx, venuePda, symbolPda, readSymbolRecord } from "../services/caps/venue.js"
import { FWDI_MINT } from "../services/rehearsal/constants.js"

const failures: string[] = []
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x))
function expect(ok: boolean, what: string, got?: unknown) {
  if (!ok) failures.push(`${what}${got === undefined ? "" : ` — got ${show(got)}`}`)
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${what}${!ok && got !== undefined ? ` — got ${show(got)}` : ""}\n`)
}
const near = (a: number | null | undefined, b: number, eps = 1e-6) => typeof a === "number" && Math.abs(a - b) <= eps

// Hand calculation. The 21 Nasdaq rows for FWDI, August 2026, copied by hand from the fixture.
const AUG_2026_NASDAQ: [string, number][] = [
  ["2026-08-03", 803_595], ["2026-08-04", 931_995], ["2026-08-05", 533_001], ["2026-08-06", 459_432],
  ["2026-08-07", 521_795], ["2026-08-10", 743_022], ["2026-08-11", 699_472], ["2026-08-12", 1_038_611],
  ["2026-08-13", 1_185_637], ["2026-08-14", 1_448_985], ["2026-08-17", 1_071_067], ["2026-08-18", 1_273_085],
  ["2026-08-19", 1_625_330], ["2026-08-20", 1_444_952], ["2026-08-21", 1_993_017], ["2026-08-24", 4_741_005],
  ["2026-08-25", 2_817_782], ["2026-08-26", 1_514_384], ["2026-08-27", 3_831_810], ["2026-08-28", 4_142_047],
  ["2026-08-31", 2_216_729],
]
const HAND_TOTAL = 35_036_753 // Σ of the rows above
const HAND_ADV = HAND_TOTAL / 21 // 1,668,416.8095… shares/day
const HAND_CAP = HAND_ADV * 0.025 // Tier 2: 2.5% → 41,710.42… shares/day
const HAND_CAP_UNITS = 41_710_420_238n // ⌊35,036,753 × 10^6 × 25 ÷ (21 × 1000)⌋ at 6 decimals, multiplier 1
const HAND_ADV_UNITS = 1_668_416_809_523n // ⌊35,036,753 × 10^6 ÷ 21⌋
const YAHOO_ADV = 35_027_300 / 21 // 1,667,966.67 (the fixture's Yahoo rows)

// The job runs 30 minutes before the 08:00 UTC trade-date start of Tuesday 2026-09-01 → prior month August.
const NOW = new Date("2026-09-01T07:30:00Z")

async function offline() {
  process.stdout.write("\n— offline, from the recorded August 2026 bars —\n")
  const fixture = loadFixture("fwdi-2026-08")
  expect(AUG_2026_NASDAQ.reduce((s, [, v]) => s + v, 0) === HAND_TOTAL, "hand rows sum to 35,036,753 shares")
  const lists = await loadTierLists(fixtureFetch(fixture))
  expect(!lists.ivv.ok && !lists.iwb.ok && /HTML/i.test(`${lists.ivv.ok ? "" : lists.ivv.error}`), "iShares IVV/IWB served HTML (as recorded) → lists unavailable", lists)

  const r = await computeSymbolCap({ ticker: "BWRS", now: NOW, cutoffSeconds: 28_800, decimals: 6, multiplier: 1, fetchImpl: fixtureFetch(fixture), lists })
  expect(r.volumeSymbol === "FWDI", "BWRS follows FWDI's volume (symbol map)", r.volumeSymbol)
  expect(r.tradeDate === "2026-09-01" && r.month === "2026-08", "trade date 2026-09-01 → prior calendar month 2026-08", [r.tradeDate, r.month])
  expect(r.status === "complete" && r.missing.length === 0, "both sources present → complete", [r.status, r.missing])
  const days = r.volume.days.map((d) => [d.date, d.nasdaq])
  expect(show(days) === show(AUG_2026_NASDAQ), "days used = the 21 hand rows, with their Nasdaq volumes", days)
  expect(r.volume.nasdaq?.totalShares === HAND_TOTAL && r.volume.nasdaq?.days === 21, "Nasdaq total 35,036,753 over 21 trading days", r.volume.nasdaq)
  expect(near(r.adv?.shares, HAND_ADV, 1e-9), `ADV = ${HAND_ADV.toFixed(4)} shares (hand)`, r.adv)
  expect(Math.floor(r.adv?.shares ?? 0) === 1_668_416, "ADV whole shares = 1,668,416", r.adv?.shares)
  expect(near(r.volume.yahoo?.adv, YAHOO_ADV, 1e-6) && r.volume.yahoo?.days === 21, "Yahoo cross-check ADV 1,667,966.67 over 21 days", r.volume.yahoo)
  expect(near(r.volume.crossCheck?.disagreementPct, 0.02698, 1e-4) && r.volume.crossCheck?.flagged === false, "disagreement 0.027% ≤ 1% → not flagged", r.volume.crossCheck)
  expect(r.tier.tier === 2 && r.tier.inferred && r.tier.basis === "override" && r.tier.percent === 2.5, "tier: Tier 2, 2.5%, inferred from the documented override", r.tier)
  expect(near(r.cap?.shares, HAND_CAP, 1e-6), `cap = ${HAND_CAP.toFixed(2)} shares/day (hand)`, r.cap?.shares)
  expect(r.cap?.wholeShares === 41_710, "cap whole shares = 41,710", r.cap?.wholeShares)
  expect(r.cap?.units === HAND_CAP_UNITS, "cap on-chain units = 41,710,420,238 (shares × 10^6, multiplier 1/1)", r.cap?.units)
  expect(r.cap?.advUnits === HAND_ADV_UNITS, "ADV on-chain units = 1,668,416,809,523", r.cap?.advUnits)
  expect(r.cap?.multiplier.num === 1 && r.cap?.multiplier.den === 1, "multiplier 1 → num/den 1/1", r.cap?.multiplier)
  const urls = r.volume.sources.map((s) => s.url)
  expect(urls.includes(fixture.responses.nasdaq.url) && urls.includes(fixture.responses.yahoo.url) && r.volume.sources.every((s) => !!s.fetchedAt), "provenance names both source URLs with fetch times", r.volume.sources)

  for (const missing of [["yahoo"], ["nasdaq"], ["nasdaq", "yahoo"]] as const) {
    const p = await computeSymbolCap({ ticker: "FWDI", now: NOW, cutoffSeconds: 28_800, decimals: 6, multiplier: 1, fetchImpl: fixtureFetch(fixture, { missing: [...missing] }), lists })
    const label = missing.join(" + ")
    expect(p.status === "partial" && show(p.missing) === show(missing), `${label} missing → 'partial'`, [p.status, p.missing])
    expect(p.cap === null && p.adv === null, `${label} missing → no ADV or cap number`, { adv: p.adv, cap: p.cap })
    const absent = missing.map((m) => p.volume[m])
    expect(absent.every((v) => v === null) && p.volume.days.every((d) => missing.every((m) => d[m] === null)), `${label} missing → its values are null, never filled in`, absent)
    expect(p.errors.length >= missing.length, `${label} missing → the fetch error is recorded`, p.errors)
  }
  const kept = await computeSymbolCap({ ticker: "FWDI", now: NOW, cutoffSeconds: 28_800, decimals: 6, multiplier: 1, fetchImpl: fixtureFetch(fixture, { missing: ["yahoo"] }), lists })
  expect(kept.volume.nasdaq?.totalShares === HAND_TOTAL, "a partial run still records the source that did answer", kept.volume.nasdaq)

  const skewed = await computeSymbolCap({ ticker: "FWDI", now: NOW, cutoffSeconds: 28_800, decimals: 6, multiplier: 1, fetchImpl: fixtureFetch(fixture, { yahooScale: 1.05 }), lists })
  expect(skewed.volume.crossCheck?.flagged === true && (skewed.volume.crossCheck?.disagreementPct ?? 0) > 1, "Yahoo 5% off → disagreement flagged", skewed.volume.crossCheck)
  expect(skewed.cap?.units === HAND_CAP_UNITS, "a flagged cross-check keeps Nasdaq (consolidated) as the cap basis", skewed.cap?.units)

  const csvLists = await loadTierLists(fixtureFetch(fixture, { ishares: { ivv: ishareSampleCsv(["AAPL", "MSFT"], 500), iwb: ishareSampleCsv(["AAPL", "MSFT", "BRKB"], 1000) } }))
  expect(csvLists.ivv.ok && csvLists.iwb.ok, "iShares-format holdings CSVs parse", csvLists)
  const aapl = classifyTier("AAPL", csvLists)
  expect(aapl.tier === 1 && !aapl.inferred && aapl.basis === "ishares" && aapl.percent === 0.25, "AAPL in IVV/IWB → Tier 1, 0.25%, not inferred", aapl)
  expect(classifyTier("BRK.B", csvLists).tier === 1, "BRK.B matches iShares' BRKB", classifyTier("BRK.B", csvLists))
  const fwdi = classifyTier("FWDI", csvLists)
  expect(fwdi.tier === 2 && !fwdi.inferred && fwdi.basis === "ishares", "FWDI absent from both lists → Tier 2 from the lists", fwdi)
  const unknown = await computeSymbolCap({ ticker: "ZZTEST", now: NOW, cutoffSeconds: 28_800, decimals: 6, multiplier: 1, fetchImpl: fixtureFetch(fixture), lists })
  expect(unknown.tier.tier === null && unknown.status === "partial" && unknown.missing.includes("tier") && unknown.cap === null, "no volume, no list and no override → 'partial', no cap", [unknown.tier, unknown.status, unknown.missing])
}

async function onFork() {
  process.stdout.write("\n— on this check's own Surfpool fork —\n")
  if (!existsSync(VENUE_SO)) throw new Error(`${VENUE_SO} is missing: build it with \`npm run program:build\` first (this check never runs cargo)`)
  const fork = await startOwnSurfpool({ port: 8920, wsPort: 8921 })
  process.stdout.write(`surfpool started by this check: pid ${fork.pid}, ${fork.rpcUrl} (mainnet datasource, 127.0.0.1 only)\n`)
  const provenanceDir = mkdtempSync(join(tmpdir(), "bellwether-caps-"))
  try {
    const chain = createCapsChain(fork.rpcUrl)
    const [programKey, admin, dataAuthority, stranger, bwrsMint, noDataMint, relay, issuer] = await Promise.all(Array.from({ length: 8 }, () => generateKeyPairSigner()))
    const programId = programKey.address
    await deployProgram(fork.rpcUrl, programId, readFileSync(VENUE_SO))
    for (const who of [admin, dataAuthority, stranger]) await fundSol(fork.rpcUrl, who.address, 5_000_000_000n)
    await setMintAccount(fork.rpcUrl, bwrsMint.address, 6)
    await setMintAccount(fork.rpcUrl, noDataMint.address, 6)
    const fwdiMint = address(FWDI_MINT)

    const venue = await venuePda(programId, admin.address)
    const zero = address("11111111111111111111111111111111")
    await chain.send([initVenueIx({
      programId, admin, venue, gate: 1, heartbeatMaxAge: 180n, cutoffSeconds: 28_800n, relay: relay.address, dataAuthority: dataAuthority.address,
      credentialIssuer: issuer.address, sasCredential: zero, sasSchema: zero, affiliateGroup: zero,
    })], admin)
    for (const [mint, ticker, sponsored] of [[bwrsMint.address, "BWRS", false], [fwdiMint, "FWDI", true], [noDataMint.address, "ZZTEST", false]] as const) {
      await chain.send([await registerSymbolIx({ programId, admin, venue, mint, tier: 2, sponsored, ticker })], admin)
    }
    const symbols = { BWRS: await symbolPda(programId, venue, bwrsMint.address), FWDI: await symbolPda(programId, venue, fwdiMint), ZZTEST: await symbolPda(programId, venue, noDataMint.address) }
    const before = await readSymbolRecord(chain.rpc, symbols.BWRS)
    expect(before.capUnits === 0n && before.multNum === 1 && before.multDen === 1, "freshly registered symbol: cap 0 (fails closed), multiplier 1/1", before)
    process.stdout.write(`program ${programId} deployed; venue ${venue}; BWRS, FWDI and ZZTEST registered\n`)

    const fixture = loadFixture("fwdi-2026-08")
    const base = { rpc: chain.rpc, send: chain.send, programId, venue, now: NOW, provenanceDir }

    const refused = await runCapsJob({ ...base, dataAuthority: stranger, fetchImpl: fixtureFetch(fixture) }).then(() => null, (e: Error) => e.message)
    expect(refused !== null && /data authority/i.test(refused), "a key that is not the venue's data authority is refused before any send", refused)

    const run = await runCapsJob({ ...base, dataAuthority, fetchImpl: fixtureFetch(fixture) })
    const by = Object.fromEntries(run.symbols.map((s) => [s.ticker, s]))
    expect(run.tradeDate === "2026-09-01" && run.month === "2026-08", "job targets trade date 2026-09-01 with August 2026 volume", [run.tradeDate, run.month])
    expect(show(Object.keys(by).sort()) === show(["BWRS", "FWDI", "ZZTEST"]), "job discovered every symbol registered on the venue", Object.keys(by))
    for (const t of ["BWRS", "FWDI"] as const) {
      expect(by[t]?.status === "complete" && by[t]?.onchain.action === "sent" && !!by[t]?.onchain.signature, `${t}: complete → set_cap sent`, by[t]?.onchain)
      const rec = await readSymbolRecord(chain.rpc, symbols[t])
      expect(rec.capUnits === HAND_CAP_UNITS, `${t}: SymbolRecord cap_shares = 41,710,420,238 on the fork`, rec.capUnits)
      expect(rec.advUnits === HAND_ADV_UNITS && rec.multNum === 1 && rec.multDen === 1, `${t}: adv_shares 1,668,416,809,523, multiplier 1/1`, rec)
    }
    expect(by.FWDI?.mint?.decimals === 6 && by.FWDI?.mint?.multiplier === 1 && by.FWDI?.mint?.scaledUi === true, "FWDI decimals and ScaledUiAmount multiplier read from the real mint", by.FWDI?.mint)
    expect(by.ZZTEST?.status === "partial" && by.ZZTEST?.onchain.action === "withheld" && by.ZZTEST?.cap === null, "ZZTEST: sources missing → partial, withheld", by.ZZTEST)
    const z = await readSymbolRecord(chain.rpc, symbols.ZZTEST)
    expect(z.capUnits === 0n, "ZZTEST: no number written, cap stays 0 (fails closed)", z.capUnits)

    const saved = provenanceRunSchema.parse(JSON.parse(readFileSync(join(provenanceDir, "latest-run.json"), "utf8")))
    const savedBwrs = saved.symbols.find((s) => s.ticker === "BWRS")
    expect(savedBwrs?.cap?.units === HAND_CAP_UNITS.toString() && savedBwrs?.volume.days.length === 21 && savedBwrs.volume.sources.length === 2, "provenance JSON stored: sources, fetch times, 21 days, values", savedBwrs)
    expect(savedBwrs?.onchain.signature === by.BWRS?.onchain.signature, "provenance records the set_cap signature", savedBwrs?.onchain)
    const current = symbolProvenanceSchema.parse(JSON.parse(readFileSync(join(provenanceDir, "symbols", "BWRS.json"), "utf8")))
    expect(current.status === "complete" && current.cap?.units === HAND_CAP_UNITS.toString(), "symbols/BWRS.json describes the value now on chain", current.status)

    const again = await runCapsJob({ ...base, dataAuthority, fetchImpl: fixtureFetch(fixture) })
    expect(again.symbols.filter((s) => s.ticker !== "ZZTEST").every((s) => s.onchain.action === "unchanged" && s.onchain.signature === null), "re-run with the same data → unchanged, no transaction", again.symbols.map((s) => s.onchain))

    const rpcWithoutScan = new Proxy(chain.rpc, { get(target, key, receiver) {
      if (key === "getProgramAccounts") return () => { throw new Error("program scan unavailable") }
      return Reflect.get(target, key, receiver)
    } })
    const known = await runCapsJob({ ...base, rpc: rpcWithoutScan, symbolAccounts: [symbols.BWRS],
      dataAuthority, fetchImpl: fixtureFetch(fixture) })
    expect(known.symbols.length === 1 && known.symbols[0]?.ticker === "BWRS" && known.symbols[0].onchain.action === "unchanged",
      "known fork symbol works without a program scan", known.symbols.map((s) => [s.ticker, s.onchain.action]))

    const partial = await runCapsJob({ ...base, dataAuthority, fetchImpl: fixtureFetch(fixture, { missing: ["yahoo"] }) })
    const pb = partial.symbols.find((s) => s.ticker === "BWRS")
    expect(pb?.status === "partial" && show(pb?.missing) === show(["yahoo"]) && pb?.cap === null, "Yahoo missing on the fork → BWRS 'partial', no cap number", pb && { status: pb.status, missing: pb.missing, cap: pb.cap })
    expect(pb?.onchain.action === "withheld" && pb?.onchain.signature === null, "partial run sends no set_cap", pb?.onchain)
    const still = await readSymbolRecord(chain.rpc, symbols.BWRS)
    expect(still.capUnits === HAND_CAP_UNITS, "on-chain cap still the verified 41,710,420,238 after the partial run", still.capUnits)
    const afterPartial = symbolProvenanceSchema.parse(JSON.parse(readFileSync(join(provenanceDir, "symbols", "BWRS.json"), "utf8")))
    expect(afterPartial.status === "complete", "symbols/BWRS.json still names the complete run behind the on-chain value", afterPartial.status)
  } finally {
    rmSync(provenanceDir, { recursive: true, force: true })
    await fork.stop()
    process.stdout.write(`surfpool pid ${fork.pid} stopped\n`)
  }
}

async function main() {
  await offline()
  await onFork()
  process.stdout.write(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}\n`)
  for (const f of failures) process.stdout.write(`  - ${f}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`caps-data check could not complete: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})

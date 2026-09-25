/**
 * Offline unit tests for the caps job's pure parts:
 *   npx tsx --test services/caps/caps.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { generateKeyPairSigner } from "@solana/kit"
import { ishareSampleCsv } from "./fixture-fetch.js"
import { parseIsharesHoldings } from "./tier.js"
import { advUnits, capUnits, multiplierRational, targetTradeDate } from "./units.js"
import { setCapIx } from "./venue.js"

const CUTOFF = 8 * 3600 // 08:00 UTC = 04:00 ET in summer
const LEAD = 4 * 3600

test("target trade date: a run shortly before the cutoff prepares that day; weekends fold into Friday", () => {
  assert.equal(targetTradeDate(new Date("2026-09-01T07:30:00Z"), CUTOFF, LEAD), "2026-09-01") // Tue, before the start
  assert.equal(targetTradeDate(new Date("2026-08-31T23:00:00Z"), CUTOFF, LEAD), "2026-08-31") // Mon evening: still Monday's
  assert.equal(targetTradeDate(new Date("2026-08-01T07:30:00Z"), CUTOFF, LEAD), "2026-07-31") // Sat → Friday, keeps June's volume
  assert.equal(targetTradeDate(new Date("2026-08-02T07:30:00Z"), CUTOFF, LEAD), "2026-07-31") // Sun → Friday
  assert.equal(targetTradeDate(new Date("2026-08-03T07:30:00Z"), CUTOFF, LEAD), "2026-08-03") // Mon → July's volume
})

test("units are exact and round down", () => {
  assert.equal(capUnits(35_036_753n, 21n, 6, 2), 41_710_420_238n)
  assert.equal(capUnits(35_036_753n, 21n, 6, 1), 4_171_042_023n) // Tier 1 = a tenth of Tier 2, floored
  assert.equal(advUnits(35_036_753n, 21n, 6), 1_668_416_809_523n)
  assert.equal(capUnits(1n, 3n, 0, 2), 0n)
  assert.throws(() => capUnits(1n, 0n, 6, 2))
})

test("share multiplier → exact u32 fraction", () => {
  assert.deepEqual(multiplierRational(1), { num: 1, den: 1 })
  assert.deepEqual(multiplierRational(1.5), { num: 3, den: 2 })
  assert.deepEqual(multiplierRational(0.1), { num: 1, den: 10 })
  assert.deepEqual(multiplierRational(2), { num: 2, den: 1 })
  assert.throws(() => multiplierRational(0))
  assert.throws(() => multiplierRational(Number.NaN))
})

test("iShares holdings: equities only, HTML and short files refused", () => {
  const parsed = parseIsharesHoldings(ishareSampleCsv(["AAPL", "BRK.B"], 500), 400)
  assert.equal(parsed.asOf, "Sep 24, 2026")
  assert.ok(parsed.tickers.has("AAPL") && parsed.tickers.has("BRKB"))
  assert.ok(!parsed.tickers.has("XTSLA"), "money-market line is not an equity")
  assert.equal(parsed.tickers.size, 500)
  assert.throws(() => parseIsharesHoldings("<!DOCTYPE html><html></html>", 1), /HTML/)
  assert.throws(() => parseIsharesHoldings(ishareSampleCsv(["AAPL"], 10), 400), /expected at least 400/)
})

test("set_cap payload matches the program: disc 16 | cap u64 | adv u64 | num u32 | den u32, accounts [authority s, venue, symbol w]", async () => {
  const [authority, venue, symbol, program] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()))
  const ix = setCapIx({ programId: program.address, authority, venue: venue.address, symbol: symbol.address, capUnits: 41_710_420_238n, advUnits: 1_668_416_809_523n, num: 3, den: 2 })
  const d = new DataView(ix.data!.buffer)
  assert.equal(ix.data!.length, 25)
  assert.deepEqual([d.getUint8(0), d.getBigUint64(1, true), d.getBigUint64(9, true), d.getUint32(17, true), d.getUint32(21, true)], [16, 41_710_420_238n, 1_668_416_809_523n, 3, 2])
  assert.deepEqual(ix.accounts!.map((a) => [a.address, a.role]), [[authority.address, 2], [venue.address, 0], [symbol.address, 1]])
})

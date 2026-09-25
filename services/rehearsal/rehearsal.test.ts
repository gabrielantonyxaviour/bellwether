/**
 * Offline tests for the rehearsal report's parsers and date logic:
 *   npx tsx --test services/rehearsal/rehearsal.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { classifyTransaction } from "./activity.js"
import { FWDI_MINT, TOKEN_2022_PROGRAM, priorMonth } from "./constants.js"
import { parseCsvLine, parseHaltRss, parseNyseHaltCsv } from "./halt-sources.js"
import { etDate, etToUtc } from "./time.js"

test("NYSE halt CSV: quoted names, duplicate rows collapse to the resumed one, Eastern → UTC across DST", () => {
  const halts = parseNyseHaltCsv([
    "Halt Date,Halt Time,Symbol,Name,Exchange,Reason,Resume Date,NYSE Resume Time",
    '2025-09-12,19:50:00,CLSD,"""Clearside Biomedical, Inc. Common Stock""",Nasdaq,News pending,,',
    '2025-09-12,19:50:00,CLSD,"""Clearside Biomedical, Inc. Common Stock""",Nasdaq,News pending,2025-09-15,09:05:00',
    "2025-12-01,09:31:55,FORD,Forward Industries Inc-N Y,Nasdaq,LULD pause,2025-12-01,09:36:55",
  ].join("\n"))
  assert.equal(halts.length, 2)
  const clsd = halts.find((h) => h.symbol === "CLSD")!
  assert.equal(clsd.haltAt, "2025-09-12T23:50:00.000Z")
  assert.equal(clsd.resumedAt, "2025-09-15T13:05:00.000Z")
  assert.equal(halts.find((h) => h.symbol === "FORD")!.haltAt, "2025-12-01T14:31:55.000Z")
  assert.deepEqual(parseCsvLine('a,"b, ""c""",d'), ["a", 'b, "c"', "d"])
  assert.throws(() => parseNyseHaltCsv("<html></html>"))
})

test("Nasdaq Trader RSS: FWDI/FORD items only; a bot challenge is an error, never 'no halts'", () => {
  const rss = `<rss version="2.0"><channel>
    <item><ndaq:IssueSymbol>FORD</ndaq:IssueSymbol><ndaq:Mkt>Q</ndaq:Mkt><ndaq:ReasonCode>LUDP</ndaq:ReasonCode><ndaq:HaltDate>09/12/2025</ndaq:HaltDate><ndaq:HaltTime>09:31:55.123</ndaq:HaltTime><ndaq:ResumptionDate>09/12/2025</ndaq:ResumptionDate><ndaq:ResumptionTradeTime>09:36:55</ndaq:ResumptionTradeTime></item>
    <item><ndaq:IssueSymbol>AAPL</ndaq:IssueSymbol><ndaq:HaltDate>09/12/2025</ndaq:HaltDate><ndaq:HaltTime>10:00:00</ndaq:HaltTime></item>
  </channel></rss>`
  const parsed = parseHaltRss(rss)
  assert.equal(parsed.items, 2)
  assert.deepEqual(parsed.halts.map((h) => [h.symbol, h.reason, h.haltAt, h.resumedAt]), [["FORD", "LUDP", "2025-09-12T13:31:55.000Z", "2025-09-12T13:36:55.000Z"]])
  assert.throws(() => parseHaltRss('<html><script src="/_Incapsula_Resource?x"></script></html>'), /challenge/)
})

test("prior calendar month and Eastern dates", () => {
  const sep = priorMonth(new Date("2026-09-25T08:00:00Z"))
  assert.deepEqual([sep.key, sep.from, sep.to, sep.period1, sep.period2], ["2026-08", "2026-08-01", "2026-08-31", 1785542400, 1788220800])
  const jan = priorMonth(new Date("2027-01-15T00:00:00Z"))
  assert.deepEqual([jan.key, jan.from, jan.to], ["2026-12", "2026-12-01", "2026-12-31"])
  assert.equal(etDate(new Date("2026-01-01T03:00:00Z")), "2025-12-31")
  assert.equal(etToUtc("2026-03-08", "12:00:00").toISOString(), "2026-03-08T16:00:00.000Z")
})

test("activity classification uses program ids and the transaction's own FWDI token balances", () => {
  const holder = "E8ACgVAuqp21aK8LWkPX7TZkZAqMahkUZNutxTzjC4Fj"
  const issuer = "8DNjBM1amxs9YdoiryCMsaFYKDkbywdD1TSpsin1ifM"
  const tx = {
    slot: 1, blockTime: 1,
    meta: { err: null, preTokenBalances: [{ accountIndex: 1, mint: FWDI_MINT }, { accountIndex: 2, mint: FWDI_MINT }] },
    transaction: { message: {
      accountKeys: [{ pubkey: "2CVeWbwqLsndG3CcuRe84KbCj4oyg27BTizGQkzaAAkp" }, { pubkey: holder }, { pubkey: issuer }],
      instructions: [
        { programId: TOKEN_2022_PROGRAM, parsed: { type: "transfer", info: { source: holder, destination: issuer } } },
        { programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: "Detokenize FWDI superstate " },
      ],
    } },
  }
  assert.deepEqual(classifyTransaction(tx, new Set()).categories, ["redemption", "transfer"])
  const failedLend = { ...tx, meta: { err: { InstructionError: [0, "Custom"] } }, transaction: { message: { accountKeys: [], instructions: [{ programId: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD" }] } } }
  assert.deepEqual(classifyTransaction(failedLend, new Set()).categories, ["failed", "lending"])
})

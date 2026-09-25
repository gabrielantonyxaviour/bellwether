/**
 * Offline tests for the public-notice builder and issuer-notice tracker:
 *   npx tsx --test services/notice/notice.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { addBusinessDays, addCalendarDays, isBusinessDay, quarterEnd } from "./calendar.js"
import { loadVenueConfig } from "./config.js"
import { buildNoticeDraft, compareDrafts } from "./draft.js"
import { trackIssuerNotice } from "./issuer.js"
import { NOTICE_ITEMS } from "./items.js"
import { decodeProgramAccount, decodeProgramData, decodeSymbol, decodeVenue } from "./layout.js"
import { renderNoticeMarkdown } from "./markdown.js"
import { NoticeDraftSchema, type ChainFacts } from "./schema.js"

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const A = (n: number) => "2".repeat(31) + B58[n] // distinct valid base58 strings
const KEY = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i) % 256)

test("template: the order's 30 items a–dd in order, with the order's own titles and one source tag each", () => {
  assert.equal(NOTICE_ITEMS.length, 30)
  const letters = NOTICE_ITEMS.map((i) => i.letter)
  assert.deepEqual(letters, [..."abcdefghijklmnopqrstuvwxyz", "aa", "bb", "cc", "dd"])
  const title = (l: string) => NOTICE_ITEMS.find((i) => i.letter === l)!.title
  assert.equal(title("c"), "Overview of the Tokenized Securities Venue")
  assert.equal(title("g"), "Securities, Non-Security Crypto Assets, and Tokenized Money Market Funds Traded")
  assert.equal(title("n"), "Distributed Ledger Technology")
  assert.equal(title("w"), "Procedures to Protect TSV Participant Information")
  assert.equal(title("dd"), "Exclusive or Predominant Venue for Trading of a Tokenized NMS Stock")
  for (const item of NOTICE_ITEMS) {
    assert.ok(["chain", "config", "operator-input"].includes(item.source), item.letter)
    assert.ok(item.requirement.length > 60, `${item.letter} carries the order's requirement text`)
  }
})

test("calendar: business days skip weekends and federal holidays (observed); quarter ends", () => {
  assert.equal(addBusinessDays("2026-09-25", 1), "2026-09-28") // Friday → Monday
  assert.equal(addBusinessDays("2026-10-09", 1), "2026-10-13") // Columbus Day Monday
  assert.equal(addBusinessDays("2026-11-20", 5), "2026-11-30") // Thanksgiving
  assert.equal(addBusinessDays("2026-09-10", 5), "2026-09-17")
  assert.equal(isBusinessDay("2026-07-03"), false) // July 4 on a Saturday, observed Friday
  assert.equal(isBusinessDay("2027-07-05"), false) // July 4 on a Sunday, observed Monday
  assert.equal(isBusinessDay("2027-06-18"), false) // Juneteenth on a Saturday, observed Friday
  assert.equal(isBusinessDay("2026-09-28"), true)
  assert.equal(addCalendarDays("2026-09-25", 30), "2026-10-25")
  assert.equal(addCalendarDays("2026-11-15", -20), "2026-10-26")
  assert.equal(quarterEnd("2026-09-25"), "2026-09-30")
  assert.equal(quarterEnd("2026-10-01"), "2026-12-31")
})

test("layout: VenueConfig, SymbolRecord and loader ProgramData decode at the contract offsets", () => {
  const venue = new Uint8Array(248)
  venue[0] = 1; venue[2] = 3
  const dv = new DataView(venue.buffer)
  dv.setUint16(4, 1, true); dv.setUint16(6, 2, true)
  dv.setBigInt64(8, 180n, true); dv.setBigInt64(16, 72_000n, true)
  for (let k = 0; k < 7; k++) venue.set(KEY(k + 1), 24 + k * 32)
  const v = decodeVenue(venue)
  assert.equal(v.gate.sas, true); assert.equal(v.gate.membership, true)
  assert.equal(v.tier1Count, 1); assert.equal(v.tier2Count, 2)
  assert.equal(v.heartbeatMaxAgeS, 180); assert.equal(v.tradeDateCutoffS, 72_000); assert.equal(v.tradeDateCutoffUtc, "20:00 UTC")
  assert.notEqual(v.admin, v.relay)
  assert.throws(() => decodeVenue(new Uint8Array(10)))

  const symbol = new Uint8Array(168)
  symbol[0] = 2; symbol[2] = 2; symbol[3] = 1; symbol[4] = 1; symbol[6] = 0
  symbol.set(new TextEncoder().encode("FWDI"), 8)
  new DataView(symbol.buffer).setBigInt64(152, 1_790_000_000n, true)
  const s = decodeSymbol(symbol)
  assert.equal(s.ticker, "FWDI"); assert.equal(s.tier, 2); assert.equal(s.issuerSponsored, true); assert.equal(s.active, true)
  assert.equal(s.noticeReceivedAt, 1_790_000_000)

  const program = new Uint8Array(36); program[0] = 2; program.set(KEY(9), 4)
  assert.equal(decodeProgramAccount(program).programData.length > 30, true)
  const pd = new Uint8Array(45 + 8); pd[0] = 3
  new DataView(pd.buffer).setBigUint64(4, 450_000_000n, true); pd[12] = 1; pd.set(KEY(5), 13)
  const d = decodeProgramData(pd)
  assert.equal(d.deploySlot, 450_000_000); assert.ok(d.upgradeAuthority); assert.equal(d.programLength, 8)
  pd[12] = 0
  assert.equal(decodeProgramData(pd).upgradeAuthority, null)
})

test("issuer tracker: 30-day window, objection, sponsored exception, and the chain mirror", () => {
  const record = {
    symbol: "TSLAx", mint: A(1), issuer: "Tesla, Inc.", issuerSponsored: false,
    address: "1 Tesla Road, Austin, Texas 78725", addressSource: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001318605&type=10-K",
    sentAt: "2026-08-28T15:00:00Z", receivedAt: "2026-09-01T15:00:00Z", objection: null,
  }
  const open = trackIssuerNotice(record, null, new Date("2026-09-20T15:00:00Z"))
  assert.equal(open.status, "window-open"); assert.equal(open.canActivate, false)
  assert.equal(open.deadline, "2026-10-01T15:00:00.000Z"); assert.equal(open.daysRemaining, 11)
  assert.deepEqual(open.expectedActivation, { ok: false, error: "NoticeWindowOpen", code: 6008 })

  const due = trackIssuerNotice(record, null, new Date("2026-10-01T15:00:00Z"))
  assert.equal(due.status, "eligible"); assert.equal(due.canActivate, true)

  const objected = trackIssuerNotice({ ...record, objection: { receivedAt: "2026-09-10T14:00:00Z" } }, null, new Date("2026-11-01T00:00:00Z"))
  assert.equal(objected.status, "objected"); assert.equal(objected.objection?.timely, true)
  assert.deepEqual(objected.expectedActivation, { ok: false, error: "Objected", code: 6009 })
  const amend = objected.reminders.find((r) => r.kind === "objection")!
  assert.equal(amend.due, "2026-09-17"); assert.match(amend.rule, /5 business days/)

  const sponsored = trackIssuerNotice({ ...record, symbol: "FWDI", issuerSponsored: true, sentAt: null, receivedAt: null }, null, new Date())
  assert.equal(sponsored.status, "not-required"); assert.equal(sponsored.canActivate, true); assert.equal(sponsored.noticeRequired, false)
  assert.equal(open.noticeRequired, true)

  // Chain mirror: the program has no receipt on file, so activation would fail whatever the record says.
  const chain = { address: A(2), issuerSponsored: false, noticeReceivedAt: 0, objected: false, active: false }
  const unsynced = trackIssuerNotice(record, chain, new Date("2026-10-05T00:00:00Z"))
  assert.equal(unsynced.canActivate, false)
  assert.deepEqual(unsynced.expectedActivation, { ok: false, error: "NoticeWindowOpen", code: 6008 })
  assert.ok(unsynced.mismatches.some((m) => /record_issuer_notice/.test(m)))
  assert.match(unsynced.nextAction ?? "", /record_issuer_notice/)

  const synced = trackIssuerNotice(record, { ...chain, noticeReceivedAt: Date.parse(record.receivedAt) / 1000 }, new Date("2026-10-05T00:00:00Z"))
  assert.equal(synced.canActivate, true); assert.equal(synced.mismatches.length, 0); assert.match(synced.nextAction ?? "", /activate_pool/)
  const active = trackIssuerNotice(record, { ...chain, noticeReceivedAt: Date.parse(record.receivedAt) / 1000, active: true }, new Date("2026-10-05T00:00:00Z"))
  assert.equal(active.status, "active")
})

function fakeChain(): ChainFacts {
  const src = { rpcUrl: "http://127.0.0.1:8950", slot: 1, fetchedAt: "2026-09-25T10:00:00.000Z" }
  return {
    ...src,
    program: { id: A(3), loader: "BPFLoaderUpgradeab1e11111111111111111111111", upgradeable: true, programData: A(4), upgradeAuthority: A(5), deploySlot: 1, programLength: 31_128 },
    venue: {
      address: A(6), admin: A(7), relay: A(8), dataAuthority: A(9), credentialIssuer: A(10), sasCredential: A(11), sasSchema: A(12), affiliateGroup: A(13),
      gate: { sas: true, membership: false }, tier1Count: 0, tier2Count: 1, heartbeatMaxAgeS: 180, tradeDateCutoffS: 72_000, tradeDateCutoffUtc: "20:00 UTC",
    },
    symbols: [{
      address: A(14), ticker: "FWDI", mint: "7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9", tier: 2, issuerSponsored: true, active: true, halted: false, haltReason: "",
      objected: false, breachCount: 0, advShares: "0", capShares: "41710000000", pausedUntil: 0, lastHeartbeat: 0, noticeReceivedAt: 0,
      pool: { address: A(15), feeBps: 30, stockVault: A(16), usdcVault: A(17), stockMint: "7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9", usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", stockDecimals: 6, usdcDecimals: 6, reserveStock: "0", reserveUsdc: "0", lpTotal: "0" },
      token: {
        address: "7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9", name: "Forward Industries, Inc.", symbol: "FWDI", tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", decimals: 6,
        mintAuthority: A(18), freezeAuthority: A(19), permanentDelegate: A(19), defaultAccountState: "frozen", metadataPointerAuthority: A(18), metadataUpdateAuthority: A(18),
        scaledUiAuthority: A(18), transferHook: null, pausable: null, extensions: ["defaultAccountState", "permanentDelegate"], readVia: "services/rehearsal readFwdiMint", slot: 1,
      },
    }],
    errors: [],
  }
}

test("draft: chain and config items filled, the rest flagged operator input; completeness, dates and Markdown", () => {
  const config = loadVenueConfig()
  const draft = buildNoticeDraft({ chain: fakeChain(), config, publishedOn: "2026-09-25", now: new Date("2026-09-25T12:00:00Z"), issuerNotices: [] })
  NoticeDraftSchema.parse(draft)
  assert.equal(draft.items.length, 30)
  for (const item of draft.items) {
    if (item.source === "operator-input") {
      assert.equal(item.status, "operator-input", item.letter); assert.equal(item.text, null); assert.ok(item.operatorPrompt)
    } else {
      assert.equal(item.status, "filled", `${item.letter}: ${item.unresolved.join(", ")}`); assert.ok(item.text && item.text.length > 40)
    }
  }
  const n = draft.items.find((i) => i.letter === "n")!
  const fact = (key: string) => n.facts.find((f) => f.key === key)?.value
  assert.equal(fact("program.upgradeAuthority"), A(5)); assert.equal(fact("venue.relay"), A(8)); assert.equal(fact("mint.FWDI.freezeAuthority"), A(19))
  assert.equal(draft.completeness.total, 30)
  assert.equal(draft.completeness.filled + draft.completeness.operatorInput + draft.completeness.unresolved, 30)
  assert.equal(draft.completeness.label, `${draft.completeness.filled}/30`)
  assert.equal(draft.schedule.earliestOperatingDate, "2026-10-25"); assert.equal(draft.schedule.secEmailDue, "2026-09-28")
  assert.ok(draft.schedule.reminders.some((r) => r.kind === "quarterly" && r.due === "2026-10-30"))
  const md = renderNoticeMarkdown(draft)
  assert.match(md, /\(n\) Distributed Ledger Technology/); assert.match(md, new RegExp(`${draft.completeness.filled}/30`)); assert.match(md, /Operator input needed/)

  // A chain fact that cannot be resolved is never silently filled.
  const broken = fakeChain(); broken.program = null; broken.errors = ["program: account not found"]
  const partial = buildNoticeDraft({ chain: broken, config, now: new Date("2026-09-25T12:00:00Z"), issuerNotices: [] })
  assert.equal(partial.items.find((i) => i.letter === "n")!.status, "unresolved")

  // Changing a governance key or a fee is a candidate material change (20 days' notice).
  const changed = fakeChain(); changed.symbols[0].pool!.feeBps = 50; changed.program!.upgradeAuthority = A(20)
  const diff = compareDrafts(draft, buildNoticeDraft({ chain: changed, config, now: new Date("2026-09-25T12:00:00Z"), issuerNotices: [] }))
  assert.deepEqual(diff.map((d) => d.key).sort(), ["pool.FWDI.feeBps", "program.upgradeAuthority"])
  assert.ok(diff.every((d) => d.category === "material-change"))
})

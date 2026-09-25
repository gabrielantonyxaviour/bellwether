/**
 * Issuer-notice tracker (ORDER §II.D, fn 63–64). A third-party-tokenized stock may be made available
 * only once 30 calendar days have passed since the issuer received the Issuer Notice, and never after
 * a timely Notice of Issuer Objection; an issuer-sponsored token needs no notice. The venue program
 * enforces the same rule in activate_pool (errors NoticeWindowOpen 6008, Objected 6009), so the
 * tracker mirrors the on-chain SymbolRecord and names every disagreement with the operator's record.
 */
import { addBusinessDays, easternDate } from "./calendar.js"
import {
  IssuerNoticeRecordSchema, type IssuerNoticeRecord, type IssuerNoticeStatus, type OnChainSymbol, type Reminder,
} from "./schema.js"

/** Same constant as programs/venue/src/rules/notices.rs NOTICE_WINDOW. */
export const NOTICE_WINDOW_S = 30 * 86_400
export const ACTIVATION_ERRORS = { NoticeWindowOpen: 6008, Objected: 6009 } as const
const CITE = "ORDER §II.D, fn 63–64"

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
const secondsOf = (value: string) => Math.floor(Date.parse(value) / 1000)

/** activate_pool's own rule, on the fields the program reads. */
export function chainActivation(state: { issuerSponsored: boolean; objected: boolean; noticeReceivedAt: number }, nowS: number): IssuerNoticeStatus["expectedActivation"] {
  if (state.issuerSponsored) return { ok: true, error: null, code: null }
  if (state.objected) return { ok: false, error: "Objected", code: ACTIVATION_ERRORS.Objected }
  if (state.noticeReceivedAt === 0 || nowS < state.noticeReceivedAt + NOTICE_WINDOW_S) {
    return { ok: false, error: "NoticeWindowOpen", code: ACTIVATION_ERRORS.NoticeWindowOpen }
  }
  return { ok: true, error: null, code: null }
}

export function trackIssuerNotice(input: IssuerNoticeRecord, onChain: OnChainSymbol | null, now: Date): IssuerNoticeStatus {
  const record = IssuerNoticeRecordSchema.parse(input)
  const nowS = Math.floor(now.getTime() / 1000)
  const mismatches: string[] = []
  const reminders: Reminder[] = []
  const sponsored = onChain?.issuerSponsored ?? record.issuerSponsored
  if (onChain && onChain.issuerSponsored !== record.issuerSponsored) {
    mismatches.push(`the on-chain symbol is registered as ${onChain.issuerSponsored ? "issuer-sponsored" : "third-party"} but the record says ${record.issuerSponsored ? "issuer-sponsored" : "third-party"}`)
  }

  const recordReceivedS = record.receivedAt ? secondsOf(record.receivedAt) : 0
  const chainReceivedS = onChain?.noticeReceivedAt ?? 0
  const receivedS = recordReceivedS || chainReceivedS
  const deadlineS = receivedS ? receivedS + NOTICE_WINDOW_S : 0
  const objection = record.objection
    ? { receivedAt: new Date(record.objection.receivedAt).toISOString(), timely: deadlineS > 0 && secondsOf(record.objection.receivedAt) <= deadlineS }
    : null
  const objected = objection !== null || (onChain?.objected ?? false)

  let nextAction: string | null = null
  if (!sponsored && onChain) {
    if (recordReceivedS && chainReceivedS === 0) {
      mismatches.push("the issuer's receipt is on record but not on-chain: send record_issuer_notice")
      nextAction = `send record_issuer_notice(received_at=${recordReceivedS})`
    } else if (recordReceivedS && chainReceivedS !== recordReceivedS) {
      mismatches.push(`receipt time differs: record ${iso(recordReceivedS)}, on-chain ${iso(chainReceivedS)} (the program records it once)`)
    } else if (!recordReceivedS && chainReceivedS) {
      mismatches.push("an on-chain receipt time exists with no receipt on record")
    }
    if (objection && !onChain.objected) {
      mismatches.push("an objection is on record but not on-chain: send record_objection")
      nextAction = "send record_objection"
    } else if (!objection && onChain.objected) {
      mismatches.push("the symbol is objected on-chain with no objection on record")
    }
  }

  const expectedActivation = onChain
    ? chainActivation(onChain, nowS)
    : chainActivation({ issuerSponsored: sponsored, objected, noticeReceivedAt: receivedS }, nowS)

  let status: IssuerNoticeStatus["status"]
  let blockedReason: string | null = null
  if (sponsored) {
    status = onChain?.active ? "active" : "not-required"
  } else if (objected) {
    status = "objected"
    const on = objection?.receivedAt ?? null
    blockedReason = `The issuer objected${on ? ` on ${easternDate(on)}` : ""}: the stock cannot be made available for trading (${CITE}).`
    if (on) {
      reminders.push({
        kind: "objection", due: addBusinessDays(easternDate(on), 5), subject: record.symbol, cite: "ORDER §II.D, §II.C",
        rule: "Amend the public Notice within 5 business days to disclose the Notice of Issuer Objection (item j), then email the SEC within 1 business day of publishing.",
      })
    }
  } else if (!receivedS) {
    status = record.sentAt ? "awaiting-receipt" : "not-sent"
    blockedReason = record.sentAt
      ? "Issuer Notice sent; the 30-day window starts only when proof of receipt arrives."
      : "No Issuer Notice sent: send it to the principal executive office address on the cover page of the issuer's Exchange Act reports."
    nextAction ??= record.sentAt ? "record proof of receipt" : "send the Issuer Notice"
  } else if (nowS < deadlineS) {
    status = "window-open"
    blockedReason = `The issuer's objection window is open until ${iso(deadlineS)}.`
  } else {
    status = onChain?.active ? "active" : "eligible"
  }

  const canActivate = !(status === "objected" || status === "not-sent" || status === "awaiting-receipt" || status === "window-open") && expectedActivation.ok
  if (canActivate && status === "eligible") nextAction ??= "send activate_pool"
  if (!canActivate && !blockedReason && !expectedActivation.ok) {
    blockedReason = `activate_pool would fail with ${expectedActivation.error} (${expectedActivation.code}) until the on-chain record matches.`
  }

  return {
    symbol: record.symbol, mint: record.mint, issuer: record.issuer, issuerSponsored: sponsored, noticeRequired: !sponsored,
    address: record.address, addressSource: record.addressSource,
    sentAt: record.sentAt ? new Date(record.sentAt).toISOString() : null,
    receivedAt: receivedS ? iso(receivedS) : null,
    deadline: deadlineS ? iso(deadlineS) : null,
    daysRemaining: deadlineS && nowS < deadlineS ? Math.ceil((deadlineS - nowS) / 86_400) : deadlineS ? 0 : null,
    objection, status, canActivate, blockedReason, expectedActivation, onChain, mismatches, nextAction, reminders,
  }
}

/** Track every listed symbol: records by mint, joined with the on-chain SymbolRecords. */
export function trackIssuerNotices(
  records: IssuerNoticeRecord[],
  symbols: { mint: string; ticker: string; address: string; issuerSponsored: boolean; noticeReceivedAt: number; objected: boolean; active: boolean }[],
  listings: { symbol: string; mint: string; issuer: string; issuerSponsored: boolean }[],
  now: Date,
): IssuerNoticeStatus[] {
  const byMint = new Map(records.map((r) => [r.mint, r]))
  const out: IssuerNoticeStatus[] = []
  const seen = new Set<string>()
  for (const s of symbols) {
    const listing = listings.find((l) => l.mint === s.mint)
    const record = byMint.get(s.mint) ?? {
      symbol: listing?.symbol ?? s.ticker, mint: s.mint, issuer: listing?.issuer ?? "unknown issuer", issuerSponsored: listing?.issuerSponsored ?? s.issuerSponsored,
    }
    out.push(trackIssuerNotice(record, { address: s.address, issuerSponsored: s.issuerSponsored, noticeReceivedAt: s.noticeReceivedAt, objected: s.objected, active: s.active }, now))
    seen.add(s.mint)
  }
  for (const r of records) if (!seen.has(r.mint)) out.push(trackIssuerNotice(r, null, now))
  return out
}

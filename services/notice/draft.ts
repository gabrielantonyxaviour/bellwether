/**
 * buildNoticeDraft(): the 30-item public Notice with every chain- and config-answerable item filled,
 * operator-input items flagged, a completeness count, and the order's clocks: publication → earliest
 * operating date (+30 calendar days), the SEC email (1 business day), and revision deadlines
 * (5 business days for listing changes, volume pauses and objections; 20 calendar days before a
 * material change; 30 days after quarter-end for non-material changes; 5 business days after
 * discovering an inaccuracy). compareDrafts() turns a change in chain facts into those reminders.
 */
import { addBusinessDays, addCalendarDays, easternDate, quarterEnd } from "./calendar.js"
import type { VenueConfigFile } from "./config.js"
import type { FillContext, Filled } from "./facts.js"
import { fillAccess, fillFees, fillObjections, fillOverview, fillPools, fillSecurities, fillTechnology } from "./fill-chain.js"
import {
  OPERATOR_PROMPTS, fillAffiliateTrading, fillDisclaimer, fillDisplay, fillEntry, fillHours, fillMarketData, fillOffchain,
  fillParticipants, fillStoppage, fillTreatment, fillUseOfExemption,
} from "./fill-config.js"
import { trackIssuerNotices } from "./issuer.js"
import { NOTICE_ITEMS, ORDER_CITE } from "./items.js"
import {
  NoticeDraftSchema, RevisionEventSchema, type ChainFacts, type IssuerNoticeRecord, type NoticeDraft, type NoticeItem,
  type Reminder, type RevisionEvent,
} from "./schema.js"

export const SEC_MAILBOX = "tradingandmarkets@sec.gov"
const BREACH_PAUSE_S = 92 * 86_400

const FILLERS: Record<string, (ctx: FillContext) => Filled> = {
  a: fillDisclaimer, b: fillUseOfExemption, c: fillOverview, e: fillParticipants, f: fillAccess, g: fillSecurities,
  j: fillObjections, l: fillAffiliateTrading, m: fillTreatment, n: fillTechnology, o: fillEntry, p: fillPools,
  q: fillOffchain, r: fillHours, s: fillMarketData, t: fillDisplay, u: fillFees, cc: fillStoppage,
}

export interface BuildDraftInput {
  chain: ChainFacts
  config: VenueConfigFile
  /** Operator's Issuer Notice records (receipt, objection), joined to the on-chain SymbolRecords. */
  issuerNotices?: IssuerNoticeRecord[]
  /** Date the Notice was (or will be) published, YYYY-MM-DD Eastern, or an ISO instant. */
  publishedOn?: string | null
  /** Revision log: listing changes, pauses, objections, material changes, inaccuracies. */
  revisions?: RevisionEvent[]
  now?: Date
}

const REVISION_RULES: Record<RevisionEvent["category"], { kind: Reminder["kind"]; rule: string; cite: string }> = {
  "listing-change": { kind: "listing-change", rule: "Publish a revised Notice within 5 business days of commencing or ceasing to make a Tokenized NMS Stock available.", cite: "ORDER §II.C" },
  "volume-pause": { kind: "volume-pause", rule: "Publish a revised Notice within 5 business days of pausing trading for the volume thresholds.", cite: "ORDER §II.C, §II.F" },
  "volume-resume": { kind: "volume-pause", rule: "Publish a revised Notice within 5 business days of resuming trading after a volume-threshold pause.", cite: "ORDER §II.C, §II.F" },
  objection: { kind: "objection", rule: "Publish a revised Notice within 5 business days of receiving a timely Notice of Issuer Objection.", cite: "ORDER §II.C, §II.D" },
  "material-change": { kind: "material-change", rule: "Publish a revised Notice at least 20 calendar days before the material change takes effect.", cite: "ORDER §II.C" },
  "non-material": { kind: "quarterly", rule: "Publish non-material changes no later than 30 calendar days after the end of the quarter.", cite: "ORDER §II.C" },
  inaccuracy: { kind: "inaccuracy", rule: "Publish a correction within 5 business days of discovering materially inaccurate or incomplete information.", cite: "ORDER §II.C" },
}
const SEC_AFTER = " Then email the SEC within 1 business day of publishing, and keep every version on the website."

function revisionDue(event: ReturnType<typeof RevisionEventSchema.parse>): string {
  switch (event.category) {
    case "material-change": return addCalendarDays(event.effectiveOn ?? event.occurredOn, -20)
    case "non-material": return addCalendarDays(quarterEnd(event.occurredOn), 30)
    default: return addBusinessDays(event.occurredOn, 5)
  }
}

function buildItems(ctx: FillContext): NoticeItem[] {
  return NOTICE_ITEMS.map((template) => {
    const base = { letter: template.letter, title: template.title, requirement: template.requirement, source: template.source }
    if (template.source === "operator-input") {
      const { prompt, facts } = OPERATOR_PROMPTS[template.letter](ctx)
      return { ...base, status: "operator-input", text: null, facts, operatorPrompt: prompt, addenda: [], unresolved: [] }
    }
    const filler = FILLERS[template.letter]
    if (!filler) throw new Error(`no filler for item (${template.letter})`)
    const out = filler(ctx)
    const status = out.unresolved.length > 0 || out.text === null ? "unresolved" : "filled"
    return { ...base, status, text: status === "filled" ? out.text : null, facts: out.facts, operatorPrompt: null, addenda: out.addenda, unresolved: out.unresolved }
  })
}

export function buildNoticeDraft(input: BuildDraftInput): NoticeDraft {
  const now = input.now ?? new Date()
  const nowS = Math.floor(now.getTime() / 1000)
  const { chain, config } = input
  const issuerNotices = trackIssuerNotices(input.issuerNotices ?? [], chain.symbols, config.listings, now)
  const items = buildItems({ chain, config, issuers: issuerNotices, now })

  const publishedOn = input.publishedOn ? easternDate(input.publishedOn) : null
  const reminders: Reminder[] = []
  const earliestOperatingDate = publishedOn ? addCalendarDays(publishedOn, 30) : null
  const secEmailDue = publishedOn ? addBusinessDays(publishedOn, 1) : null
  if (publishedOn && earliestOperatingDate && secEmailDue) {
    reminders.push(
      { kind: "sec-email", due: secEmailDue, subject: null, cite: "ORDER §II.C", rule: `Email ${SEC_MAILBOX} within 1 business day of publishing: intent to operate under the TSV Exemption, contact email and phone, and the Notice URL.` },
      { kind: "operating-date", due: earliestOperatingDate, subject: null, cite: "ORDER §II.C", rule: "Operate no earlier than 30 calendar days after the Notice is published." },
    )
  }
  const base = publishedOn ?? easternDate(now)
  const qe = quarterEnd(base)
  reminders.push({ kind: "quarterly", due: addCalendarDays(qe, 30), subject: null, cite: "ORDER §II.C", rule: `Publish non-material changes made in the quarter ending ${qe} no later than 30 calendar days after it.${SEC_AFTER}` })

  const revisions = (input.revisions ?? []).map((r) => RevisionEventSchema.parse(r))
  for (const event of revisions) {
    const rule = REVISION_RULES[event.category]
    reminders.push({ kind: rule.kind, due: revisionDue(event), subject: event.description, cite: rule.cite, rule: rule.rule + SEC_AFTER })
  }
  for (const s of chain.symbols.filter((x) => x.pausedUntil > nowS)) {
    const since = easternDate(new Date((s.pausedUntil - BREACH_PAUSE_S) * 1000))
    if (!revisions.some((r) => r.category === "volume-pause" && r.description.includes(s.ticker))) {
      reminders.push({ kind: "volume-pause", due: addBusinessDays(since, 5), subject: s.ticker, cite: "ORDER §II.C, §II.F", rule: REVISION_RULES["volume-pause"].rule + SEC_AFTER })
    }
  }
  for (const status of issuerNotices) reminders.push(...status.reminders)
  reminders.sort((a, b) => a.due.localeCompare(b.due))

  const filled = items.filter((i) => i.status === "filled").length
  const operatorInput = items.filter((i) => i.status === "operator-input").length
  const mustInclude = [
    { what: "Statement that the TSV intends to operate pursuant to the TSV Exemption", value: config.venue.name },
    { what: "Contact email", value: config.venue.contactEmail },
    { what: "Contact phone", value: config.venue.contactPhone },
    { what: "Location of the Notice (URL)", value: config.venue.noticeUrl },
  ]
  return NoticeDraftSchema.parse({
    schemaVersion: 1, generatedAt: now.toISOString(), venueName: config.venue.name, orderCite: ORDER_CITE,
    completeness: {
      filled, operatorInput, unresolved: items.length - filled - operatorInput, total: 30,
      withAddenda: items.filter((i) => i.status === "filled" && i.addenda.length > 0).length, label: `${filled}/30`,
    },
    items,
    schedule: {
      publishedOn, earliestOperatingDate, secEmailDue,
      secEmail: { to: SEC_MAILBOX, mustInclude, missing: mustInclude.filter((m) => m.value === null).map((m) => m.what) },
      reminders,
    },
    issuerNotices, revisions, chain,
  })
}

export interface FactChange {
  key: string; label: string; before: NoticeItem["facts"][number]["value"]; after: NoticeItem["facts"][number]["value"]
  category: RevisionEvent["category"]; rule: string
}

function categoryOf(key: string): RevisionEvent["category"] {
  if (/^symbol\.[^.]+\.objected$/.test(key)) return "objection"
  if (/^symbol\.[^.]+\.pausedUntil$/.test(key)) return "volume-pause"
  if (/^symbol\.[^.]+\.capShares$/.test(key)) return "non-material" // routine monthly budget update by the data authority
  if (/^symbol\./.test(key) || /^pool\.[^.]+\.(address|stockVault|usdcVault|usdcMint)$/.test(key)) return "listing-change"
  if (/^mint\./.test(key) || /^listing\./.test(key)) return "inaccuracy"
  return "material-change" // program, venue keys and parameters, fees, config statements
}

/** Facts that changed between two drafts, each with the revision category it most likely triggers. */
export function compareDrafts(previous: NoticeDraft, current: NoticeDraft): FactChange[] {
  const index = (d: NoticeDraft) => {
    const map = new Map<string, NoticeItem["facts"][number]>()
    for (const item of d.items) for (const fact of item.facts) map.set(fact.key, fact)
    return map
  }
  const before = index(previous)
  const after = index(current)
  const changes: FactChange[] = []
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(key)?.value ?? null
    const a = after.get(key)?.value ?? null
    if (b === a) continue
    const category = categoryOf(key)
    changes.push({ key, label: (after.get(key) ?? before.get(key))!.label, before: b, after: a, category, rule: REVISION_RULES[category].rule })
  }
  return changes.sort((x, y) => x.key.localeCompare(y.key))
}

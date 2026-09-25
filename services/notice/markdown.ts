/** The draft as a plain-English Markdown document, in the order's item sequence, with every gap flagged. */
import type { NoticeDraft } from "./schema.js"

const SOURCE_LABEL = { chain: "read from chain", config: "venue config", "operator-input": "operator input" } as const

export function renderNoticeMarkdown(draft: NoticeDraft): string {
  const c = draft.completeness
  const s = draft.schedule
  const out: string[] = [
    `# ${draft.venueName}: Public Notice under the TSV Exemption (draft)`,
    `Draft generated ${draft.generatedAt} from ${draft.chain.rpcUrl} at slot ${draft.chain.slot}. Items follow ${draft.orderCite}.`,
    `**Completeness: ${c.label}** items filled (${c.operatorInput} need operator input${c.unresolved ? `, ${c.unresolved} could not be resolved` : ""}${c.withAddenda ? `; ${c.withAddenda} filled items have operator addenda` : ""}).`,
  ]
  if (s.publishedOn) {
    out.push(`Published ${s.publishedOn} → earliest operating date **${s.earliestOperatingDate}**; SEC email to ${s.secEmail.to} due **${s.secEmailDue}**.`)
  } else {
    out.push(`Not yet published. Operating may begin 30 calendar days after publication; email ${s.secEmail.to} within 1 business day of publishing.`)
  }
  if (s.secEmail.missing.length) out.push(`SEC email is missing: ${s.secEmail.missing.join("; ")}.`)
  if (draft.chain.errors.length) out.push(`Chain read problems: ${draft.chain.errors.join("; ")}.`)

  for (const item of draft.items) {
    out.push(`## (${item.letter}) ${item.title}`, `_Source: ${SOURCE_LABEL[item.source]}_`)
    if (item.status === "filled" && item.text) {
      out.push(item.text)
      for (const addendum of item.addenda) out.push(`> **Operator addendum needed:** ${addendum}`)
    } else if (item.status === "operator-input") {
      out.push(`> **Operator input needed.** ${item.operatorPrompt ?? ""}`)
      if (item.facts.length) out.push(item.facts.map((f) => `- ${f.label}: ${f.value === null ? "none" : `\`${String(f.value)}\``} (${f.source})`).join("\n"))
    } else {
      out.push(`> **Unresolved:** could not read ${item.unresolved.join(", ")}. This item stays empty until the value is read.`)
    }
  }

  if (draft.issuerNotices.length) {
    out.push("## Issuer notices (tracker, not part of the published Notice)")
    out.push(draft.issuerNotices.map((n) => {
      const clock = n.deadline ? `; window ends ${n.deadline}` : ""
      const blocked = n.blockedReason ? ` ${n.blockedReason}` : ""
      const kind = n.noticeRequired ? "third-party token" : "issuer-sponsored, no Issuer Notice required"
      return `- ${n.symbol} (${n.issuer}; ${kind}): ${n.status}${clock}.${blocked}${n.nextAction ? ` Next: ${n.nextAction}.` : ""}`
    }).join("\n"))
  }
  if (s.reminders.length) {
    out.push("## Deadlines")
    out.push(s.reminders.map((r) => `- ${r.due} · ${r.kind}${r.subject ? ` (${r.subject})` : ""}: ${r.rule}`).join("\n"))
  }
  return out.join("\n\n") + "\n"
}

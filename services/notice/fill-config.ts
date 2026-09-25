/** Items answered by the venue config (a, b, e, l, m, o, q, r, s, t, cc) and prompts for operator-input items. */
import { bullets, chainFact, code, configFact, sharesOf, type FillContext, type Filled } from "./facts.js"
import type { Fact } from "./schema.js"

const filled = (text: string, facts: Fact[], addenda: string[] = []): Filled => ({ text, facts, addenda, unresolved: [] })

export function fillDisclaimer(ctx: FillContext): Filled {
  const n = ctx.config.venue.name
  return filled([
    `(i) ${n} is not registered with the Securities and Exchange Commission in any capacity for the activities performed under the TSV Exemption, and the Commission has not passed upon the merits or accuracy of the disclosures in this Notice.`,
    `(ii) ${n} is not subject to the fair access requirements applicable to registered national securities exchanges and to ATSs subject to Rule 301(b)(5) of Regulation ATS, and unfair and unreasonably discriminatory denials or limitations of access of TSV Participants by ${n} are not subject to SEC review.`,
    `(iii) ${n} is not subject to Regulation NMS.`,
  ].join("\n\n"), [configFact("config.venue.name", "Venue name", n)])
}

export function fillUseOfExemption(ctx: FillContext): Filled {
  const n = ctx.config.venue.name
  return filled(`${n}'s use of the TSV Exemption is subject to Commission oversight. Operating a TSV in a manner inconsistent with the TSV Exemption could result in a Commission enforcement action.`,
    [configFact("config.venue.name", "Venue name", n)])
}

export function fillParticipants(ctx: FillContext): Filled {
  const p = ctx.config.participants
  return filled(["Eligible TSV Participants:", bullets(p.eligible), p.brokerDealerAccess].join("\n\n"),
    [configFact("config.participants.eligible", "Eligible participants", p.eligible.join("; ")), configFact("config.participants.brokerDealerAccess", "Access through a broker-dealer", p.brokerDealerAccess)])
}

export function fillAffiliateTrading(ctx: FillContext): Filled {
  const a = ctx.config.affiliates
  return filled(a.statement, [configFact("config.affiliates.tradingByTsvOrAffiliates", "TSV or affiliates trade on the venue", a.tradingByTsvOrAffiliates)])
}

export function fillTreatment(ctx: FillContext): Filled {
  return filled(ctx.config.treatment, [configFact("config.treatment", "Differences in treatment", "none")])
}

export function fillEntry(ctx: FillContext): Filled {
  const e = ctx.config.entry
  const { venue, symbols } = ctx.chain
  const facts: Fact[] = [configFact("config.entry.sizeLimits", "Size limits", e.sizeLimits)]
  const limits: string[] = []
  if (venue) {
    facts.push(chainFact("venue.tradeDateCutoff", "Trade date starts", venue.tradeDateCutoffUtc, `VenueConfig ${venue.address} · cutoff @16`))
    for (const s of symbols) {
      facts.push(chainFact(`symbol.${s.ticker}.capShares`, `${s.ticker} daily share budget (raw)`, s.capShares, `SymbolRecord ${s.address} · cap_shares @96`))
      limits.push(s.capShares === "0"
        ? `${s.ticker}: no budget set yet; a zero budget refuses every swap.`
        : `${s.ticker}: ${sharesOf(s.capShares, s.token?.decimals)} per trade date.`)
    }
  }
  const text = [
    e.procedure, e.checks, e.confirmation, e.sizeLimits,
    venue ? `Daily trade limits (each symbol's share budget, read on-chain; a trade date starts at ${venue.tradeDateCutoffUtc}):` : "",
    limits.length ? bullets(limits) : "",
    e.messages,
  ].filter(Boolean).join("\n\n")
  return filled(text, facts)
}

export function fillOffchain(ctx: FillContext): Filled {
  return filled(ctx.config.offchain, [configFact("config.offchain", "Off-chain functionality", "halt relay, caps job, credential issuer, tape indexer")])
}

export function fillHours(ctx: FillContext): Filled {
  const h = ctx.config.hours
  const facts: Fact[] = [configFact("config.hours.twentyFourSeven", "Trading 24/7", h.twentyFourSeven)]
  const venue = ctx.chain.venue
  let extra = ""
  if (venue) {
    facts.push(chainFact("venue.heartbeatMaxAgeS", "Halt-data heartbeat limit (s)", venue.heartbeatMaxAgeS, `VenueConfig ${venue.address} · heartbeat_max_age @8`))
    extra = `Trading in a symbol also stops whenever its halt data is more than ${venue.heartbeatMaxAgeS} seconds old.`
  }
  return filled([h.statement, extra].filter(Boolean).join(" "), facts)
}

export function fillMarketData(ctx: FillContext): Filled {
  const c = ctx.config
  const facts: Fact[] = c.marketData.map((m, i) => configFact(`config.marketData.${i}`, m.provider, m.source))
  const venue = ctx.chain.venue
  const keys = venue
    ? `Halt data is written on-chain only by the relay authority ${code(venue.relay)}; share budgets only by the data authority ${code(venue.dataAuthority)}.`
    : ""
  if (venue) facts.push(chainFact("venue.relay", "Relay authority", venue.relay, `VenueConfig ${venue.address} · relay @56`),
    chainFact("venue.dataAuthority", "Data authority", venue.dataAuthority, `VenueConfig ${venue.address} · data authority @88`))
  const text = [bullets(c.marketData.map((m) => `${m.provider}, ${m.source}: ${m.use}`)), c.oracles, keys].filter(Boolean).join("\n\n")
  return filled(text, facts)
}

export function fillDisplay(ctx: FillContext): Filled {
  return filled(ctx.config.display, [configFact("config.display", "Trading interest displayed", "none (no order book); trades on the public tape")])
}

export function fillStoppage(ctx: FillContext): Filled {
  const s = ctx.config.stoppage
  const venue = ctx.chain.venue
  const nowS = Math.floor(ctx.now.getTime() / 1000)
  const facts: Fact[] = [configFact("config.stoppage.circumstances", "Stoppage circumstances", s.circumstances)]
  const live: string[] = []
  if (venue) {
    facts.push(chainFact("venue.heartbeatMaxAgeS", "Halt-data heartbeat limit (s)", venue.heartbeatMaxAgeS, `VenueConfig ${venue.address} · heartbeat_max_age @8`))
    live.push(`Halt data counts as stale after ${venue.heartbeatMaxAgeS} seconds without a relay heartbeat.`)
    const halted = ctx.chain.symbols.filter((x) => x.halted).map((x) => `${x.ticker} (${x.haltReason || "halt"})`)
    const paused = ctx.chain.symbols.filter((x) => x.pausedUntil > nowS).map((x) => x.ticker)
    live.push(halted.length ? `Currently halted: ${halted.join(", ")}.` : "No symbol is currently halted.")
    if (paused.length) live.push(`Currently paused after a volume-threshold breach: ${paused.join(", ")}.`)
  }
  const text = [s.circumstances, s.controls, s.resumption, live.join(" ")].filter(Boolean).join("\n\n")
  const addenda = s.corporateActions ? [] : ["Describe procedures for price volatility or corporate actions that occur while the underlying stock's market is closed."]
  return filled(s.corporateActions ? `${text}\n\n${s.corporateActions}` : text, facts, addenda)
}

/** Operator-input items: empty text, a prompt, and chain/config facts that help write the answer. */
export const OPERATOR_PROMPTS: Record<string, (ctx: FillContext) => { prompt: string; facts: Fact[] }> = {
  d: () => ({ prompt: "State whether the operator, or any person in the group that comprises the TSV, is registered with the SEC in any capacity (e.g. broker-dealer, investment adviser, transfer agent) and summarize those activities, or state that none is.", facts: [] }),
  h: (ctx) => ({
    prompt: "For each listed stock, say who tokenized it (issuer-sponsored or a third party unaffiliated with the issuer) and how, and describe how the TSV evaluates the token's legal status, technical soundness and operational integrity, and that of Solana. The token facts below are read from chain.",
    facts: ctx.chain.symbols.flatMap((s) => {
      const listing = ctx.config.listings.find((l) => l.mint === s.mint)
      return [
        chainFact(`symbol.${s.ticker}.issuerSponsored`, `${s.ticker} issuer-sponsored`, s.issuerSponsored, `SymbolRecord ${s.address} · issuer_sponsored @3`),
        ...(listing ? [configFact(`listing.${s.ticker}.tokenizer`, `${s.ticker} tokenizer`, listing.tokenizer)] : []),
        ...(s.token ? [chainFact(`mint.${s.ticker}.freezeAuthority`, `${s.ticker} freeze authority`, s.token.freezeAuthority, `mint ${s.mint}`)] : []),
      ]
    }),
  }),
  i: () => ({ prompt: "Describe the audits, certifications or attestations relied on to verify that each token gives holders the same rights and privileges as the underlying stock (ORDER §II.E).", facts: [] }),
  k: (ctx) => ({
    prompt: "State whether the TSV or an affiliate issued or tokenized any listed token (for example a rehearsal asset minted by the venue), identify it, and describe any difference in treatment.",
    facts: ctx.config.listings.map((l) => configFact(`listing.${l.symbol}.tokenizer`, `${l.symbol} tokenizer`, l.tokenizer)),
  }),
  v: () => ({ prompt: "Describe how participants file complaints and how execution errors and disputes are resolved, or state that there are no such procedures.", facts: [] }),
  w: () => ({ prompt: "Describe the safeguards for participant information and wallets, whether confidential information or PII is shared and with whom, and the TSV's MEV policies, or state that there are none.", facts: [] }),
  x: () => ({ prompt: "Describe code review, audits, pre-trade risk assessment, post-deployment monitoring, authorization controls, stress tests, business continuity and disaster recovery testing and incident response, naming who performs each, or state that there are none.", facts: [] }),
  y: () => ({ prompt: "Describe clearance and settlement arrangements and any requirements they place on participants. Program fact: a swap transfers both legs between the trader's own token accounts and the pool vaults in the same Solana transaction.", facts: [] }),
  z: () => ({ prompt: "List the known material risks (the order's examples include loss of private keys, smart contract bugs, access control failures, MEV, oracle manipulation and phishing), how each is mitigated, and any loss compensation.", facts: [] }),
  aa: (ctx) => ({
    prompt: "Identify every entity other than the TSV that supports it and describe its role (permissioning, cyber risk, trade monitoring, display, recordkeeping, clearance and settlement). Third parties named in the venue config are listed below.",
    facts: [
      ...ctx.config.technology.interfaces.filter((i) => i.providedBy !== "the TSV").map((i, n) => configFact(`config.thirdParty.${n}`, i.name, i.role)),
      ...ctx.config.marketData.map((m, n) => configFact(`config.marketData.${n}`, m.provider, m.use)),
    ],
  }),
  bb: () => ({ prompt: "Describe any monitoring for spoofing, wash trading, front running, pump-and-dump schemes, illegal trading and other abuse, or state that the TSV performs none.", facts: [] }),
  dd: () => ({ prompt: "State whether the TSV may be the exclusive or predominant venue for any listed token, the risks that creates for participants, and any procedures such as burning or detokenizing the token.", facts: [] }),
}

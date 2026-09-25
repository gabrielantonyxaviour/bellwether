/** Items answered by live chain reads: c, f, g, j, n, p, u. */
import { easternDate } from "./calendar.js"
import {
  bullets, chainFact, code, configFact, pct, symbolState, tokenFacts, tokenPowers, type FillContext, type Filled,
} from "./facts.js"
import type { Fact } from "./schema.js"

const missing = (keys: string[]): Filled => ({ text: null, facts: [], addenda: [], unresolved: keys })

function governanceFacts(ctx: FillContext): Fact[] {
  const { program, venue } = ctx.chain
  if (!program || !venue) return []
  const pdEv = `ProgramData ${program.programData ?? "(none)"} (BPF upgradeable loader)`
  const vEv = (field: string, offset: number) => `VenueConfig ${venue.address} · ${field} @${offset}`
  return [
    chainFact("program.id", "Venue program", program.id, `program account (loader ${program.loader})`),
    chainFact("program.programData", "ProgramData account", program.programData, `program account ${program.id}`),
    chainFact("program.upgradeAuthority", "Upgrade authority", program.upgradeAuthority, pdEv),
    chainFact("venue.address", "VenueConfig account", venue.address, `PDA ["venue", admin] of ${program.id}`),
    chainFact("venue.admin", "Venue admin", venue.admin, vEv("admin", 24)),
    chainFact("venue.relay", "Relay authority", venue.relay, vEv("relay", 56)),
    chainFact("venue.dataAuthority", "Data authority", venue.dataAuthority, vEv("data authority", 88)),
    chainFact("venue.credentialIssuer", "Credential issuer", venue.credentialIssuer, vEv("credential issuer", 120)),
    chainFact("venue.affiliateGroup", "Affiliate group", venue.affiliateGroup, vEv("affiliate group", 216)),
  ]
}

export function fillOverview(ctx: FillContext): Filled {
  const { program, venue } = ctx.chain
  if (!program || !venue) return missing([...(program ? [] : ["program.upgradeAuthority"]), ...(venue ? [] : ["venue.admin"])])
  const { config } = ctx
  const upgrade = program.upgradeAuthority
    ? `Upgrade authority ${code(program.upgradeAuthority)} (recorded in ProgramData ${code(program.programData)}): can replace the program's code, transfer this authority, make the program immutable, or close it.`
    : "The program is immutable: it has no upgrade authority."
  const affiliated = config.affiliates.affiliatedTsvs.length ? config.affiliates.affiliatedTsvs.join(", ") : "none"
  const text = [
    config.structure,
    `On-chain governance: there is no governance token and no on-chain voting. The venue program ${code(program.id)} is controlled by these keys:`,
    bullets([
      upgrade,
      `Venue admin ${code(venue.admin)}: sets venue parameters and keys, registers symbols, creates pools, records Issuer Notice receipts and objections, and activates pools.`,
      `Relay authority ${code(venue.relay)}: records halts, resumptions and heartbeats.`,
      `Data authority ${code(venue.dataAuthority)}: sets each symbol's daily share budget and records volume-threshold breaches.`,
      `Credential issuer ${code(venue.credentialIssuer)}: grants and revokes participant credentials.`,
    ]),
    `Affiliated TSVs: ${affiliated}. Symbol caps are counted across the affiliate group ${code(venue.affiliateGroup)}.`,
    config.lpGovernance,
  ].join("\n\n")
  const addenda = config.venue.legalEntity ? [] : ["Name the legal entity that operates the TSV, its ownership, and its off-chain governance (officers or board, and who approves use of each key)."]
  const facts = [...governanceFacts(ctx), configFact("config.affiliatedTsvs", "Affiliated TSVs", affiliated), configFact("config.lpGovernance", "LP token governance rights", config.lpGovernance)]
  return { text, facts, addenda, unresolved: [] }
}

export function fillAccess(ctx: FillContext): Filled {
  const { venue } = ctx.chain
  if (!venue) return missing(["venue.credentialIssuer"])
  const a = ctx.config.access
  const gates = [venue.gate.sas && "a Solana Attestation Service attestation", venue.gate.membership && "a venue membership record"].filter(Boolean).join(" or ")
  const ev = (field: string, offset: number) => `VenueConfig ${venue.address} · ${field} @${offset}`
  const text = [
    a.criteria,
    `On-chain, the venue program admits a wallet holding ${gates || "no credential type (gate disabled)"} from credential issuer ${code(venue.credentialIssuer)}` +
      (venue.gate.sas ? ` under SAS credential ${code(venue.sasCredential)} and schema ${code(venue.sasSchema)}.` : "."),
    a.procedure, a.sanctions, a.denial,
  ].join("\n\n")
  const facts = [
    chainFact("venue.gate", "Credential types accepted", gates, ev("gate flags", 2)),
    chainFact("venue.credentialIssuer", "Credential issuer", venue.credentialIssuer, ev("credential issuer", 120)),
    chainFact("venue.sasCredential", "SAS credential", venue.sasCredential, ev("SAS credential", 152)),
    chainFact("venue.sasSchema", "SAS schema", venue.sasSchema, ev("SAS schema", 184)),
    configFact("config.access.sanctions", "Sanctions screening", a.sanctions),
  ]
  const addenda = a.identityVerification ? [] : ["Describe any procedures to verify a person's identity; the admission flow configured today screens wallet addresses only."]
  return { text, facts, addenda, unresolved: [] }
}

export function fillSecurities(ctx: FillContext): Filled {
  const { venue, symbols } = ctx.chain
  if (!venue) return missing(["venue.address"])
  const nowS = Math.floor(ctx.now.getTime() / 1000)
  const q = ctx.config.quoteAsset
  const facts: Fact[] = []
  const lines = symbols.map((s) => {
    const ev = `SymbolRecord ${s.address}`
    facts.push(
      chainFact(`symbol.${s.ticker}.mint`, `${s.ticker} mint`, s.mint, ev),
      chainFact(`symbol.${s.ticker}.tier`, `${s.ticker} tier`, s.tier, ev),
      chainFact(`symbol.${s.ticker}.active`, `${s.ticker} available`, s.active, ev),
      chainFact(`symbol.${s.ticker}.pausedUntil`, `${s.ticker} volume pause until`, s.pausedUntil > nowS ? new Date(s.pausedUntil * 1000).toISOString() : null, ev),
    )
    if (s.pool) facts.push(chainFact(`pool.${s.ticker}.usdcMint`, `${s.ticker} paired asset mint`, s.pool.usdcMint, `Pool ${s.pool.address}`))
    const name = s.token?.name ? ` (${s.token.name})` : ""
    const pair = s.pool ? `, paired with ${q.symbol} ${code(s.pool.usdcMint)}` : ", no pool yet"
    return `${s.ticker}${name}: mint ${code(s.mint)}, Tier ${s.tier}, ${s.issuerSponsored ? "issuer-sponsored" : "third-party"} tokenization${pair}; ${symbolState(s, nowS)}.`
  })
  const paused = symbols.filter((s) => s.pausedUntil > nowS)
  const text = [
    symbols.length ? "Tokenized NMS Stock registered on the venue:" : "No Tokenized NMS Stock is registered on the venue yet.",
    symbols.length ? bullets(lines) : "",
    `Paired asset: ${q.name} (${q.symbol}), a ${q.kind}. ${q.usdValuation} No tokenized money market fund is traded.`,
    paused.length
      ? `Volume-threshold pauses: ${paused.map((s) => `${s.ticker} until ${new Date(s.pausedUntil * 1000).toISOString().slice(0, 10)}`).join("; ")}.`
      : "No symbol is paused in connection with the volume thresholds.",
  ].filter(Boolean).join("\n\n")
  facts.push(configFact("config.quoteAsset", "Paired asset", q.symbol))
  return { text, facts, addenda: [], unresolved: [] }
}

export function fillObjections(ctx: FillContext): Filled {
  const { venue, symbols } = ctx.chain
  if (!venue) return missing(["venue.address"])
  const facts = symbols.filter((s) => !s.issuerSponsored).map((s) =>
    chainFact(`symbol.${s.ticker}.objected`, `${s.ticker} issuer objection on file`, s.objected, `SymbolRecord ${s.address} · objected @6`))
  const objected = symbols.filter((s) => s.objected).map((s) => {
    const tracked = ctx.issuers.find((i) => i.mint === s.mint)
    const when = tracked?.objection ? ` on ${easternDate(tracked.objection.receivedAt)}${tracked.objection.timely ? "" : " (after the 30-day window)"}` : ""
    return `${tracked?.issuer ?? "The issuer"} (underlying ${s.ticker}) provided a Notice of Issuer Objection${when}; ${s.ticker} is not made available for trading.`
  })
  const text = objected.length ? bullets(objected) : "No issuer has provided a Notice of Issuer Objection."
  return { text, facts, addenda: [], unresolved: [] }
}

export function fillTechnology(ctx: FillContext): Filled {
  const { program, venue, symbols } = ctx.chain
  if (!program || !venue) return missing([...(program ? [] : ["program.upgradeAuthority"]), ...(venue ? [] : ["venue.admin"])])
  const tech = ctx.config.technology
  const facts: Fact[] = [...governanceFacts(ctx),
    chainFact("venue.sasCredential", "SAS credential", venue.sasCredential, `VenueConfig ${venue.address} · SAS credential @152`),
    chainFact("venue.sasSchema", "SAS schema", venue.sasSchema, `VenueConfig ${venue.address} · SAS schema @184`)]
  const accounts: string[] = [
    `Venue program ${code(program.id)} (${program.upgradeable ? "upgradeable, BPF upgradeable loader" : "not upgradeable"}; ProgramData ${code(program.programData)}).`,
    `Venue configuration ${code(venue.address)}.`,
  ]
  for (const s of symbols) {
    facts.push(chainFact(`symbol.${s.ticker}.address`, `${s.ticker} SymbolRecord`, s.address, `PDA ["symbol", venue, mint]`))
    if (s.pool) {
      const ev = `Pool ${s.pool.address}`
      facts.push(
        chainFact(`pool.${s.ticker}.address`, `${s.ticker} pool`, s.pool.address, `PDA ["pool", symbol]`),
        chainFact(`pool.${s.ticker}.stockVault`, `${s.ticker} stock vault`, s.pool.stockVault, `${ev} · stock vault @104`),
        chainFact(`pool.${s.ticker}.usdcVault`, `${s.ticker} USDC vault`, s.pool.usdcVault, `${ev} · USDC vault @136`),
      )
      accounts.push(`${s.ticker}: symbol record ${code(s.address)}, pool ${code(s.pool.address)}, stock vault ${code(s.pool.stockVault)}, USDC vault ${code(s.pool.usdcVault)}.`)
    } else {
      accounts.push(`${s.ticker}: symbol record ${code(s.address)}; no pool yet.`)
    }
    facts.push(...tokenFacts(s))
  }
  const hb = venue.heartbeatMaxAgeS
  const powers = [
    program.upgradeAuthority
      ? `Upgrade or cease: the upgrade authority ${code(program.upgradeAuthority)}, acting alone, through the BPF upgradeable loader's Upgrade, SetAuthority and Close instructions.`
      : "Upgrade or cease: nobody; the program is immutable.",
    `Modify: the venue admin ${code(venue.admin)}, alone (update_venue for keys, heartbeat limit and trade-date cutoff; register_symbol; init_pool; record_issuer_notice; record_objection; activate_pool). The data authority ${code(venue.dataAuthority)} sets daily share budgets (set_cap).`,
    `Suspend: the relay authority ${code(venue.relay)} halts a symbol (set_halt), and trading stops automatically if its heartbeat is older than ${hb} seconds; the data authority pauses a symbol for 92 days by recording a second volume breach (record_breach); the venue admin deactivates a symbol by recording an issuer objection.`,
    "Override: apart from an upgrade, no key can execute, reverse or alter a participant's trade or move pool assets: the program moves pool assets only in participant-signed swaps and liquidity withdrawals.",
  ]
  const text = [
    `Ledger: ${tech.ledger}`,
    "Smart contract addresses:", bullets(accounts),
    "Protocols and applications:", bullets(tech.interfaces.map((i) => `${i.name}: ${i.role}; provided by ${i.providedBy}.`)),
    `${tech.aggregators} ${tech.interoperability} ${tech.directAccess}`,
    "Who can upgrade, modify, suspend, override or cease the venue program:", bullets(powers),
    "Token-level powers held by each token's issuer or tokenizer, outside the venue's control:",
    bullets(symbols.flatMap(tokenPowers)),
  ].join("\n\n")
  return { text, facts, addenda: ["Name the entity (or the role of the person) that holds each key above."], unresolved: [] }
}

export function fillPools(ctx: FillContext): Filled {
  const { venue, symbols } = ctx.chain
  if (!venue) return missing(["venue.admin"])
  const pools = symbols.filter((s) => s.pool)
  const facts: Fact[] = pools.map((s) => chainFact(`pool.${s.ticker}.feeBps`, `${s.ticker} pool fee`, s.pool!.feeBps, `Pool ${s.pool!.address} · fee_bps @4`))
  const text = [
    `Pools are created only by the venue admin ${code(venue.admin)} (init_pool), one per symbol at the program address derived from the symbol, with vaults owned by the pool and no delegate or close authority. Credentialed liquidity providers fund a pool with add_liquidity and withdraw with remove_liquidity; their positions are internal and non-transferable.`,
    "Pricing is constant product (x * y = k) on the vaults' live balances. The fee is taken from the input, fee = ceil(input × fee_bps / 10,000), and output = net input × output reserve / (input reserve + net input). There is no priority, ranking or order type: each swap executes in full against the reserves when the network processes its transaction, or fails. Bellwether offers no pool customization.",
    pools.length ? bullets(pools.map((s) => `${s.ticker}/USDC pool ${code(s.pool!.address)}: fee ${pct(s.pool!.feeBps)}.`)) : "No pool has been created yet.",
  ].join("\n\n")
  return { text, facts, addenda: [], unresolved: [] }
}

export function fillFees(ctx: FillContext): Filled {
  const { venue, symbols } = ctx.chain
  if (!venue) return missing(["venue.address"])
  const pools = symbols.filter((s) => s.pool)
  const facts: Fact[] = pools.map((s) => chainFact(`pool.${s.ticker}.feeBps`, `${s.ticker} swap fee`, s.pool!.feeBps, `Pool ${s.pool!.address} · fee_bps @4`))
  const schedule = pools.length
    ? bullets(pools.map((s) => `${s.ticker}/USDC: ${pct(s.pool!.feeBps)} of each swap's input, fee = ceil(input × ${s.pool!.feeBps} / 10,000).`))
    : "No pool exists yet; each pool's fee is fixed when the pool is created."
  return { text: [ctx.config.fees, schedule].join("\n\n"), facts: [...facts, configFact("config.fees", "Fee policy", ctx.config.fees)], addenda: [], unresolved: [] }
}

/**
 * Accept check for blk_notice_builder:
 *   npx tsx checks/notice.ts
 *
 * Starts its own Surfpool mainnet fork on 127.0.0.1:8950 (ws 8951), deploys the prebuilt
 * programs/venue/target/deploy/bellwether_venue.so through the BPF upgradeable loader with a known
 * upgrade authority, inits a venue with throwaway keys, lists the real FWDI mint (issuer-sponsored,
 * with a pool) and two real third-party xStock mints (TSLAx, NVDAx), then proves:
 *   - the issuer tracker predicts every activate_pool outcome: NoticeWindowOpen (6008) on day 0 and
 *     day 29, success after day 30, Objected (6009) after an objection (surfnet_timeTravel, in ms);
 *   - the draft's technology and governance items equal the loader's ProgramData upgrade authority
 *     and the VenueConfig keys, and each mint's authorities equal a direct mainnet RPC read;
 *   - every other item is filled from config or flagged operator input; publication dates are right.
 * Never sends a mainnet transaction. Stops the fork it started by pid. Exits non-zero on any failure.
 * `--out <dir>` also writes the draft as notice-draft.json and notice-draft.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { generateKeyPairSigner, getAddressDecoder, address, type Address } from "@solana/kit"
import { createChain, errorText } from "../scripts/assets/tx.js"
import { createRpcClient } from "../services/rehearsal/rpc.js"
import { readAccount } from "../services/notice/chain.js"
import { addBusinessDays, easternDate } from "../services/notice/calendar.js"
import { buildNoticeDraft, loadVenueConfig, renderNoticeMarkdown, resolveChainFacts, trackIssuerNotice, NoticeDraftSchema,
  activatePoolInstruction, recordIssuerNoticeInstruction, recordObjectionInstruction, type IssuerNoticeRecord, type NoticeDraft } from "../services/notice/index.js"
import { decodeSymbol } from "../services/notice/layout.js"
import { deployUpgradeable } from "../services/notice/fork/deploy.js"
import { chainNow, nextSlots, startOwnFork, timeTravelTo } from "../services/notice/fork/env.js"
import { setupForkVenue, throwawayVenueKeys, type Listing } from "../services/notice/fork/venue.js"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const SO_PATH = join(REPO, "programs/venue/target/deploy/bellwether_venue.so")
const DAY = 86_400
const MINTS = {
  FWDI: address("7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9"),
  TSLAx: address("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"),
  NVDAx: address("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"),
}
const ISSUERS = {
  TSLAx: { issuer: "Tesla, Inc.", address: "1 Tesla Road, Austin, Texas 78725", cik: "0001318605" },
  NVDAx: { issuer: "NVIDIA Corporation", address: "2788 San Tomas Expressway, Santa Clara, California 95051", cik: "0001045810" },
}

const failures: string[] = []
let passes = 0
function expect(ok: boolean, what: string, detail?: unknown) {
  if (ok) passes++
  else failures.push(`${what}${detail === undefined ? "" : ` — got ${JSON.stringify(detail)}`}`)
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${what}\n`)
}
const iso = (s: number) => new Date(s * 1000).toISOString()

function programErrorCode(text: string): number | null {
  const hex = text.match(/custom program error: 0x([0-9a-f]+)/i)
  if (hex) return parseInt(hex[1], 16)
  const dec = text.match(/"?Custom"?\s*[:(]\s*(\d+)/)
  return dec ? Number(dec[1]) : null
}

/** Independent of the notice code: raw jsonParsed mint read → the authorities the draft must state. */
async function mainnetMintAuthorities(rpc: ReturnType<typeof createRpcClient>, mint: string): Promise<Record<string, string | null>> {
  type Ext = { extension: string; state?: Record<string, unknown> }
  const { result } = await rpc.call<{ value: { data: { parsed: { info: { mintAuthority: string | null; freezeAuthority: string | null; extensions?: Ext[] } } } } | null }>(
    "getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }])
  if (!result.value) throw new Error(`mainnet has no account ${mint}`)
  const info = result.value.data.parsed.info
  const ext = (name: string, field: string) => {
    const v = (info.extensions ?? []).find((e) => e.extension === name)?.state?.[field]
    return typeof v === "string" && v.length > 0 ? v : null
  }
  return {
    mintAuthority: info.mintAuthority, freezeAuthority: info.freezeAuthority,
    permanentDelegate: ext("permanentDelegate", "delegate"), metadataPointerAuthority: ext("metadataPointer", "authority"),
    metadataUpdateAuthority: ext("tokenMetadata", "updateAuthority"), scaledUiAuthority: ext("scaledUiAmountConfig", "authority"),
    defaultAccountState: ext("defaultAccountState", "accountState"), transferHookAuthority: ext("transferHook", "authority"),
    transferHookProgram: ext("transferHook", "programId"), pausableAuthority: ext("pausableConfig", "authority"),
  }
}

function fact(draft: NoticeDraft, letter: string, key: string) {
  return draft.items.find((i) => i.letter === letter)?.facts.find((f) => f.key === key)?.value
}

async function main() {
  if (!existsSync(SO_PATH)) {
    throw new Error(`prebuilt program missing: ${SO_PATH}. Build it with \`npm run program:build\` (cargo build-sbf); this check deploys the .so and never runs cargo.`)
  }
  const elf = new Uint8Array(readFileSync(SO_PATH))
  const fork = await startOwnFork()
  process.stdout.write(`surfpool started by this check (pid ${fork.pid}) at ${fork.rpcUrl}, mainnet datasource\n`)
  try {
    const chain = createChain(fork.rpcUrl)
    const forkRpc = createRpcClient({ url: fork.rpcUrl, minIntervalMs: 0 })
    const [payer, upgradeAuthority, programKp, bufferKp] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()))
    const keys = await throwawayVenueKeys()
    await chain.fundSol(payer.address, 50_000_000_000n)
    await chain.fundSol(upgradeAuthority.address, 5_000_000_000n)
    await chain.fundSol(keys.admin.address, 20_000_000_000n)

    // 1. A real upgradeable deploy: the loader writes ProgramData and the upgrade authority.
    const deployed = await deployUpgradeable(chain, { payer, program: programKp, buffer: bufferKp, upgradeAuthority, elf })
    await nextSlots(fork.rpcUrl)
    process.stdout.write(`deployed ${deployed.programId} (${elf.length} B in ${deployed.writes} writes), ProgramData ${deployed.programData}\n`)
    const pd = await readAccount(forkRpc, deployed.programData)
    const rawAuthority = pd && pd.data[12] === 1 ? getAddressDecoder().decode(pd.data.subarray(13, 45)) : null
    expect(pd?.owner === "BPFLoaderUpgradeab1e11111111111111111111111", "ProgramData is owned by the BPF upgradeable loader", pd?.owner)
    expect(rawAuthority === upgradeAuthority.address, "loader ProgramData records the known upgrade authority", rawAuthority)

    // 2. Venue, symbols and the FWDI pool with throwaway keys.
    const listings: Listing[] = [
      { ticker: "FWDI", mint: MINTS.FWDI, tier: 2, issuerSponsored: true, pool: true },
      { ticker: "TSLAx", mint: MINTS.TSLAx, tier: 1, issuerSponsored: false, pool: false },
      { ticker: "NVDAx", mint: MINTS.NVDAx, tier: 1, issuerSponsored: false, pool: false },
    ]
    const v = await setupForkVenue(chain, deployed.programId, keys, listings)
    process.stdout.write(`venue ${v.venue}; FWDI pool ${v.symbols.FWDI.pool?.address}\n`)
    const P = deployed.programId
    const sym = (t: keyof typeof MINTS) => v.symbols[t].address

    // 3. Issuer notices: the tracker predicts each activate_pool, the chain confirms it.
    const t0 = await chainNow(fork.rpcUrl)
    const receivedAt = t0 - 3600
    const records: Record<"TSLAx" | "NVDAx", IssuerNoticeRecord> = {
      TSLAx: { symbol: "TSLAx", mint: MINTS.TSLAx, issuerSponsored: false, issuer: ISSUERS.TSLAx.issuer, address: ISSUERS.TSLAx.address,
        addressSource: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ISSUERS.TSLAx.cik}&type=10-K`, sentAt: iso(receivedAt - 3 * DAY), receivedAt: iso(receivedAt) },
      NVDAx: { symbol: "NVDAx", mint: MINTS.NVDAx, issuerSponsored: false, issuer: ISSUERS.NVDAx.issuer, address: ISSUERS.NVDAx.address,
        addressSource: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ISSUERS.NVDAx.cik}&type=10-K`, sentAt: iso(receivedAt - 3 * DAY), receivedAt: iso(receivedAt) },
    }
    for (const t of ["TSLAx", "NVDAx"] as const) await chain.send([recordIssuerNoticeInstruction(P, keys.admin, v.venue, sym(t), receivedAt)], keys.admin)

    async function activation(stage: string, ticker: keyof typeof MINTS, record: IssuerNoticeRecord | null, expectCode: number | null) {
      const account = await readAccount(forkRpc, sym(ticker))
      const s = decodeSymbol(account!.data)
      const nowS = await chainNow(fork.rpcUrl)
      const tracker = trackIssuerNotice(record ?? { symbol: ticker, mint: MINTS[ticker], issuer: "Forward Industries, Inc.", issuerSponsored: true },
        { address: sym(ticker), issuerSponsored: s.issuerSponsored, noticeReceivedAt: s.noticeReceivedAt, objected: s.objected, active: s.active }, new Date(nowS * 1000))
      let actual: number | null = null
      try {
        await chain.send([activatePoolInstruction(P, keys.admin, v.venue, sym(ticker))], keys.admin)
      } catch (error) {
        actual = programErrorCode(errorText(error)) ?? -1
      }
      const label = expectCode === null ? "activates" : `is refused with ${expectCode}`
      expect(actual === expectCode, `${stage}: activate_pool ${ticker} ${label}`, actual)
      expect(tracker.expectedActivation.code === actual && tracker.canActivate === (actual === null),
        `${stage}: tracker predicted ${ticker} (${tracker.status}${tracker.daysRemaining ? `, ${tracker.daysRemaining} d left` : ""})`, tracker.expectedActivation)
      return tracker
    }

    await activation("day 0", "FWDI", null, null)
    await activation("day 0", "TSLAx", records.TSLAx, 6008)
    await activation("day 0", "NVDAx", records.NVDAx, 6008)
    const objectedAt = await chainNow(fork.rpcUrl)
    await chain.send([recordObjectionInstruction(P, keys.admin, v.venue, sym("NVDAx"))], keys.admin)
    records.NVDAx = { ...records.NVDAx, objection: { receivedAt: iso(objectedAt) } }
    await timeTravelTo(fork.rpcUrl, receivedAt + 29 * DAY)
    const day29 = await activation("day 29", "TSLAx", records.TSLAx, 6008)
    expect(day29.status === "window-open" && day29.daysRemaining === 1, "day 29: tracker shows the objection window open, 1 day left", day29.status)
    await timeTravelTo(fork.rpcUrl, receivedAt + 30 * DAY + 120)
    await activation("day 30", "TSLAx", records.TSLAx, null)
    const blocked = await activation("day 30", "NVDAx", records.NVDAx, 6009)
    expect(blocked.status === "objected" && blocked.reminders.some((r) => r.kind === "objection" && r.due === addBusinessDays(easternDate(iso(objectedAt)), 5)),
      "objection: tracker blocks NVDAx and reminds to amend the Notice within 5 business days", blocked.reminders)

    // 4. The draft, from live fork reads.
    const config = loadVenueConfig()
    config.listings.push(
      { symbol: "TSLAx", mint: MINTS.TSLAx, issuer: ISSUERS.TSLAx.issuer, tokenizer: "Backed Assets (xStocks)", issuerSponsored: false },
      { symbol: "NVDAx", mint: MINTS.NVDAx, issuer: ISSUERS.NVDAx.issuer, tokenizer: "Backed Assets (xStocks)", issuerSponsored: false })
    const nowS = await chainNow(fork.rpcUrl)
    const facts = await resolveChainFacts({ rpc: forkRpc, programId: P, venue: v.venue, mints: Object.values(MINTS) })
    const draft = buildNoticeDraft({ chain: facts, config, issuerNotices: [records.TSLAx, records.NVDAx], publishedOn: "2026-09-25", now: new Date(nowS * 1000) })
    expect(NoticeDraftSchema.safeParse(draft).success, "draft JSON validates against NoticeDraftSchema")
    expect(facts.symbols.length === 3, "resolver finds all three SymbolRecords", facts.symbols.map((s) => s.ticker))

    const governance: [string, string][] = [
      ["program.id", P], ["program.programData", deployed.programData], ["program.upgradeAuthority", upgradeAuthority.address],
      ["venue.address", v.venue], ["venue.admin", keys.admin.address], ["venue.relay", keys.relay.address],
      ["venue.dataAuthority", keys.dataAuthority.address], ["venue.credentialIssuer", keys.credentialIssuer.address], ["venue.affiliateGroup", keys.affiliateGroup],
    ]
    for (const letter of ["c", "n"]) {
      const bad = governance.filter(([k, want]) => fact(draft, letter, k) !== want).map(([k]) => k)
      expect(bad.length === 0, `(${letter}) states the deployed upgrade authority, program and VenueConfig keys`, bad)
    }
    expect(fact(draft, "n", "venue.sasCredential") === keys.sasCredential && fact(draft, "n", "venue.sasSchema") === keys.sasSchema
      && fact(draft, "f", "venue.credentialIssuer") === keys.credentialIssuer.address, "(n)/(f) state the SAS credential, schema and credential issuer")
    const pool = v.symbols.FWDI.pool!
    expect(fact(draft, "n", "pool.FWDI.address") === pool.address && fact(draft, "n", "pool.FWDI.stockVault") === pool.stockVault
      && fact(draft, "n", "pool.FWDI.usdcVault") === pool.usdcVault, "(n) states the FWDI pool and vault addresses")
    expect(fact(draft, "p", "pool.FWDI.feeBps") === 30 && fact(draft, "u", "pool.FWDI.feeBps") === 30, "(p)/(u) state the pool's fee_bps (30)")
    expect(fact(draft, "r", "venue.heartbeatMaxAgeS") === 180 && fact(draft, "o", "venue.tradeDateCutoff") === "20:00 UTC", "(r)/(o) state heartbeat max age and trade-date cutoff")
    expect((draft.items.find((i) => i.letter === "n")?.text ?? "").includes(upgradeAuthority.address), "(n) text names the upgrade authority")

    const mainnet = createRpcClient()
    for (const [ticker, mint] of Object.entries(MINTS)) {
      const truth = await mainnetMintAuthorities(mainnet, mint)
      const bad = Object.entries(truth).filter(([field, want]) => fact(draft, "n", `mint.${ticker}.${field}`) !== want).map(([f]) => f)
      expect(bad.length === 0, `(n) ${ticker} authorities equal a direct mainnet read (freeze ${truth.freezeAuthority?.slice(0, 6)}…, delegate ${truth.permanentDelegate?.slice(0, 6)}…)`, bad)
    }
    const report = JSON.parse(readFileSync(join(REPO, "services/rehearsal/latest-report.json"), "utf8")) as { generatedAt: string; mint: { freezeAuthority: string; mintAuthority: string } }
    expect(fact(draft, "n", "mint.FWDI.freezeAuthority") === report.mint.freezeAuthority && fact(draft, "n", "mint.FWDI.mintAuthority") === report.mint.mintAuthority,
      `FWDI authorities also match the rehearsal report of ${report.generatedAt}`)

    // 5. Everything else: config or flagged; the clocks.
    const wrong = draft.items.filter((i) => !(
      (i.source === "operator-input" && i.status === "operator-input" && i.text === null && !!i.operatorPrompt)
      || (i.source !== "operator-input" && i.status === "filled" && !!i.text && i.facts.some((f) => f.source === i.source))))
    expect(wrong.length === 0, "every item is filled from chain/config or flagged operator input", wrong.map((i) => `${i.letter}:${i.status}`))
    const c = draft.completeness
    expect(c.filled + c.operatorInput === 30 && c.unresolved === 0, `completeness ${c.label} (${c.operatorInput} operator input, ${c.withAddenda} with addenda)`, c)
    expect(fact(draft, "j", "symbol.NVDAx.objected") === true && fact(draft, "j", "symbol.TSLAx.objected") === false
      && /NVIDIA Corporation/.test(draft.items.find((i) => i.letter === "j")?.text ?? ""), "(j) names NVIDIA's objection only")
    expect(fact(draft, "g", "symbol.FWDI.active") === true && fact(draft, "g", "symbol.TSLAx.active") === true && fact(draft, "g", "symbol.NVDAx.active") === false,
      "(g) lists FWDI and TSLAx available, NVDAx not")
    const tracked = Object.fromEntries(draft.issuerNotices.map((n) => [n.symbol, n]))
    expect(tracked.FWDI?.issuerSponsored === true && tracked.FWDI.noticeRequired === false && tracked.FWDI.status === "active"
      && tracked.TSLAx?.status === "active" && tracked.NVDAx?.status === "objected",
      "draft tracker: FWDI issuer-sponsored (no notice needed) and active, TSLAx active, NVDAx objected", draft.issuerNotices.map((n) => [n.symbol, n.status, n.noticeRequired]))
    expect(draft.schedule.earliestOperatingDate === "2026-10-25" && draft.schedule.secEmailDue === "2026-09-28", "published 2026-09-25 → operate from 2026-10-25, SEC email by 2026-09-28", draft.schedule)
    const md = renderNoticeMarkdown(draft)
    const outIndex = process.argv.indexOf("--out")
    if (outIndex > 0 && process.argv[outIndex + 1]) {
      const dir = process.argv[outIndex + 1]
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "notice-draft.json"), JSON.stringify(draft, null, 2) + "\n")
      writeFileSync(join(dir, "notice-draft.md"), md)
      process.stdout.write(`wrote ${join(dir, "notice-draft.json")} and notice-draft.md\n`)
    }
    expect(md.includes("(n) Distributed Ledger Technology") && md.includes(`Completeness: ${c.label}`), "Markdown draft renders with the completeness count")
  } finally {
    await fork.stop()
  }
  process.stdout.write(`\n${passes} passed, ${failures.length} failed\n`)
  if (failures.length > 0) {
    process.stdout.write(failures.map((f) => `FAIL ${f}`).join("\n") + "\n")
    process.exit(1)
  }
}

main().catch((error) => {
  process.stderr.write(`notice check crashed: ${errorText(error)}\n`)
  process.exit(1)
})

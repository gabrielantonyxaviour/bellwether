/**
 * Accept check for blk_fwdi_rehearsal (read-only mainnet):
 *   npx tsx checks/fwdi-rehearsal.ts
 *
 * Builds the FWDI launch-rehearsal report, then checks it against chain reads made
 * independently here (base64 + the Token-2022 decoder, not the report's jsonParsed path):
 *  - reported authorities and extensions equal the on-chain mint values;
 *  - every FWDI market found is listed with its vault state, which matches a fresh read;
 *    every self-owned (vault-like) FWDI account is claimed by a listed market or reported
 *    as unattributed; a direct Manifest scan finds nothing the report missed;
 *  - activity, the daily share budget and the halt audit carry data sources.
 * Exits non-zero on any mismatch.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getBase64Encoder, isSome, type Address } from "@solana/kit"
import { AccountState, getMintDecoder } from "@solana-program/token-2022"
import { buildRehearsalReport } from "../services/rehearsal/report.js"
import { RehearsalReportSchema, type RehearsalReport } from "../services/rehearsal/schema.js"
import { createRpcClient } from "../services/rehearsal/rpc.js"
import { FWDI_MINT, MANIFEST_PROGRAM, TOKEN_2022_PROGRAM, TIER_LABEL, priorMonth } from "../services/rehearsal/constants.js"

const failures: string[] = []
let passed = 0
function expect(ok: boolean, what: string, detail?: unknown) {
  if (ok) passed++
  else failures.push(`${what}${detail === undefined ? "" : ` — got ${JSON.stringify(detail)}`}`)
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${what}\n`)
}
const warn = (what: string) => process.stdout.write(`  warn ${what}\n`)
const hasSources = (sources: { url: string; fetchedAt: string }[]) =>
  sources.length > 0 && sources.every((s) => /^https?:\/\//.test(s.url) && !Number.isNaN(Date.parse(s.fetchedAt)))

const STATE: Record<AccountState, string> = { [AccountState.Uninitialized]: "uninitialized", [AccountState.Initialized]: "initialized", [AccountState.Frozen]: "frozen" }
const opt = <T>(o: { __option: "Some"; value: T } | { __option: "None" }): T | null => (isSome(o) ? o.value : null)
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

async function checkMint(report: RehearsalReport, rpc: ReturnType<typeof createRpcClient>) {
  const { result } = await rpc.call<{ value: { data: [string, string]; owner: string } }>("getAccountInfo", [FWDI_MINT, { encoding: "base64" }])
  const mint = getMintDecoder().decode(getBase64Encoder().encode(result.value.data[0]))
  const ext = isSome(mint.extensions) ? mint.extensions.value : []
  const find = <K extends (typeof ext)[number]["__kind"]>(k: K) => ext.find((e) => e.__kind === k) as Extract<(typeof ext)[number], { __kind: K }> | undefined
  const m = report.mint
  expect(result.value.owner === TOKEN_2022_PROGRAM && m.tokenProgram === TOKEN_2022_PROGRAM, "FWDI is a Token-2022 mint")
  expect(m.decimals === mint.decimals, "decimals match chain", [m.decimals, mint.decimals])
  expect(m.mintAuthority === opt(mint.mintAuthority), "mint authority matches chain", [m.mintAuthority, opt(mint.mintAuthority)])
  expect(m.freezeAuthority === opt(mint.freezeAuthority), "freeze authority matches chain", [m.freezeAuthority, opt(mint.freezeAuthority)])
  const pd = find("PermanentDelegate")
  expect(m.permanentDelegate === (pd?.delegate ?? null), "permanent delegate matches chain", [m.permanentDelegate, pd?.delegate])
  const das = find("DefaultAccountState")
  expect(m.defaultAccountState === (das ? STATE[das.state] : null), "DefaultAccountState matches chain", [m.defaultAccountState, das && STATE[das.state]])
  const mp = find("MetadataPointer")
  expect(m.metadataPointer?.authority === (mp ? opt(mp.authority) : undefined) && m.metadataPointer?.metadataAddress === (mp ? opt(mp.metadataAddress) : undefined),
    "metadata pointer authority and address match chain", [m.metadataPointer, mp && [opt(mp.authority), opt(mp.metadataAddress)]])
  const su = find("ScaledUiAmountConfig")
  expect(m.scaledUiAmount?.authority === su?.authority && m.scaledUiAmount?.multiplier === su?.multiplier,
    "scaled-UI authority and multiplier match chain", [m.scaledUiAmount, su && [su.authority, su.multiplier]])
  const md = find("TokenMetadata")
  expect(m.metadata?.updateAuthority === (md ? opt(md.updateAuthority) : undefined) && m.metadata?.name === md?.name && m.metadata?.symbol === md?.symbol && m.metadata?.uri === md?.uri,
    "token metadata (update authority, name, symbol, uri) matches chain", [m.metadata, md && [opt(md.updateAuthority), md.name, md.symbol]])
  const chainKinds = ext.map((e) => lowerFirst(e.__kind)).sort()
  expect(JSON.stringify([...m.extensions].sort()) === JSON.stringify(chainKinds), "extension list matches chain", [m.extensions, chainKinds])
  expect(m.supplyRaw === mint.supply.toString(), "supply matches chain", [m.supplyRaw, mint.supply.toString()])
  const roles = new Map(m.authorityMap.map((a) => [a.address, a.roles]))
  for (const [role, who] of [["freeze authority", m.freezeAuthority], ["permanent delegate", m.permanentDelegate], ["mint authority", m.mintAuthority]] as const) {
    expect(who === null || (roles.get(who) ?? []).includes(role), `authority map lists the ${role}`)
  }
  expect(hasSources([m.source]), "mint facts carry a source and fetch time")
  // Documented in the spec on 2026-09-25; a rotation is news, not a report error.
  if (!m.freezeAuthority?.startsWith("2Yq4T3")) warn(`freeze authority is ${m.freezeAuthority}, not the spec's 2Yq4T3…`)
  if (!m.mintAuthority?.startsWith("CWdsNn")) warn(`mint authority is ${m.mintAuthority}, not the spec's CWdsNn…`)
}

async function checkMarkets(report: RehearsalReport, rpc: ReturnType<typeof createRpcClient>) {
  const found = report.markets.found
  const listed = new Set(found.map((x) => x.address))
  for (const market of found) {
    expect(market.fwdiVault.state !== null || !market.fwdiVault.exists, `market ${market.address} lists its FWDI vault state (${market.fwdiVault.state})`)
    expect(hasSources([market.source]), `market ${market.address} carries a source`)
  }
  if (found.length > 0) {
    const vaults = found.map((x) => x.fwdiVault.address)
    const { result } = await rpc.call<{ value: ({ data: { parsed: { info: { state: string; tokenAmount: { amount: string } } } } } | null)[] }>(
      "getMultipleAccounts", [vaults, { encoding: "jsonParsed" }])
    found.forEach((market, i) => {
      const fresh = result.value[i]?.data.parsed.info
      expect(fresh?.state === market.fwdiVault.state && fresh?.tokenAmount.amount === market.fwdiVault.amountRaw,
        `vault ${market.fwdiVault.address} state/balance match a fresh read`, [market.fwdiVault.state, market.fwdiVault.amountRaw, fresh?.state, fresh?.tokenAmount.amount])
    })
  }
  // Every self-owned FWDI token account (the vault pattern) is claimed by a market or reported unattributed.
  const { result: accounts } = await rpc.call<{ pubkey: string; account: { data: { parsed: { info: { owner: string } } } } }[]>(
    "getProgramAccounts", [TOKEN_2022_PROGRAM, { encoding: "jsonParsed", filters: [{ memcmp: { offset: 0, bytes: FWDI_MINT } }] }])
  const claimed = new Set([...found.map((x) => x.fwdiVault.address), ...report.markets.tokenAccounts.unattributedVaults])
  const selfOwned = accounts.filter((a) => a.account.data.parsed.info.owner === a.pubkey).map((a) => a.pubkey)
  expect(selfOwned.every((a) => claimed.has(a)), `every self-owned FWDI account (${selfOwned.length}) is a listed market vault or reported unattributed`, selfOwned)
  expect(Math.abs(accounts.length - report.markets.tokenAccounts.total) <= 5, "token-account enumeration matches a fresh count (±5 for new accounts)", [report.markets.tokenAccounts.total, accounts.length])
  // A direct Manifest scan (the venue TECH-NOTES found) must not find a market the report missed.
  for (const offset of [16, 48]) {
    const { result } = await rpc.call<{ pubkey: string }[]>("getProgramAccounts", [MANIFEST_PROGRAM, {
      encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset, bytes: FWDI_MINT } }],
    }])
    const missed = result.map((r) => r.pubkey).filter((p) => !listed.has(p as Address))
    expect(missed.length === 0, `direct Manifest scan (mint @${offset}) finds no unlisted FWDI market`, missed)
  }
  const jup = report.markets.jupiter
  if (jup.status === "ok" && jup.firstPool) expect(listed.has(jup.firstPool), `Jupiter's firstPool ${jup.firstPool} is listed`)
  else warn(`Jupiter cross-check unavailable: ${jup.note ?? "no firstPool"}`)
  expect(report.markets.scans.length >= 14 && report.markets.scans.every((s) => s.status === "ok"), "all DEX program scans ran", report.markets.scans.filter((s) => s.status !== "ok"))
  expect(hasSources(report.markets.sources), "market discovery carries sources")
}

function checkDataSources(report: RehearsalReport) {
  const a = report.activity
  expect(a.windowDays === 30 && Date.parse(a.to) - Date.parse(a.from) === 30 * 86_400_000, "activity covers the last 30 days", [a.from, a.to])
  expect(a.signatures === a.succeeded + a.failed && (a.truncated || a.entries.length === a.signatures), "activity counts are consistent", [a.signatures, a.succeeded, a.failed, a.entries.length])
  expect(a.addresses.some((x) => x.address === FWDI_MINT), "activity scans the mint itself")
  expect(hasSources(a.sources), "activity carries sources")

  const b = report.budget
  const month = priorMonth(new Date(report.generatedAt))
  expect(b.month === month.key, `budget uses the prior calendar month (${month.key})`, b.month)
  expect(b.status !== "unavailable" && b.averageDailyShareVolume !== null && b.dailyShareBudget !== null, "budget has a value", b.errors)
  if (b.averageDailyShareVolume !== null && b.dailyShareBudget !== null) {
    expect(Math.abs(b.dailyShareBudget - b.averageDailyShareVolume * 0.025) < 1e-6, "budget = 2.5% × prior-month ADV", [b.dailyShareBudget, b.averageDailyShareVolume])
  }
  expect(b.tierLabel === TIER_LABEL && b.tierPercent === 2.5, "tier labelled as inferred Tier 2 at 2.5%", b.tierLabel)
  const x = b.crossCheck
  if (x.disagreementPct !== null) expect(x.flagged === x.disagreementPct > x.thresholdPct, `Nasdaq/Yahoo disagreement ${x.disagreementPct.toFixed(3)}% flagged iff > 1%`, x)
  expect(hasSources(b.sources) && b.sources.some((s) => s.url.includes("api.nasdaq.com")), "budget carries its Nasdaq.com source", b.sources.map((s) => s.url))
  const yahoo = b.sources.some((s) => s.url.includes("finance.yahoo.com"))
  expect(yahoo || b.errors.some((e) => /yahoo/i.test(e)), "Yahoo cross-check is sourced or its failure is reported", b.errors)
  if (!yahoo) warn(`Yahoo cross-check unavailable this run: ${b.errors.join("; ")}`)

  const h = report.haltAudit
  expect(h.status !== "unavailable" && hasSources(h.sources), `halt audit ran and carries sources (${h.status})`, h.history.perSymbol)
  expect(h.control.found, `halt history control: ${h.control.expected} is visible`, h.control)
  const marketsWithActivity = report.markets.found.filter((m) => m.activity.signatures > 0).length
  expect(marketsWithActivity === 0 || h.events.length > 0, `halt audit covers the market events (${h.events.length})`, h.events.length)
  if (h.crossCheck.status !== "agrees") warn(`Nasdaq Trader RSS cross-check ${h.crossCheck.status}: ${h.crossCheck.note}`)
  if (h.overlaps.length > 0) warn(`halt overlaps found: ${JSON.stringify(h.overlaps)}`)
  process.stdout.write(`  info ${h.note}\n`)
}

async function main() {
  const started = Date.now()
  const report = RehearsalReportSchema.parse(await buildRehearsalReport())
  process.stdout.write(`report built in ${((Date.now() - started) / 1000).toFixed(1)}s at ${report.generatedAt}\n`)
  const rpc = createRpcClient()
  await checkMint(report, rpc)
  await checkMarkets(report, rpc)
  checkDataSources(report)
  const latest = join(dirname(fileURLToPath(import.meta.url)), "..", "services", "rehearsal", "latest-report.json")
  const parsed = RehearsalReportSchema.safeParse(JSON.parse(readFileSync(latest, "utf8")))
  expect(parsed.success, "services/rehearsal/latest-report.json matches the report schema", parsed.success ? undefined : parsed.error.issues.slice(0, 3))

  const m = report.markets.found
  process.stdout.write(`\nFWDI: freeze/permanent delegate ${report.mint.freezeAuthority}, mint/metadata/scaled-UI ${report.mint.mintAuthority}\n`)
  process.stdout.write(`markets: ${m.map((x) => `${x.programName} ${x.address} (FWDI vault ${x.fwdiVault.state}, ${x.fwdiVault.amountRaw} raw)`).join("; ") || "none"}\n`)
  process.stdout.write(`30-day activity: ${report.activity.signatures} txs, ${report.activity.trades} trades; budget ${report.budget.dailyShareBudget?.toFixed(1)} shares/day (${report.budget.month} ADV ${report.budget.averageDailyShareVolume?.toFixed(0)})\n`)
  process.stdout.write(`${passed} passed, ${failures.length} failed\n`)
  if (failures.length > 0) {
    process.stdout.write(failures.map((f) => `FAIL ${f}`).join("\n") + "\n")
    process.exit(1)
  }
}

main().catch((error) => {
  process.stderr.write(`fwdi-rehearsal check crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})

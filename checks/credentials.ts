/**
 * Accept check for blk_credentials:
 *   npx tsx checks/credentials.ts
 *
 * Starts its own Surfpool mainnet fork on 127.0.0.1:8940 (ws 8941), deploys the prebuilt
 * venue program, creates the BWRS rehearsal mint, a SAS-gated venue, symbol and pool with
 * throwaway keypairs, and runs the credential service (test admission, not KYC) over HTTP:
 *   admit → the wallet's swap succeeds; the SDN-fixture wallet (and a real SDN SOL address)
 *   is refused; revoke → the next swap fails NotAdmitted (6000). Then the same round-trip on
 *   the membership fallback gate. Every process it starts is stopped by pid.
 */
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token"
import { MAINNET_USDC_MINT } from "../config/clusters.js"
import { associatedStockAccount, mintRehearsalStock, readTokenAccount } from "../scripts/assets/thaw.js"
import { createChain, errorText, type Chain } from "../scripts/assets/tx.js"
import { DEFAULT_FIXTURE, SERVICE_DIR, runtimePaths, type CredentialConfig } from "../services/credential/config.js"
import { startOwnFork, setTokenBalance } from "../services/credential/fork/surfnet.js"
import { deployVenue, type ForkVenue } from "../services/credential/fork/venue-setup.js"
import { resilientChain, withRetry } from "../services/credential/retry.js"
import { sasIdentity } from "../services/credential/sas.js"
import { startServer, type RunningService } from "../services/credential/service.js"
import { OFAC_SDN_XML_URL, loadFixture } from "../services/credential/sdn.js"
import { BUY, GATE_MEMBER, GATE_SAS, addLiquidityIx, swapIx } from "../services/credential/venue-ix.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SO = join(ROOT, "programs", "venue", "target", "deploy", "bellwether_venue.so")
const REAL_SDN_SOL = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi"
const NOT_ADMITTED = /custom program error: 0x1770\b|"code":6000\b|"Custom":6000\b/
const ONE = 1_000_000n

const passes: string[] = []
const failures: string[] = []
function expect(ok: boolean, what: string, detail?: unknown) {
  if (ok) passes.push(what)
  else failures.push(`${what}${detail === undefined ? "" : ` — got ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))?.slice(0, 600)}`}`)
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${what}\n`)
}

async function expectFailure(what: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run()
    expect(false, what, "transaction succeeded")
  } catch (error) {
    const text = errorText(error)
    expect(pattern.test(text), what, text.slice(0, 600))
  }
}

type Json = Record<string, any>
async function http(svc: RunningService, method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(svc.url + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Json }
}

/** POST /admit; on failure, attach the service log's recorded reason (never in the HTTP body). */
async function admitVia(svc: RunningService, wallet: Address | string, token: string): Promise<{ status: number; json: Json }> {
  const res = await http(svc, "POST", "/admit", { wallet })
  if (res.status !== 200) {
    const log = await http(svc, "GET", `/screening-log?wallet=${wallet}&limit=5`, undefined, token)
    res.json.serviceLog = (log.json.entries ?? []).find((e: Json) => e.event === "error")?.reason
  }
  return res
}

interface Trader { kp: KeyPairSigner; stock: Address; usdc: Address }
async function fundedTrader(chain: Chain, rpcUrl: string, usdc: bigint, stockMint: Address): Promise<Trader> {
  const kp = await generateKeyPairSigner()
  await chain.fundSol(kp.address, 1_000_000_000n)
  if (usdc > 0n) await withRetry(() => setTokenBalance(rpcUrl, kp.address, MAINNET_USDC_MINT, usdc, TOKEN_PROGRAM_ADDRESS))
  const [usdcAta] = await findAssociatedTokenPda({ owner: kp.address, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  return { kp, usdc: usdcAta, stock: await associatedStockAccount(kp.address, stockMint) }
}

const swap = (chain: Chain, v: ForkVenue, t: Trader, cred: Address, amountIn: bigint) =>
  chain.send([swapIx(v.programId, v.keys, t.kp, t.stock, t.usdc, cred, BUY, amountIn, 1n)], t.kp)

async function main() {
  if (!existsSync(SO)) {
    throw new Error(`${SO} is missing. Build it with \`npm run program:build\` (cargo build-sbf); this check never runs cargo.`)
  }
  const fork = await startOwnFork({ port: 8940, wsPort: 8941, studioPort: 18940 })
  process.stdout.write(`surfpool fork started (pid ${fork.pid}, mainnet datasource, 127.0.0.1 only) at ${fork.rpcUrl}\n`)
  const tmp = mkdtempSync(join(tmpdir(), "bellwether-credentials-"))
  const services: RunningService[] = []
  try {
    const chain = resilientChain(createChain(fork.rpcUrl))
    const [issuer, venueKey] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()])
    await chain.fundSol(issuer.address, 20_000_000_000n)
    const sas = await sasIdentity(issuer.address)
    const venue = await deployVenue({ chain, rpcUrl: fork.rpcUrl, so: readFileSync(SO), payer: issuer, venueKey, issuer: issuer.address, sas, gate: GATE_SAS })
    process.stdout.write(`venue ${venue.keys.venue} (program ${venue.programId}), pool ${venue.keys.pool}, BWRS ${venue.keys.stockMint}\n`)

    const token = randomBytes(24).toString("hex")
    const config: CredentialConfig = {
      cluster: "fork", rpcUrl: fork.rpcUrl, issuer, freezeAuthority: venueKey, payer: issuer, stockMint: venue.keys.stockMint,
      gate: { kind: "sas" }, ttlSeconds: 30n * 86_400n, operatorToken: token, dataDir: tmp,
      sdnCachePath: runtimePaths(join(SERVICE_DIR, "data")).sdnCachePath, logPath: join(tmp, "screening-log.jsonl"),
      sdnUrl: OFAC_SDN_XML_URL, sdnMaxAgeMs: 24 * 3_600_000, fixturePath: DEFAULT_FIXTURE, host: "127.0.0.1", port: 0, corsOrigin: "*",
    }
    const svc = await startServer(config)
    services.push(svc)
    await svc.admissions.ready()
    await svc.admissions.ready()
    const health = await http(svc, "GET", "/health")
    expect(health.json.label === "test admission, not KYC", "service labels itself 'test admission, not KYC'", health.json.label)
    expect(health.json.credential?.credential === sas.credential && health.json.credential?.schema === sas.schema, "SAS credential + schema created once, owned by the venue issuer", health.json.credential)
    expect((health.json.sdn?.byCurrency?.SOL ?? 0) > 0, `official OFAC SDN list loaded (${health.json.sdn?.officialAddresses} digital-currency addresses, published ${health.json.sdn?.publishDate})`, health.json.sdn)

    // LP: admitted through the service, then seeds 1,000 BWRS against 20,000 USDC.
    const lp = await fundedTrader(chain, fork.rpcUrl, 20_000n * ONE, venue.keys.stockMint)
    const lpAdmit = await admitVia(svc, lp.kp.address, token)
    if (lpAdmit.status !== 200) throw new Error(`LP admission failed: ${JSON.stringify(lpAdmit.json).slice(0, 1_500)}`)
    expect(true, "LP admitted through the service")
    await mintRehearsalStock(chain, { payer: issuer, mint: venue.keys.stockMint, to: lp.stock, mintAuthority: venue.mintAuthority, shares: 1_000n })
    await chain.send([await addLiquidityIx(venue.programId, venue.keys, lp.kp, lp.stock, lp.usdc, lpAdmit.json.credential.address, 1_000n * ONE, 20_000n * ONE, 1n)], lp.kp)

    // 1. admit → swap succeeds.
    const trader = await fundedTrader(chain, fork.rpcUrl, 500n * ONE, venue.keys.stockMint)
    const bad = await http(svc, "POST", "/admit", { wallet: "not-a-wallet" })
    expect(bad.status === 400 && bad.json.code === "INVALID_INPUT" && typeof bad.json.error === "string", "malformed wallet → 400 {error, code: INVALID_INPUT}", bad)
    const admit = await admitVia(svc, trader.kp.address, token)
    expect(admit.status === 200 && admit.json.status === "admitted", "clear wallet admitted", admit)
    const cred = admit.json.credential?.address as Address
    const status = await http(svc, "GET", `/credential/${trader.kp.address}`)
    const nowSec = Math.floor(Date.now() / 1000)
    expect(status.json.status === "admitted" && status.json.admitted === true, "GET /credential says admitted", status.json)
    expect(Math.abs(status.json.expiresAtUnix - (nowSec + 30 * 86_400)) < 3_600, `attestation expiry ≈ now + 30 days (${status.json.expiresAt})`, status.json.expiresAtUnix)
    expect(status.json.stockAccount?.state === "thawed", "wallet's BWRS account thawed by the venue key", status.json.stockAccount)
    const again = await http(svc, "POST", "/admit", { wallet: trader.kp.address })
    expect(again.status === 200 && again.json.alreadyAdmitted === true && again.json.signature === null, "re-admission is idempotent (no transaction)", again.json)
    await swap(chain, venue, trader, cred, 100n * ONE)
    const bought = await withRetry(() => readTokenAccount(chain.rpc, trader.stock))
    expect(bought.amount > 0n, `admitted wallet's swap succeeds (bought ${Number(bought.amount) / 1e6} BWRS for 100 USDC)`, bought.amount)

    // 2. SDN fixture wallet (and a real SDN-listed SOL address) refused.
    const fixture = loadFixture(DEFAULT_FIXTURE)[0].address
    for (const [label, wallet] of [["SDN-fixture wallet", fixture], ["real SDN-listed SOL address", REAL_SDN_SOL]] as const) {
      const refused = await http(svc, "POST", "/admit", { wallet })
      expect(refused.status === 403 && refused.json.code === "SANCTIONED", `${label} refused admission (403 SANCTIONED)`, refused)
      const st = await http(svc, "GET", `/credential/${wallet}`)
      expect(st.json.admitted === false && st.json.stockAccount?.state === "missing", `${label}: no credential issued, no BWRS account thawed`, st.json)
    }
    const log = await http(svc, "GET", `/screening-log?wallet=${fixture}`, undefined, token)
    expect(log.json.entries?.[0]?.result === "sanctioned" && log.json.entries?.[0]?.match?.uid === "fixture-1", "refusal recorded in the screening log", log.json)

    // 3. revoke → next swap fails NotAdmitted (6000).
    const anon = await http(svc, "POST", "/revoke", { wallet: trader.kp.address })
    expect(anon.status === 401 && anon.json.code === "UNAUTHORIZED", "revoke without the operator token → 401", anon)
    const revoke = await http(svc, "POST", "/revoke", { wallet: trader.kp.address }, token)
    expect(revoke.status === 200 && revoke.json.status === "revoked", "operator revokes the credential", revoke)
    const gone = await withRetry(() => chain.rpc.getAccountInfo(cred, { encoding: "base64" }).send())
    expect(gone.value === null, "SAS attestation account closed", gone.value?.owner)
    const after = await http(svc, "GET", `/credential/${trader.kp.address}`)
    expect(after.json.status === "revoked" && after.json.stockAccount?.state === "frozen", "status: revoked, BWRS account frozen again", after.json)
    await expectFailure("revoked wallet's next swap fails NotAdmitted (6000)", () => swap(chain, venue, trader, cred, 10n * ONE), NOT_ADMITTED)
    const selfReadmit = await http(svc, "POST", "/admit", { wallet: trader.kp.address })
    expect(selfReadmit.status === 403 && selfReadmit.json.code === "REVOKED", "revocation is sticky: the wallet cannot re-admit itself (403 REVOKED)", selfReadmit)
    const opReadmit = await http(svc, "POST", "/admit", { wallet: trader.kp.address }, token)
    expect(opReadmit.status === 200 && opReadmit.json.alreadyAdmitted === false, "operator re-admits the wallet with a fresh attestation", opReadmit.json)
    await swap(chain, venue, trader, cred, 10n * ONE)
    expect(true, "after operator re-admission the swap works again")

    // 4. Membership fallback (CREDENTIAL_GATE=membership) on the same venue, switched to gate 2.
    await venue.setGate(GATE_MEMBER)
    const msvc = await startServer({ ...config, gate: { kind: "membership", programId: venue.programId, venue: venue.keys.venue }, logPath: join(tmp, "membership-log.jsonl") })
    services.push(msvc)
    const member = await fundedTrader(chain, fork.rpcUrl, 100n * ONE, venue.keys.stockMint)
    const madmit = await admitVia(msvc, member.kp.address, token)
    expect(madmit.status === 200 && madmit.json.credential?.kind === "membership", "membership fallback: wallet admitted by grant_member", madmit.json)
    await swap(chain, venue, member, madmit.json.credential.address, 10n * ONE)
    expect((await withRetry(() => readTokenAccount(chain.rpc, member.stock))).amount > 0n, "membership fallback: admitted wallet's swap succeeds")
    const mrevoke = await http(msvc, "POST", "/revoke", { wallet: member.kp.address }, token)
    expect(mrevoke.status === 200, "membership fallback: revoke_member", mrevoke.json)
    await expectFailure("membership fallback: next swap fails NotAdmitted (6000)", () => swap(chain, venue, member, madmit.json.credential.address, 10n * ONE), NOT_ADMITTED)
  } finally {
    for (const s of services) await s.close()
    await fork.stop()
    rmSync(tmp, { recursive: true, force: true })
    process.stdout.write(`surfpool fork (pid ${fork.pid}) stopped\n`)
  }
  process.stdout.write(`\n${passes.length} passed, ${failures.length} failed\n`)
  if (failures.length > 0) {
    process.stdout.write(failures.map((f) => `FAIL ${f}`).join("\n") + "\n")
    process.exit(1)
  }
}

main().catch((error) => {
  const detail = (error as { detail?: string }).detail
  process.stderr.write(`credentials check crashed: ${errorText(error)}${detail ? ` — ${detail}` : ""}\n`)
  process.exit(1)
})

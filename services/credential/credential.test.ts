/**
 * Offline tests for the credential issuer's seams — SDN parsing and caching, the attestation
 * byte gate, the HTTP contract and the venue instruction encodings:
 *   npx tsx --test services/credential/credential.test.ts
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { address, generateKeyPairSigner, getAddressEncoder, type Address } from "@solana/kit"
import { createApp } from "./app.js"
import { AdmissionError, type Admissions } from "./admission.js"
import { gateAdmits, parseAttestation } from "./attestation.js"
import { Screener, loadFixture, loadOfficialList, parseSdnXml } from "./sdn.js"
import { ScreeningLog } from "./screening-log.js"
import { initVenueIx, swapIx, GATE_SAS } from "./venue-ix.js"
import { LABEL } from "./labels.js"
import { isTransient, withRetry } from "./retry.js"

const SOL_SDN = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi"
const XML = `<?xml version="1.0" standalone="yes"?>
<sdnList><publshInformation><Publish_Date>09/23/2026</Publish_Date><Record_Count>2</Record_Count></publshInformation>
<sdnEntry><uid>101</uid><lastName>EXAMPLE EXCHANGE</lastName><sdnType>Entity</sdnType>
  <idList>
    <id><uid>9001</uid><idType>Digital Currency Address - SOL</idType><idNumber>${SOL_SDN}</idNumber></id>
    <id><uid>9002</uid><idType>Digital Currency Address - ETH</idType><idNumber>0xAbCdEf0000000000000000000000000000000001</idNumber></id>
    <id><uid>9003</uid><idType>Registration Number</idType><idNumber>12345</idNumber></id>
  </idList></sdnEntry>
<sdnEntry><uid>202</uid><firstName>Jane</firstName><lastName>ROE</lastName><sdnType>Individual</sdnType>
  <idList><id><uid>9004</uid><idType>Passport</idType><idNumber>X1</idNumber></id></idList></sdnEntry>
</sdnList>`

test("SDN XML: every digital-currency id is extracted with its entry; other ids are ignored", () => {
  const parsed = parseSdnXml(XML)
  assert.equal(parsed.publishDate, "09/23/2026")
  assert.equal(parsed.recordCount, 2)
  assert.deepEqual(parsed.entries.map((e) => [e.currency, e.address, e.uid, e.name]), [
    ["SOL", SOL_SDN, "101", "EXAMPLE EXCHANGE"],
    ["ETH", "0xAbCdEf0000000000000000000000000000000001", "101", "EXAMPLE EXCHANGE"],
  ])
  assert.throws(() => parseSdnXml("<html>Access denied</html>"), /not an OFAC SDN list/)
})

test("Screener: base58 matches exactly, hex matches case-insensitively, fixtures are merged", () => {
  const official = parseSdnXml(XML).entries
  const fixture = [{ address: "Fixture1111111111111111111111111111111111111", currency: "SOL", uid: "fixture-1", name: "fixture" }]
  const s = new Screener(official, fixture)
  assert.equal(s.match(SOL_SDN)?.uid, "101")
  assert.equal(s.match(SOL_SDN.toLowerCase()), null)
  assert.equal(s.match("0xabcdef0000000000000000000000000000000001")?.currency, "ETH")
  assert.equal(s.match(fixture[0].address)?.uid, "fixture-1")
  assert.equal(s.match("11111111111111111111111111111111"), null)
  assert.equal(s.size, 3)
})

test("the committed fixture holds one throwaway SOL address labelled as not a real SDN entry", () => {
  const entries = loadFixture(join(import.meta.dirname, "fixtures", "sdn-fixture.json"))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].currency, "SOL")
  assert.match(entries[0].name, /not a real SDN entry/i)
  assert.doesNotThrow(() => address(entries[0].address))
})

test("official list: downloaded once, served from cache while fresh, stale cache on outage, fail closed without one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-sdn-"))
  const cachePath = join(dir, "sdn-cache.json")
  let calls = 0
  const ok = (async () => { calls++; return new Response(XML, { status: 200 }) }) as typeof fetch
  const down = (async () => { calls++; throw new Error("ECONNRESET") }) as typeof fetch
  const t0 = Date.parse("2026-09-25T00:00:00Z")
  const opts = { cachePath, url: "https://example.test/SDN.XML", maxAgeMs: 3_600_000 }

  const first = await loadOfficialList({ ...opts, fetchImpl: ok, now: () => t0 })
  assert.equal(first.from, "download")
  assert.equal(first.list.entries.length, 2)
  assert.ok(existsSync(cachePath))
  const cached = await loadOfficialList({ ...opts, fetchImpl: ok, now: () => t0 + 60_000 })
  assert.equal(cached.from, "cache")
  assert.equal(calls, 1)
  const stale = await loadOfficialList({ ...opts, fetchImpl: down, now: () => t0 + 7_200_000 })
  assert.equal(stale.from, "cache")
  assert.equal(stale.stale, true)
  await assert.rejects(
    loadOfficialList({ ...opts, cachePath: join(dir, "none.json"), fetchImpl: down, now: () => t0 }),
    /OFAC SDN list unavailable/,
  )
  const html = (async () => new Response("<html>maintenance</html>", { status: 200 })) as typeof fetch
  await assert.rejects(loadOfficialList({ ...opts, cachePath: join(dir, "bad.json"), fetchImpl: html, now: () => t0 }))
  assert.equal(existsSync(join(dir, "bad.json")), false)
})

function attestationBytes(wallet: Address, credential: Address, schema: Address, signer: Address, expiry: bigint): Uint8Array {
  const enc = getAddressEncoder()
  const out = new Uint8Array(174)
  out[0] = 2
  out.set(enc.encode(wallet), 1)
  out.set(enc.encode(credential), 33)
  out.set(enc.encode(schema), 65)
  new DataView(out.buffer).setUint32(97, 1, true)
  out[101] = 1
  out.set(enc.encode(signer), 102)
  new DataView(out.buffer).setBigInt64(134, expiry, true)
  return out
}

test("attestation bytes: parsed like the program's gate; zero, past, foreign or truncated attestations do not admit", async () => {
  const [w, c, s, i, other] = await Promise.all(Array.from({ length: 5 }, async () => (await generateKeyPairSigner()).address))
  const now = 1_790_000_000n
  const bytes = attestationBytes(w, c, s, i, now + 86_400n)
  const parsed = parseAttestation(bytes)!
  assert.equal(parsed.nonce, w)
  assert.equal(parsed.credential, c)
  assert.equal(parsed.schema, s)
  assert.equal(parsed.signer, i)
  assert.equal(parsed.expiry, now + 86_400n)
  assert.deepEqual([...parsed.data], [1])
  const pinned = { credential: c, schema: s, wallet: w }
  assert.equal(gateAdmits(parsed, pinned, now), true)
  assert.equal(gateAdmits(parsed, pinned, now + 86_400n), false)
  assert.equal(gateAdmits(parseAttestation(attestationBytes(w, c, s, i, 0n)), pinned, now), false)
  assert.equal(gateAdmits(parsed, { ...pinned, wallet: other }, now), false)
  assert.equal(gateAdmits(parsed, { ...pinned, schema: other }, now), false)
  assert.equal(parseAttestation(bytes.slice(0, 172)), null)
  assert.equal(parseAttestation(Uint8Array.from([1, ...bytes.slice(1)])), null)
})

function fakeAdmissions(sanctioned: string): Admissions & { revoked: string[]; operatorAdmits: string[] } {
  const revoked: string[] = []
  const operatorAdmits: string[] = []
  return {
    revoked,
    operatorAdmits,
    info: () => ({ label: LABEL, cluster: "fork", gate: "sas" as const, credential: {} }),
    ready: async () => {},
    admit: async (wallet, opts) => {
      if (opts?.operator) operatorAdmits.push(wallet)
      if (wallet === sanctioned) throw new AdmissionError("SANCTIONED", 403, "wallet matches the OFAC SDN list")
      return { label: LABEL, wallet, status: "admitted" as const, alreadyAdmitted: false, expiresAt: "2026-10-25T00:00:00.000Z", expiresAtUnix: 1, credential: { kind: "sas" as const, address: wallet }, stockAccount: { address: wallet, state: "thawed" as const }, signature: "sig" }
    },
    revoke: async (wallet) => { revoked.push(wallet); return { label: LABEL, wallet, status: "revoked" as const, signature: "sig" } },
    status: async (wallet) => {
      if (wallet === "boom") throw new Error("secret stack detail")
      return { label: LABEL, wallet, cluster: "fork", gate: "sas" as const, status: "not_admitted" as const, admitted: false, expiresAt: null, expiresAtUnix: null, credential: { kind: "sas" as const, address: wallet }, stockAccount: { address: wallet, state: "missing" as const }, lastScreening: null }
    },
    screeningLog: async () => [],
  }
}

test("HTTP: zod-validated inputs, {error, code} errors, operator token on revoke, no leaked internals", async () => {
  const wallet = (await generateKeyPairSigner()).address
  const bad = (await generateKeyPairSigner()).address
  const admissions = fakeAdmissions(bad)
  const app = createApp(admissions, { operatorToken: "op-secret", corsOrigin: "*" })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) })

  let res = await post("/admit", { wallet: "not-a-wallet" })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, "INVALID_INPUT")
  res = await post("/admit", "{oops")
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, "INVALID_INPUT")
  res = await post("/admit", { wallet: bad })
  assert.equal(res.status, 403)
  assert.deepEqual(Object.keys(await res.json()).sort(), ["code", "error"])
  res = await post("/admit", { wallet })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).label, "test admission, not KYC")

  res = await post("/admit", { wallet }, { authorization: "Bearer wrong" })
  assert.equal(res.status, 401)
  res = await post("/admit", { wallet }, { authorization: "Bearer op-secret" })
  assert.equal(res.status, 200)
  assert.deepEqual(admissions.operatorAdmits, [wallet])

  res = await post("/revoke", { wallet })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).code, "UNAUTHORIZED")
  res = await post("/revoke", { wallet }, { authorization: "Bearer nope" })
  assert.equal(res.status, 401)
  res = await post("/revoke", { wallet }, { authorization: "Bearer op-secret" })
  assert.equal(res.status, 200)
  assert.deepEqual(admissions.revoked, [wallet])
  const unset = createApp(admissions, { operatorToken: null, corsOrigin: "*" })
  res = await unset.request("/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) })
  assert.equal(res.status, 503)
  assert.equal((await res.json()).code, "OPERATOR_TOKEN_UNSET")

  res = await app.request(`/credential/${wallet}`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).status, "not_admitted")
  res = await app.request("/credential/xyz")
  assert.equal(res.status, 400)
  const statusBoom = createApp({ ...admissions, status: async () => { throw new Error("secret stack detail") } }, { operatorToken: "t", corsOrigin: "*" })
  res = await statusBoom.request(`/credential/${wallet}`)
  assert.equal(res.status, 500)
  const text = await res.text()
  assert.doesNotMatch(text, /secret stack detail/)
  assert.equal(JSON.parse(text).code, "INTERNAL")
  res = await app.request("/screening-log")
  assert.equal(res.status, 401)
  res = await app.request("/health")
  assert.equal((await res.json()).label, "test admission, not KYC")
})

test("screening log: JSON lines appended and read back newest first, filtered by wallet", () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-log-"))
  const log = new ScreeningLog(join(dir, "log.jsonl"))
  log.append({ wallet: "A", event: "screened", result: "clear" })
  log.append({ wallet: "B", event: "screened", result: "sanctioned" })
  log.append({ wallet: "A", event: "revoked" })
  const all = log.recent(10)
  assert.deepEqual(all.map((e) => e.wallet + ":" + e.event), ["A:revoked", "B:screened", "A:screened"])
  assert.equal(log.lastFor("A")?.event, "revoked")
  log.append({ wallet: "A", event: "screened", result: "clear" })
  assert.equal(log.lastCredentialEvent("A")?.event, "revoked")
  assert.equal(log.lastCredentialEvent("B"), null)
  assert.equal(all[0].label, "test admission, not KYC")
  assert.ok(readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").every((l) => JSON.parse(l).at))
})

test("venue instructions: byte layouts match docs/program-contract.md", async () => {
  const [program, admin, trader, a, b, c, d, e, f, g] = await Promise.all(Array.from({ length: 10 }, () => generateKeyPairSigner()))
  const keys = { venue: a.address, symbol: b.address, pool: c.address, stockMint: d.address, usdcMint: e.address, stockVault: f.address, usdcVault: g.address }
  const sw = swapIx(program.address, keys, trader, a.address, b.address, c.address, 0, 1_000_000n, 7n)
  assert.equal(sw.accounts!.length, 13)
  assert.equal(sw.data![0], 5)
  assert.equal(new DataView(sw.data!.buffer).getBigUint64(2, true), 1_000_000n)
  assert.equal(new DataView(sw.data!.buffer).getBigUint64(10, true), 7n)
  assert.equal(sw.accounts![10].address, c.address) // credential slot
  const iv = await initVenueIx(program.address, admin, {
    gate: GATE_SAS, heartbeatMaxAge: 180n, cutoff: 28_800n, relay: a.address, dataAuthority: b.address,
    credentialIssuer: c.address, sasCredential: d.address, sasSchema: e.address, affiliateGroup: f.address,
  })
  assert.equal(iv.data!.length, 1 + 17 + 6 * 32)
  assert.equal(iv.data![1], GATE_SAS)
})

test("retries: only transient, pre-execution RPC failures are retried", async () => {
  assert.equal(isTransient(new Error('Internal error: "Failed to fetch accounts from remote: error sending request"')), true)
  assert.equal(isTransient(new TypeError("Cannot destructure property 'err' of 'data' as it is undefined.")), true)
  assert.equal(isTransient(new Error("HTTP error (429): Too Many Requests")), true)
  assert.equal(isTransient(new Error('transaction abc failed: {"InstructionError":[0,{"Custom":6000}]}')), false)
  assert.equal(isTransient(new Error("transaction abc not confirmed within 90s")), false)
  let calls = 0
  const value = await withRetry(async () => { if (++calls < 3) throw new Error("fetch failed"); return "ok" }, 5, 1)
  assert.equal(value, "ok")
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(withRetry(async () => { calls++; throw new Error("custom program error: 0x1770") }, 5, 1))
  assert.equal(calls, 1)
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { address, getCompiledTransactionMessageEncoder, getTransactionEncoder,
  type SignatureBytes, type SignaturesMap, type TransactionMessageBytes } from "@solana/kit"
import { createRpcGateway } from "./rpc.js"

const call = (method: string, params: unknown[] = [], id: string | number = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params })
const BLOCKHASH = "ApJQizj29Wmh1uqQrdTxaagAFcFJJGJXEcZp16s1dQpj"
const wireFor = (blockhash: string) => {
  const payer = address("11111111111111111111111111111111")
  const messageBytes = getCompiledTransactionMessageEncoder().encode({ version: 0,
    header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 0 },
    staticAccounts: [payer], lifetimeToken: blockhash, instructions: [] })
  return Buffer.from(getTransactionEncoder().encode({ messageBytes: messageBytes as TransactionMessageBytes,
    signatures: { [payer]: new Uint8Array(64) as SignatureBytes } as SignaturesMap })).toString("base64")
}

test("RPC gateway allows only bounded Solana methods and signed wire transactions", async () => {
  let calls = 0
  const gateway = createRpcGateway({ primary: "https://primary.example", fetchImpl: async () => {
    calls++
    return Response.json({ jsonrpc: "2.0", id: 1, result: "ok" })
  } })
  for (const body of ["bad JSON", call("getProgramAccounts", []), call("requestAirdrop", ["x"]),
    call("sendTransaction", ["not signed!" ]), call("getMultipleAccounts", [Array(101).fill("key")])]) {
    const response = await gateway(body)
    assert.equal(response.status, 400)
    assert.deepEqual(response.body, { error: "invalid JSON-RPC request", code: "invalid_rpc" })
  }
  assert.equal(calls, 0)
  assert.equal((await gateway(call("sendTransaction", ["AQID"]))).status, 200)
  assert.equal(calls, 1)
})

test("account reads cache briefly by method and params, then a send invalidates them", async () => {
  let now = 100
  let calls = 0
  const gateway = createRpcGateway({ primary: "https://primary.example", now: () => now, fetchImpl: async (_url, init) => {
    calls++
    const request = JSON.parse(String(init?.body))
    return Response.json({ jsonrpc: "2.0", id: request.id, result: calls })
  } })
  assert.deepEqual((await gateway(call("getAccountInfo", ["account"], 1))).body, { jsonrpc: "2.0", id: 1, result: 1 })
  assert.deepEqual((await gateway(call("getAccountInfo", ["account"], 2))).body, { jsonrpc: "2.0", id: 2, result: 1 })
  assert.equal(calls, 1)
  now += 3_001
  await gateway(call("getAccountInfo", ["account"]))
  assert.equal(calls, 2)
  await gateway(call("sendTransaction", ["AQID"]))
  await gateway(call("getAccountInfo", ["account"]))
  assert.equal(calls, 4)
})

test("primary outage falls back, double outage is sanitized, and RPC errors are not cached", async () => {
  const urls: string[] = []
  const gateway = createRpcGateway({ primary: "https://primary.example", fallbacks: ["https://fallback.example"],
    fetchImpl: async (url, init) => {
      urls.push(String(url))
      if (String(url).includes("primary")) return new Response("key hidden in private failure", { status: 503 })
      const request = JSON.parse(String(init?.body))
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { value: 7 } })
    } })
  const response = await gateway(call("getBalance", ["account"]))
  assert.deepEqual(response.body, { jsonrpc: "2.0", id: 1, result: { value: 7 } })
  assert.deepEqual(urls, ["https://primary.example", "https://fallback.example"])
  const failed = createRpcGateway({ primary: "https://primary.example", fallbacks: ["https://fallback.example"],
    sleep: async () => {}, random: () => 0, fetchImpl: async () => new Response("private failure", { status: 429 }) })
  assert.deepEqual(await failed(call("getBalance", ["account"])),
    { status: 503, body: { error: "devnet RPC is unavailable", code: "rpc_unavailable" } })
})

test("50 identical concurrent reads use one upstream request and preserve caller ids", async () => {
  let calls = 0
  const gateway = createRpcGateway({ primary: "https://primary.example", fetchImpl: async (_url, init) => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 20))
    const request = JSON.parse(String(init?.body))
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { value: 42 } })
  } })
  const results = await Promise.all(Array.from({ length: 50 }, (_, id) => gateway(call("getAccountInfo", ["account"], id))))
  assert.equal(calls, 1)
  results.forEach((response, id) => assert.deepEqual(response, { status: 200, body: { jsonrpc: "2.0", id, result: { value: 42 } } }))
})

test("429 receives one jittered backoff and a confirmed transaction is cached permanently", async () => {
  let calls = 0
  let clock = 0
  const waits: number[] = []
  const gateway = createRpcGateway({ primary: "https://primary.example", now: () => clock, random: () => 0,
    sleep: async (ms) => { waits.push(ms) }, fetchImpl: async (_url, init) => {
      calls++
      if (calls < 2) return new Response("rate limited", { status: 429 })
      const request = JSON.parse(String(init?.body))
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { slot: 10 } })
    } })
  const request = call("getTransaction", ["signature", { commitment: "confirmed" }])
  assert.equal((await gateway(request)).status, 200)
  clock = 10_000_000
  assert.equal((await gateway(request)).status, 200)
  assert.equal(calls, 2)
  assert.deepEqual(waits, [150])
})

test("two primary 429 responses fail over after one backoff", async () => {
  const urls: string[] = []
  const waits: number[] = []
  const gateway = createRpcGateway({ primary: "https://keyed.example", fallbacks: ["https://public.example"],
    sleep: async (ms) => { waits.push(ms) }, random: () => 0, fetchImpl: async (url, init) => {
      urls.push(String(url))
      if (String(url).includes("keyed")) return new Response("rate limited", { status: 429 })
      const request = JSON.parse(String(init?.body))
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { value: 7 } })
    } })
  assert.deepEqual(await gateway(call("getAccountInfo", ["account"])),
    { status: 200, body: { jsonrpc: "2.0", id: 1, result: { value: 7 } } })
  assert.deepEqual(urls, ["https://keyed.example", "https://keyed.example", "https://public.example"])
  assert.deepEqual(waits, [150])
})

test("Free-tier getProgramAccounts limitation falls back and caches for 20 seconds", async () => {
  let now = 0
  const urls: string[] = []
  const gateway = createRpcGateway({ primary: "https://primary.example", fallbacks: ["https://fallback.example"], now: () => now,
    fetchImpl: async (url, init) => {
      urls.push(String(url))
      const request = JSON.parse(String(init?.body))
      if (String(url).includes("primary")) return Response.json({ jsonrpc: "2.0", id: request.id,
        error: { code: -32601, message: "getProgramAccounts is not available on the Free tier" } })
      return Response.json({ jsonrpc: "2.0", id: request.id, result: [{ pubkey: "account" }] })
    } })
  const request = call("getProgramAccounts", ["program"])
  assert.equal((await gateway(request)).status, 200)
  now = 19_000
  await gateway(request)
  assert.equal(urls.length, 2)
  now = 21_000
  await gateway(request)
  assert.equal(urls.length, 4)
})

test("blockhash is never cached and signed send stays on its issuing upstream", async () => {
  const calls: { url: string; method: string; commitment?: string }[] = []
  const gateway = createRpcGateway({ primary: "https://keyed.example", fallbacks: ["https://public.example"],
    sleep: async () => {}, random: () => 0, fetchImpl: async (url, init) => {
      const request = JSON.parse(String(init?.body))
      calls.push({ url: String(url), method: request.method, commitment: request.params[1]?.preflightCommitment })
      if (String(url).includes("keyed") && request.method === "getLatestBlockhash") {
        return new Response("limited", { status: 429 })
      }
      const result = request.method === "getLatestBlockhash"
        ? { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }
        : request.method === "sendTransaction" ? "signature" : { value: true }
      return Response.json({ jsonrpc: "2.0", id: request.id, result })
    } })
  await gateway(call("getLatestBlockhash", [{ commitment: "confirmed" }]))
  await gateway(call("getLatestBlockhash", [{ commitment: "confirmed" }]))
  const sent = await gateway(call("sendTransaction", [wireFor(BLOCKHASH), { encoding: "base64", preflightCommitment: "processed" }]))
  assert.deepEqual(sent.body, { jsonrpc: "2.0", id: 1, result: "signature" })
  assert.deepEqual(calls.map((item) => [item.url, item.method]), [
    ["https://keyed.example", "getLatestBlockhash"], ["https://keyed.example", "getLatestBlockhash"],
    ["https://public.example", "getLatestBlockhash"],
    ["https://keyed.example", "getLatestBlockhash"], ["https://keyed.example", "getLatestBlockhash"],
    ["https://public.example", "getLatestBlockhash"],
    ["https://public.example", "sendTransaction"],
  ])
  assert.equal(calls.at(-1)?.commitment, "confirmed")
})

test("Blockhash not found retries signed wire once after one second, then on other upstream", async () => {
  const calls: string[] = []
  const waits: number[] = []
  const gateway = createRpcGateway({ primary: "https://keyed.example", fallbacks: ["https://public.example"],
    sleep: async (ms) => { waits.push(ms) }, fetchImpl: async (url, init) => {
      const request = JSON.parse(String(init?.body))
      calls.push(`${String(url)}:${request.method}`)
      if (request.method === "getLatestBlockhash") return Response.json({ jsonrpc: "2.0", id: request.id,
        result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } } })
      if (String(url).includes("keyed")) return Response.json({ jsonrpc: "2.0", id: request.id,
        error: { code: -32002, message: "Transaction simulation failed: Blockhash not found" } })
      return Response.json({ jsonrpc: "2.0", id: request.id, result: "signature" })
    } })
  await gateway(call("getLatestBlockhash", [{ commitment: "confirmed" }]))
  const sent = await gateway(call("sendTransaction", [wireFor(BLOCKHASH), { encoding: "base64" }]))
  assert.deepEqual(sent.body, { jsonrpc: "2.0", id: 1, result: "signature" })
  assert.deepEqual(calls, ["https://keyed.example:getLatestBlockhash", "https://keyed.example:sendTransaction",
    "https://keyed.example:sendTransaction", "https://public.example:sendTransaction"])
  assert.deepEqual(waits, [1_000])
})

test("isBlockhashValid reads are never cached", async () => {
  let calls = 0
  const gateway = createRpcGateway({ primary: "https://keyed.example", fetchImpl: async (_url, init) => {
    calls++
    const request = JSON.parse(String(init?.body))
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { value: true } })
  } })
  await gateway(call("isBlockhashValid", [BLOCKHASH]))
  await gateway(call("isBlockhashValid", [BLOCKHASH]))
  assert.equal(calls, 2)
})

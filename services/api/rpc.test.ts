import assert from "node:assert/strict"
import { test } from "node:test"
import { createRpcGateway } from "./rpc.js"

const call = (method: string, params: unknown[] = [], id: string | number = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params })

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

test("429 receives jittered backoff and a confirmed transaction is cached permanently", async () => {
  let calls = 0
  let clock = 0
  const waits: number[] = []
  const gateway = createRpcGateway({ primary: "https://primary.example", now: () => clock, random: () => 0,
    sleep: async (ms) => { waits.push(ms) }, fetchImpl: async (_url, init) => {
      calls++
      if (calls < 3) return new Response("rate limited", { status: 429 })
      const request = JSON.parse(String(init?.body))
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { slot: 10 } })
    } })
  const request = call("getTransaction", ["signature", { commitment: "confirmed" }])
  assert.equal((await gateway(request)).status, 200)
  clock = 10_000_000
  assert.equal((await gateway(request)).status, 200)
  assert.equal(calls, 3)
  assert.deepEqual(waits, [150, 300])
})

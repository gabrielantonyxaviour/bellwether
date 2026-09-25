import assert from "node:assert/strict"
import { test } from "node:test"
import { createIndexerRpc } from "./rpc.js"

test("indexer uses public fallback only for Free-tier getProgramAccounts refusal", async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    urls.push(url)
    const request = JSON.parse(String(init?.body))
    if (url.includes("keyed")) return Response.json({ jsonrpc: "2.0", id: request.id,
      error: { code: -32601, message: "getProgramAccounts is not available on the Free tier" } })
    return Response.json({ jsonrpc: "2.0", id: request.id,
      result: [{ pubkey: "account", account: { data: ["AQID", "base64"] } }] })
  }
  try {
    const rpc = createIndexerRpc("https://keyed.example", { fallbackUrl: "https://public.example", retries: 0 })
    assert.deepEqual(await rpc.programAccounts("program", []), [{ pubkey: "account", data: Uint8Array.from([1, 2, 3]) }])
    assert.deepEqual(urls, ["https://keyed.example", "https://public.example"])
  } finally { globalThis.fetch = original }
})

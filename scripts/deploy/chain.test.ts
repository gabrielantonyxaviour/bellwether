import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { generateKeyPairSigner } from "@solana/kit"
import { createDeploymentChain } from "./chain.js"

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"

test("deployment sender retries only the upstream account-fetch rejection and keeps the signed wire", async () => {
  let sendCalls = 0
  const wires: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params?: string[] }
    let result: unknown
    let error: { code: number; message: string } | undefined
    if (rpc.method === "getGenesisHash") result = DEVNET_GENESIS
    else if (rpc.method === "getLatestBlockhash") result = {
      context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1_000 },
    }
    else if (rpc.method === "sendTransaction") {
      sendCalls++
      wires.push(rpc.params?.[0] ?? "")
      error = { code: -32002, message: sendCalls === 1
        ? "Failed to fetch accounts from remote: error sending request"
        : "insufficient funds for fee" }
    } else throw new Error(`unexpected RPC method ${rpc.method}`)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...(error ? { error } : { result }) }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert(address && typeof address !== "string")
    const chain = createDeploymentChain(`http://127.0.0.1:${address.port}`)
    assert.equal(await chain.rpc.getGenesisHash().send(), DEVNET_GENESIS)
    const payer = await generateKeyPairSigner()
    await assert.rejects(chain.send([], payer), /RPC preflight rejected without simulation data: insufficient funds for fee/)
    assert.equal(sendCalls, 2)
    assert(wires[0] && wires[0] === wires[1], "retry must reuse the signed wire")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

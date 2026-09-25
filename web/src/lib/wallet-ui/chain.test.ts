import { afterEach, describe, expect, it, vi } from "vitest"
import { address } from "@solana/kit"
import { readAccount } from "./chain"

vi.mock("@/lib/cluster", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cluster")>()
  return { ...original, clusterConfig: () => ({ rpcUrl: "https://rpc.example.test" }) }
})

afterEach(() => vi.unstubAllGlobals())

describe("participant chain reads", () => {
  it("retries a rate-limited read and decodes the returned account", async () => {
    const requests: string[] = []
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      requests.push(String(init.body))
      return requests.length === 1 ? new Response(null, { status: 429 }) :
        Response.json({ result: { value: { data: ["AQID", "base64"] } } })
    })
    expect(await readAccount(address("11111111111111111111111111111111"))).toEqual(Uint8Array.from([1, 2, 3]))
    expect(requests).toHaveLength(2)
    expect(requests[1]).toBe(requests[0])
  })

  it("does not retry an invalid account request", async () => {
    let calls = 0
    vi.stubGlobal("fetch", async () => { calls++; return new Response(null, { status: 400 }) })
    await expect(readAccount(address("11111111111111111111111111111111"))).rejects.toThrow("Chain RPC returned HTTP 400")
    expect(calls).toBe(1)
  })
})

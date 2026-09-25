import { describe, expect, it } from "vitest"
import { isRetryableForkSendError, preserveForkSendError, sendForkTransaction } from "./fork-rpc"

describe("fork transaction RPC boundary", () => {
  const request = { method: "sendTransaction" }

  it("retains Surfpool's message when preflight data is absent", () => {
    const response = { error: { code: -32002, message: "Failed to fetch accounts from remote: error sending request" } }
    expect(() => preserveForkSendError(request, response)).toThrow(
      "RPC preflight rejected without simulation data: Failed to fetch accounts from remote: error sending request",
    )
  })

  it("keeps structured program failures for normal decoding", () => {
    const response = { error: { code: -32002, message: "program failed", data: { err: { Custom: 6001 } } } }
    expect(preserveForkSendError(request, response)).toBe(response)
    expect(preserveForkSendError({ method: "getAccountInfo" }, response)).toBe(response)
  })

  it("retries only upstream account fetch failures", () => {
    expect(isRetryableForkSendError(new Error("Failed to fetch accounts from remote"))).toBe(true)
    expect(isRetryableForkSendError(new Error("insufficient funds"))).toBe(false)
    expect(isRetryableForkSendError(new Error("custom program error: 0x1771"))).toBe(false)
  })

  it("resends the same signed wire after an upstream account fetch failure", async () => {
    const original = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = async (_url, init) => {
      requests.push(String(init?.body))
      return Response.json(requests.length === 1
        ? { error: { code: -32002, message: "Failed to fetch accounts from remote: upstream timeout" } }
        : { result: "3sYtTransactionSignature" })
    }
    try {
      expect(await sendForkTransaction("http://127.0.0.1:8970", "signed-wire")).toBe("3sYtTransactionSignature")
      expect(requests).toHaveLength(2)
      expect(requests[1]).toBe(requests[0])
    } finally { globalThis.fetch = original }
  })

  it("surfaces deterministic preflight errors without resending", async () => {
    const original = globalThis.fetch
    let requests = 0
    globalThis.fetch = async () => {
      requests++
      return Response.json({ error: { code: -32002, message: "custom program error: 0x1771" } })
    }
    try {
      await expect(sendForkTransaction("http://127.0.0.1:8970", "signed-wire")).rejects.toThrow("custom program error: 0x1771")
      expect(requests).toBe(1)
    } finally { globalThis.fetch = original }
  })
})

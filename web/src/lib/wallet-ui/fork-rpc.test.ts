import { describe, expect, it } from "vitest"
import { isRetryableForkSendError, preserveForkSendError } from "./fork-rpc"

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
})

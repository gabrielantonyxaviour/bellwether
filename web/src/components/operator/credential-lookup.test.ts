import { describe, expect, it } from "vitest"
import { credentialLookupPhase } from "./credential-lookup"

describe("participant credential lookup", () => {
  it("stays idle when the wallet field is blank, even if a disabled query is pending", () => {
    expect(credentialLookupPhase(null, { isLoading: false, isError: false, hasData: false })).toBe("empty")
    expect(credentialLookupPhase("", { isLoading: false, isError: false, hasData: false })).toBe("empty")
  })

  it("shows the read only while a chosen wallet's request is in flight", () => {
    const wallet = "HaNnXVZYwBW9LkPJEHjyLXVyfWv4tijiwogYvrdhJ3tD"
    expect(credentialLookupPhase(wallet, { isLoading: true, isError: false, hasData: false })).toBe("loading")
    expect(credentialLookupPhase(wallet, { isLoading: false, isError: true, hasData: false })).toBe("error")
    expect(credentialLookupPhase(wallet, { isLoading: false, isError: false, hasData: true })).toBe("result")
  })
})

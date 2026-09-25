import { describe, expect, it } from "vitest"
import { formatUnits, parseUnits } from "@/lib/format"

describe("units", () => {
  it("formats base units exactly", () => {
    expect(formatUnits(1_234_500n, 6)).toBe("1.2345")
    expect(formatUnits(1_000_000n, 6)).toBe("1")
    expect(formatUnits(5n, 6)).toBe("0.000005")
    expect(formatUnits(-1_500_000n, 6)).toBe("-1.5")
    expect(formatUnits(18_446_744_073_709_551_615n, 6)).toBe("18446744073709.551615")
  })

  it("parses decimal input and refuses excess precision", () => {
    expect(parseUnits("1.2345", 6)).toBe(1_234_500n)
    expect(parseUnits(".5", 6)).toBe(500_000n)
    expect(parseUnits("10", 0)).toBe(10n)
    expect(() => parseUnits("1.0000001", 6)).toThrow(RangeError)
    expect(() => parseUnits("", 6)).toThrow(RangeError)
    expect(() => parseUnits("1e3", 6)).toThrow(RangeError)
  })
})

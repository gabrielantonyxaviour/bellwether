import { describe, expect, it } from "vitest"
import { activation, activationLabel, capPercent, sharesUsed, tradeDate } from "./budget"
import { address, type Address } from "@solana/kit"
import type { SymbolRecord } from "@/lib/program"

const ZERO = address("11111111111111111111111111111111") as Address

const DAY = 86_400

function symbol(patch: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    bump: 1, tier: 2, issuerSponsored: false, active: false, halted: false, objected: false, breachCount: 0,
    ticker: "DEMO", haltReason: "", venue: ZERO, mint: ZERO,
    advShares: 0n, capShares: 1_000n, multiplierNum: 1, multiplierDen: 1, tradeDate: 0n, sharesTradedToday: 0n,
    pausedUntil: 0n, lastHeartbeat: 0n, relaySeq: 0n, noticeReceivedAt: 0n, haltedAt: 0n, ...patch,
  }
}

describe("operator rulebook readings", () => {
  it("folds Saturday and Sunday into Friday's trade date", () => {
    expect(tradeDate(2 * DAY + 10, 0)).toBe(1)
    expect(tradeDate(3 * DAY + 10, 0)).toBe(1)
    expect(tradeDate(4 * DAY + 10, 0)).toBe(4)
  })

  it("ignores shares traded on an earlier trade date", () => {
    expect(sharesUsed(symbol({ tradeDate: 1n, sharesTradedToday: 40n }), 4 * DAY, 0)).toBe(0n)
    expect(sharesUsed(symbol({ tradeDate: 4n, sharesTradedToday: 40n }), 4 * DAY, 0)).toBe(40n)
  })

  it("reports cap use and an unset cap", () => {
    expect(capPercent(250n, 1_000n)).toBe(25)
    expect(capPercent(2_000n, 1_000n)).toBe(100)
    expect(capPercent(0n, 0n)).toBeNull()
  })

  it("names the issuer-notice states the symbols page renders", () => {
    const now = 40 * DAY
    expect(activationLabel(activation(symbol({ objected: true, active: true }), now))).toBe("Issuer objected")
    expect(activationLabel(activation(symbol(), now))).toBe("Notice not recorded")
    const running = activation(symbol({ noticeReceivedAt: BigInt(now - DAY) }), now)
    expect(running.kind).toBe("window")
    expect(activationLabel(running)).toMatch(/Notice clock/)
    expect(activationLabel(activation(symbol({ noticeReceivedAt: BigInt(now - 31 * DAY) }), now))).toBe("Eligible to activate")
    expect(activationLabel(activation(symbol({ active: true, issuerSponsored: true }), now))).toBe("Active")
  })
})

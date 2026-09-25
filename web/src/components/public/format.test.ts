import { describe, expect, it } from "vitest"
import { clampUtcDate, formatBps, utcWindow } from "@/components/public/format"
import { solscanUrl } from "@/components/public/records"

describe("public date window", () => {
  const now = new Date("2026-09-25T14:00:00Z")

  it("keeps the picker inside the last 30 UTC days", () => {
    expect(utcWindow(30, now)).toEqual({ min: "2026-08-27", max: "2026-09-25" })
    expect(clampUtcDate("2020-01-01", utcWindow(30, now))).toBe("2026-08-27")
    expect(clampUtcDate("2026-12-01", utcWindow(30, now))).toBe("2026-09-25")
    expect(clampUtcDate("not-a-date", utcWindow(30, now))).toBe("2026-09-25")
  })

  it("keeps 2026-09-25 selectable after that UTC day ends", () => {
    const afterMidnight = new Date("2026-09-26T00:30:00Z")
    const window = utcWindow(35, afterMidnight)
    expect(window.max).toBe("2026-09-26")
    expect(clampUtcDate("2026-09-25", window)).toBe("2026-09-25")
  })
})

describe("public links", () => {
  it("formats a pool fee and a devnet Solscan link", () => {
    expect(formatBps(30)).toBe("0.30%")
    const url = new URL(solscanUrl("devnet", "account", "88chqe41hw9uhqrUK6KfytQ7aZgEGJzcqszXGKJFWfuB"))
    expect(url.searchParams.get("cluster")).toBe("devnet")
    expect(url.pathname).toContain("/account/")
  })

  it("keeps a mainnet account on public Solscan", () => {
    const url = new URL(solscanUrl("mainnet", "token", "7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9"))
    expect(url.searchParams.get("cluster")).toBeNull()
    expect(url.searchParams.has("customUrl")).toBe(false)
    expect(url.hostname).toBe("solscan.io")
  })
})

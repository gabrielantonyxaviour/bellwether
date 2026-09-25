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
})

describe("public links", () => {
  it("formats a pool fee and a devnet Solscan link", () => {
    expect(formatBps(30)).toBe("0.30%")
    const url = new URL(solscanUrl("devnet", "account", "88chqe41hw9uhqrUK6KfytQ7aZgEGJzcqszXGKJFWfuB"))
    expect(url.searchParams.get("cluster")).toBe("devnet")
    expect(url.pathname).toContain("/account/")
  })

  it("points a fork signature at that fork's RPC", () => {
    const url = new URL(solscanUrl("fork", "tx", "sig", "http://127.0.0.1:8960"))
    expect(url.searchParams.get("cluster")).toBe("custom")
    expect(url.searchParams.get("customUrl")).toBe("http://127.0.0.1:8960")
  })
})

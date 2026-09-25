import { isIP } from "node:net"
import type { Context } from "hono"
import { AdmissionError } from "./admission.js"

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 10

/** Bounded, per-process request limiter. An upstream proxy should overwrite cf-connecting-ip. */
export function createRequestLimits(now: () => number = Date.now) {
  const hits = new Map<string, number[]>()
  return {
    check(c: Context, kind: "challenge" | "admit", wallet: string) {
      const claimed = c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? ""
      const ip = isIP(claimed) ? claimed : "unknown"
      const at = now()
      for (const key of [`${kind}:ip:${ip}`, `${kind}:wallet:${wallet}`]) {
        const prior = (hits.get(key) ?? []).filter((time) => time > at - WINDOW_MS)
        if (prior.length >= MAX_PER_WINDOW) throw new AdmissionError("RATE_LIMITED", 429, "Too many admission requests. Try again in one minute.")
      }
      for (const key of [`${kind}:ip:${ip}`, `${kind}:wallet:${wallet}`]) {
        hits.set(key, [...(hits.get(key) ?? []).filter((time) => time > at - WINDOW_MS), at])
      }
      if (hits.size > 20_000) {
        for (const [key, times] of hits) if (times.every((time) => time <= at - WINDOW_MS)) hits.delete(key)
      }
    },
  }
}

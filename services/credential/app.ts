/**
 * HTTP surface (Hono; runs on Node via server.ts, or any Fetch runtime):
 *   GET  /health                 service label, cluster, gate, SAS addresses, SDN list freshness
 *   GET  /admit/challenge?wallet=...  single-use message for wallet signMessage
 *   POST /admit {wallet,message,signature}  verify → screen → credential + thaw
 *   POST /revoke {wallet}        close credential + freeze      (operator bearer token)
 *   GET  /credential/:wallet     status + expiry                (public)
 *   GET  /screening-log          recent screening/credential log (operator bearer token)
 * Inputs are zod-validated; every error is {error, code}.
 */
import { createHash, timingSafeEqual } from "node:crypto"
import { isAddress, type Address } from "@solana/kit"
import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { z } from "zod"
import { AdmissionError, type Admissions } from "./admission.js"
import { createChallenges } from "./challenge.js"
import { createRequestLimits } from "./limits.js"
import { LABEL } from "./labels.js"

const wallet = z.string().trim().refine(isAddress, { message: "wallet must be a base58 Solana address" }).transform((w) => w as Address)
const walletBody = z.object({ wallet }).strict()
const signedBody = z.object({ wallet, message: z.string().min(1).max(500).optional(), signature: z.string().min(1).max(128).optional() }).strict()
const challengeQuery = z.object({ wallet }).strict()
const logQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), wallet: wallet.optional() })

const invalid = (issues: z.core.$ZodIssue[]) => new AdmissionError("INVALID_INPUT", 400, issues.map((i) => i.message).join("; "))

async function jsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new AdmissionError("INVALID_INPUT", 400, "the request body must be JSON")
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw invalid(parsed.error.issues)
  return parsed.data
}

const digest = (s: string) => createHash("sha256").update(s).digest()

export function createApp(admissions: Admissions, opts: { operatorToken: string | null; corsOrigin: string }): Hono {
  const app = new Hono()
  const challenges = createChallenges()
  const limits = createRequestLimits()
  const origins = opts.corsOrigin === "*" ? "*" : opts.corsOrigin.split(",").map((o) => o.trim())
  app.use("*", cors({ origin: origins, allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "authorization"] }))

  app.onError((err, c) => {
    if (err instanceof AdmissionError) return c.json({ error: err.message, code: err.code }, err.status as ContentfulStatusCode)
    process.stderr.write(`[credential] unexpected error on ${c.req.method} ${c.req.path}: ${err instanceof Error ? err.message : String(err)}\n`)
    return c.json({ error: "internal error", code: "INTERNAL" }, 500)
  })
  app.notFound((c) => c.json({ error: "not found", code: "NOT_FOUND" }, 404))

  function operator(c: Context): void {
    if (!opts.operatorToken) throw new AdmissionError("OPERATOR_TOKEN_UNSET", 503, "operator actions are disabled: CREDENTIAL_OPERATOR_TOKEN is not set")
    const given = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")
    if (!given || !timingSafeEqual(digest(given), digest(opts.operatorToken))) {
      throw new AdmissionError("UNAUTHORIZED", 401, "operator token required")
    }
  }

  app.get("/health", (c) => c.json({ ok: true, ...admissions.info() }))

  app.get("/admit/challenge", (c) => {
    const parsed = challengeQuery.safeParse(c.req.query())
    if (!parsed.success) throw invalid(parsed.error.issues)
    limits.check(c, "challenge", parsed.data.wallet)
    c.header("cache-control", "no-store")
    return c.json(challenges.issue(parsed.data.wallet))
  })

  app.post("/admit", async (c) => {
    const asOperator = c.req.header("authorization") !== undefined
    if (asOperator) operator(c)
    if (asOperator) {
      const body = await jsonBody(c, walletBody)
      return c.json(await admissions.admit(body.wallet, { operator: true }))
    }
    const body = await jsonBody(c, signedBody)
    limits.check(c, "admit", body.wallet)
    if (!body.message || !body.signature) throw new AdmissionError("INVALID_PROOF", 401, "Sign a fresh admission challenge with this wallet.")
    challenges.consume(body.wallet, body.message, body.signature)
    return c.json(await admissions.admit(body.wallet))
  })

  app.post("/revoke", async (c) => {
    operator(c)
    const body = await jsonBody(c, walletBody)
    return c.json(await admissions.revoke(body.wallet))
  })

  app.get("/credential/:wallet", async (c) => {
    const parsed = wallet.safeParse(c.req.param("wallet"))
    if (!parsed.success) throw invalid(parsed.error.issues)
    return c.json(await admissions.status(parsed.data))
  })

  app.get("/screening-log", async (c) => {
    operator(c)
    const parsed = logQuery.safeParse(c.req.query())
    if (!parsed.success) throw invalid(parsed.error.issues)
    return c.json({ label: LABEL, entries: await admissions.screeningLog(parsed.data.limit, parsed.data.wallet) })
  })

  return app
}

/**
 * Test admission, not KYC. admit: screen against the OFAC SDN digital-currency list → issue the
 * credential (SAS attestation, expiry now + TTL on the cluster clock) and thaw the wallet's
 * rehearsal-stock account in one transaction. revoke: close the credential and freeze the
 * account again. status: the same verdict the venue's gate will reach.
 */
import type { Address, Instruction, TransactionSigner } from "@solana/kit"
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022"
import { admitInstructions, associatedStockAccount, freezeInstruction } from "../../scripts/assets/thaw.js"
import { errorText, type Chain } from "../../scripts/assets/tx.js"
import { chainNow, fetchRaw, type CredentialBackend, type GateKind } from "./backend.js"
import { LABEL } from "./labels.js"
import type { LogEntry, ScreeningLog } from "./screening-log.js"
import type { Funder, FundingResult } from "./funding.js"
import type { ListInfo, Screening } from "./screening.js"

export type ErrorCode =
  | "INVALID_INPUT" | "SANCTIONED" | "REVOKED" | "SCREENING_UNAVAILABLE" | "NOT_ADMITTED" | "CHAIN_ERROR"
  | "UNAUTHORIZED" | "OPERATOR_TOKEN_UNSET" | "NOT_FOUND" | "INTERNAL"
  | "INVALID_PROOF" | "RATE_LIMITED" | "DAILY_CAP" | "FUNDING_UNAVAILABLE"

export class AdmissionError extends Error {
  /** Internal reason for logs and operators; never serialized into an HTTP response. */
  detail?: string
  constructor(readonly code: ErrorCode, readonly status: 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503, message: string, detail?: string) {
    super(message)
    this.detail = detail
  }
}

export type StockState = "frozen" | "thawed" | "missing"
export interface StockAccount { address: Address; state: StockState }
interface CredentialRef { kind: GateKind; address: Address }

export interface AdmitResult {
  label: typeof LABEL
  wallet: Address
  status: "admitted"
  alreadyAdmitted: boolean
  expiresAt: string
  expiresAtUnix: number
  credential: CredentialRef
  stockAccount: StockAccount
  signature: string | null
  funding: FundingResult | null
}

export interface RevokeResult { label: typeof LABEL; wallet: Address; status: "revoked"; signature: string }

export interface CredentialStatus {
  label: typeof LABEL
  wallet: Address
  cluster: string
  gate: GateKind
  status: "admitted" | "expired" | "revoked" | "not_admitted"
  admitted: boolean
  expiresAt: string | null
  expiresAtUnix: number | null
  credential: CredentialRef
  stockAccount: StockAccount
  admissionSignature: string | null
  lastScreening: { at: string; event: string; result?: string } | null
}

export interface ServiceInfo {
  label: typeof LABEL
  cluster: string
  gate: GateKind
  credential: Record<string, string>
  stockMint?: Address
  freezeAuthority?: Address
  sdn?: ListInfo | null
}

export interface Admissions {
  info(): ServiceInfo
  /** Loads the SDN list and performs the one-time issuer setup. */
  ready(): Promise<void>
  /** A revoked wallet is re-admitted only by the operator; screening always applies. */
  admit(wallet: Address, opts?: { operator?: boolean }): Promise<AdmitResult>
  revoke(wallet: Address): Promise<RevokeResult>
  status(wallet: Address): Promise<CredentialStatus>
  screeningLog(limit: number, wallet?: Address): Promise<LogEntry[]>
}

export interface AdmissionDeps {
  cluster: string
  chain: Chain
  payer: TransactionSigner
  freezeAuthority: TransactionSigner
  stockMint: Address
  backend: CredentialBackend
  screening: Screening
  log: ScreeningLog
  ttlSeconds: bigint
  dailyCap: number | null
  funder?: Funder
}

const iso = (unix: bigint) => new Date(Number(unix) * 1000).toISOString()

export function createAdmissions(d: AdmissionDeps): Admissions {
  const locks = new Map<string, Promise<unknown>>()
  let admissionTail: Promise<unknown> = Promise.resolve()
  /** One operation per wallet at a time (two admits would race for the same attestation PDA). */
  function serial<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(wallet) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => {})
    locks.set(wallet, tail)
    void tail.then(() => { if (locks.get(wallet) === tail) locks.delete(wallet) })
    return run
  }

  async function stockAccount(wallet: Address): Promise<StockAccount> {
    const address = await associatedStockAccount(wallet, d.stockMint)
    const raw = await fetchRaw(d.chain.rpc, address)
    if (!raw || raw.owner !== TOKEN_2022_PROGRAM_ADDRESS || raw.data.length < 165) return { address, state: "missing" }
    return { address, state: raw.data[108] === AccountState.Frozen ? "frozen" : "thawed" }
  }

  async function send(wallet: Address, what: string, instructions: Instruction[]): Promise<string> {
    try {
      return await d.chain.send(instructions, d.payer)
    } catch (error) {
      const reason = errorText(error).slice(0, 2_000)
      d.log.append({ wallet, event: "error", step: what, reason })
      throw new AdmissionError("CHAIN_ERROR", 502, `the ${what} transaction failed; nothing was admitted or changed`, reason)
    }
  }

  async function ready(): Promise<void> {
    try {
      await d.backend.ensureReady()
    } catch (error) {
      const reason = errorText(error).slice(0, 2_000)
      d.log.append({ wallet: "-", event: "error", step: "issuer setup", reason })
      throw new AdmissionError("CHAIN_ERROR", 502, "the credential issuer is not set up on this cluster", reason)
    }
  }

  return {
    info: () => ({
      label: LABEL, cluster: d.cluster, gate: d.backend.kind, credential: d.backend.describe(),
      stockMint: d.stockMint, freezeAuthority: d.freezeAuthority.address, sdn: d.screening.info(),
    }),

    async ready() {
      await d.screening.screen("11111111111111111111111111111111")
      await ready()
    },

    admit: (wallet, opts = {}) => {
      const result = admissionTail.then(() => serial(wallet, async () => {
      if (!opts.operator && d.log.lastCredentialEvent(wallet)?.event === "revoked") {
        throw new AdmissionError("REVOKED", 403, "This wallet's test admission was revoked by the venue operator. Only the operator can re-admit it.")
      }
      let screen
      try {
        screen = await d.screening.screen(wallet)
      } catch (error) {
        d.log.append({ wallet, event: "screened", result: "unavailable", reason: errorText(error).slice(0, 500) })
        throw new AdmissionError("SCREENING_UNAVAILABLE", 503, "The OFAC SDN list could not be loaded, so admission is closed until it can be.")
      }
      if (screen.match) {
        d.log.append({ wallet, event: "screened", result: "sanctioned", match: screen.match, list: screen.list })
        process.stderr.write(`[credential] refused ${wallet}: OFAC SDN match (${screen.match.currency}, entry ${screen.match.uid})\n`)
        throw new AdmissionError("SANCTIONED", 403, "This wallet matches an address on the OFAC SDN list. Test admission refused.")
      }
      d.log.append({ wallet, event: "screened", result: "clear", list: screen.list })

      if (d.dailyCap !== null && d.log.lastCredentialEvent(wallet)?.event !== "admitted") {
        const today = new Date().toISOString().slice(0, 10)
        const issuedToday = d.log.recent(Number.MAX_SAFE_INTEGER).filter((entry) =>
          entry.event === "admitted" && entry.at.slice(0, 10) === today && typeof entry.signature === "string",
        ).length
        if (issuedToday >= d.dailyCap) throw new AdmissionError("DAILY_CAP", 429, "The daily test-admission limit has been reached.")
      }

      await ready()
      const [now, existing, stock] = await Promise.all([chainNow(d.chain.rpc), d.backend.read(wallet), stockAccount(wallet)])
      const valid = existing.exists && existing.expiresAt !== null && existing.expiresAt !== 0n && existing.expiresAt > now
      const instructions: Instruction[] = []
      let expiresAt = existing.expiresAt ?? 0n
      if (!valid) {
        // An expired SAS attestation occupies the PDA: close it first (membership renews in place).
        if (existing.exists && d.backend.kind === "sas") await send(wallet, "expired-credential close", await d.backend.revokeInstructions(wallet))
        expiresAt = now + d.ttlSeconds
        instructions.push(...await d.backend.issueInstructions(wallet, expiresAt))
      }
      if (stock.state !== "thawed") {
        const thaw = await admitInstructions({ payer: d.payer, owner: wallet, mint: d.stockMint, freezeAuthority: d.freezeAuthority })
        instructions.push(...thaw.instructions)
      }
      if (instructions.length > 0 && d.dailyCap !== null) {
        const today = new Date().toISOString().slice(0, 10)
        const issuedToday = d.log.recent(Number.MAX_SAFE_INTEGER).filter((entry) =>
          entry.event === "admitted" && entry.at.slice(0, 10) === today && typeof entry.signature === "string",
        ).length
        if (issuedToday >= d.dailyCap) throw new AdmissionError("DAILY_CAP", 429, "The daily test-admission limit has been reached.")
      }
      const signature = instructions.length > 0 ? await send(wallet, "admission", instructions) : null
      const funding = d.funder ? await d.funder.fund(wallet) : null
      d.log.append({ wallet, event: "admitted", credential: existing.address, expiresAt: iso(expiresAt), alreadyAdmitted: valid, byOperator: opts.operator === true, signature })
      return {
        label: LABEL, wallet, status: "admitted", alreadyAdmitted: valid, expiresAt: iso(expiresAt), expiresAtUnix: Number(expiresAt),
        credential: { kind: existing.kind, address: existing.address }, stockAccount: { address: stock.address, state: "thawed" }, signature, funding,
      } satisfies AdmitResult
      }))
      admissionTail = result.catch(() => {})
      return result
    },

    revoke: (wallet) => serial(wallet, async () => {
      const [cred, stock] = await Promise.all([d.backend.read(wallet), stockAccount(wallet)])
      const instructions: Instruction[] = []
      if (cred.exists) instructions.push(...await d.backend.revokeInstructions(wallet))
      if (stock.state === "thawed") instructions.push(freezeInstruction(stock.address, d.stockMint, d.freezeAuthority))
      if (instructions.length === 0) throw new AdmissionError("NOT_ADMITTED", 404, "This wallet holds no credential to revoke.")
      const signature = await send(wallet, "revocation", instructions)
      d.log.append({ wallet, event: "revoked", credential: cred.address, closed: cred.exists, froze: stock.state === "thawed", signature })
      return { label: LABEL, wallet, status: "revoked", signature }
    }),

    async status(wallet) {
      const [now, cred, stock] = await Promise.all([chainNow(d.chain.rpc), d.backend.read(wallet), stockAccount(wallet)])
      const last = d.log.lastFor(wallet)
      const live = cred.exists && cred.expiresAt !== null && cred.expiresAt !== 0n && cred.expiresAt > now
      const revoked = d.log.lastCredentialEvent(wallet)?.event === "revoked"
      const status = cred.exists ? (live ? "admitted" : "expired") : revoked ? "revoked" : "not_admitted"
      return {
        label: LABEL, wallet, cluster: d.cluster, gate: d.backend.kind, status, admitted: live,
        expiresAt: cred.expiresAt !== null ? iso(cred.expiresAt) : null, expiresAtUnix: cred.expiresAt !== null ? Number(cred.expiresAt) : null,
        credential: { kind: cred.kind, address: cred.address }, stockAccount: stock,
        admissionSignature: status === "admitted" ? d.log.lastAdmissionSignature(wallet) : null,
        lastScreening: last ? { at: last.at, event: last.event, ...(last.result ? { result: last.result } : {}) } : null,
      }
    },

    async screeningLog(limit, wallet) {
      return d.log.recent(limit, wallet)
    },
  }
}

/**
 * The credential a wallet is admitted by, behind one interface: a SAS attestation (default)
 * or the venue's membership PDA (fallback, CREDENTIAL_GATE=membership). Plus the few raw
 * chain reads both need.
 */
import { getBase64Encoder, type Address, type Instruction } from "@solana/kit"
import type { Rpc } from "../../scripts/assets/tx.js"
import { withRetry } from "./retry.js"

export type GateKind = "sas" | "membership"

export interface CredentialRecord {
  kind: GateKind
  /** The account the swap's `credential` slot must name for this wallet. */
  address: Address
  exists: boolean
  /** Unix seconds; null when there is no credential. */
  expiresAt: bigint | null
}

export interface CredentialBackend {
  kind: GateKind
  /** Addresses worth showing (credential/schema or program/venue). */
  describe(): Record<string, string>
  /** One-time issuer setup (idempotent). */
  ensureReady(): Promise<void>
  read(wallet: Address): Promise<CredentialRecord>
  issueInstructions(wallet: Address, expiresAt: bigint): Promise<Instruction[]>
  revokeInstructions(wallet: Address): Promise<Instruction[]>
}

export interface RawAccount {
  owner: Address
  lamports: bigint
  data: Uint8Array
}

export async function fetchRaw(rpc: Rpc, address: Address): Promise<RawAccount | null> {
  const { value } = await withRetry(() => rpc.getAccountInfo(address, { encoding: "base64", commitment: "confirmed" }).send())
  if (!value) return null
  return { owner: value.owner, lamports: BigInt(value.lamports), data: Uint8Array.from(getBase64Encoder().encode(value.data[0])) }
}

const CLOCK = "SysvarC1ock11111111111111111111111111111111" as Address

/** The cluster's own clock (unix_timestamp at offset 32) — the one the venue and SAS compare against. */
export async function chainNow(rpc: Rpc): Promise<bigint> {
  const clock = await fetchRaw(rpc, CLOCK)
  if (!clock || clock.data.length < 40) throw new Error("Clock sysvar unreadable")
  return new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true)
}

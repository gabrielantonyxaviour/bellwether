/**
 * SAS attestation bytes, read exactly as programs/venue/src/gate.rs reads them:
 * disc(2) | nonce | credential | schema | u32 len | data | signer | i64 expiry | token_account.
 * The service uses this to report status with the same verdict the swap will reach.
 */
import { address, getAddressDecoder, type Address } from "@solana/kit"

export const SAS_PROGRAM_ID = address("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG")

const A_DISC = 2
const A_NONCE = 1
const A_CRED = 33
const A_SCHEMA = 65
const A_LEN = 97
const A_DATA = 101
const A_MIN = 173

export interface ParsedAttestation {
  nonce: Address
  credential: Address
  schema: Address
  data: Uint8Array
  signer: Address
  /** Unix seconds; 0 means "never", which the venue refuses. */
  expiry: bigint
  tokenAccount: Address
}

const key = (d: Uint8Array, o: number): Address => getAddressDecoder().decode(d.subarray(o, o + 32))

export function parseAttestation(d: Uint8Array): ParsedAttestation | null {
  if (d.length < A_MIN || d[0] !== A_DISC) return null
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const len = view.getUint32(A_LEN, true)
  const signerAt = A_DATA + len
  const expiryAt = signerAt + 32
  if (d.length < expiryAt + 8 + 32) return null
  return {
    nonce: key(d, A_NONCE),
    credential: key(d, A_CRED),
    schema: key(d, A_SCHEMA),
    data: d.slice(A_DATA, signerAt),
    signer: key(d, signerAt),
    expiry: view.getBigInt64(expiryAt, true),
    tokenAccount: key(d, expiryAt + 8),
  }
}

/** The byte-level half of the venue gate (owner and PDA checks need the account itself). */
export function gateAdmits(
  a: ParsedAttestation | null,
  pinned: { credential: Address; schema: Address; wallet: Address },
  now: bigint,
): boolean {
  return a !== null
    && a.nonce === pinned.wallet
    && a.credential === pinned.credential
    && a.schema === pinned.schema
    && a.expiry !== 0n
    && a.expiry > now
}

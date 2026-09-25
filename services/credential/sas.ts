/**
 * Solana Attestation Service backend (sas-lib 1.0.10). The venue's credential issuer owns one
 * credential and one schema; each admitted wallet gets an attestation at
 * ["attestation", credential, schema, wallet] (nonce = wallet) with a non-zero expiry.
 * Revocation closes the attestation, which the venue gate reads as "not admitted".
 */
import { getAddressEncoder, type Address, type TransactionSigner } from "@solana/kit"
import {
  deriveAttestationPda, deriveCredentialPda, deriveSchemaPda, getCloseAttestationInstruction,
  getCreateAttestationInstruction, getCreateCredentialInstruction, getCreateSchemaInstruction,
} from "sas-lib"
import type { Chain } from "../../scripts/assets/tx.js"
import { SAS_PROGRAM_ID, parseAttestation } from "./attestation.js"
import { fetchRaw, type CredentialBackend, type CredentialRecord } from "./backend.js"
import { SAS_NAMES } from "./labels.js"

export interface SasIdentity {
  issuer: Address
  credential: Address
  schema: Address
}

/** Deterministic on every cluster: PDAs of the issuer key and the fixed names. */
export async function sasIdentity(issuer: Address): Promise<SasIdentity> {
  const [credential] = await deriveCredentialPda({ authority: issuer, name: SAS_NAMES.credential })
  const [schema] = await deriveSchemaPda({ credential, name: SAS_NAMES.schema, version: SAS_NAMES.schemaVersion })
  return { issuer, credential, schema }
}

export async function attestationAddress(id: SasIdentity, wallet: Address): Promise<Address> {
  return (await deriveAttestationPda({ credential: id.credential, schema: id.schema, nonce: wallet }))[0]
}

/** Credential = disc 0 | authority | name: u32 len + bytes | signers: u32 n + n × 32. */
function credentialSigners(d: Uint8Array): Uint8Array[] {
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const nameLen = view.getUint32(33, true)
  const at = 37 + nameLen
  const n = view.getUint32(at, true)
  return Array.from({ length: n }, (_v, i) => d.subarray(at + 4 + i * 32, at + 36 + i * 32))
}

export function sasBackend(opts: {
  chain: Chain
  issuer: TransactionSigner
  payer: TransactionSigner
  identity: SasIdentity
  onSetup?: (record: { credential: Address; schema: Address; signature: string | null }) => void
}): CredentialBackend {
  const { chain, issuer, payer, identity } = opts
  let ready: Promise<void> | null = null

  async function setup(): Promise<void> {
    const [cred, schema] = await Promise.all([fetchRaw(chain.rpc, identity.credential), fetchRaw(chain.rpc, identity.schema)])
    if (cred && cred.owner !== SAS_PROGRAM_ID) throw new Error(`SAS credential ${identity.credential} exists but is not owned by SAS`)
    if (cred) {
      const mine = Buffer.from(getAddressEncoder().encode(issuer.address)).toString("hex")
      const signers = credentialSigners(cred.data).map((s) => Buffer.from(s).toString("hex"))
      if (!signers.includes(mine)) throw new Error(`SAS credential ${identity.credential} does not list the issuer ${issuer.address} as a signer`)
    }
    const instructions = []
    if (!cred) {
      instructions.push(getCreateCredentialInstruction({
        payer, credential: identity.credential, authority: issuer, name: SAS_NAMES.credential, signers: [issuer.address],
      }))
    }
    if (!schema) {
      instructions.push(getCreateSchemaInstruction({
        payer, authority: issuer, credential: identity.credential, schema: identity.schema, name: SAS_NAMES.schema,
        description: SAS_NAMES.schemaDescription, layout: Uint8Array.from(SAS_NAMES.layout), fieldNames: [...SAS_NAMES.fieldNames],
      }))
    }
    const signature = instructions.length > 0 ? await chain.send(instructions, payer) : null
    opts.onSetup?.({ credential: identity.credential, schema: identity.schema, signature })
  }

  return {
    kind: "sas",
    describe: () => ({ program: SAS_PROGRAM_ID, issuer: identity.issuer, credential: identity.credential, schema: identity.schema }),
    ensureReady() {
      ready ??= setup().catch((error) => { ready = null; throw error })
      return ready
    },
    async read(wallet): Promise<CredentialRecord> {
      const address = await attestationAddress(identity, wallet)
      const raw = await fetchRaw(chain.rpc, address)
      const parsed = raw && raw.owner === SAS_PROGRAM_ID ? parseAttestation(raw.data) : null
      return { kind: "sas", address, exists: parsed !== null, expiresAt: parsed ? parsed.expiry : null }
    },
    async issueInstructions(wallet, expiresAt) {
      const attestation = await attestationAddress(identity, wallet)
      return [getCreateAttestationInstruction({
        payer, authority: issuer, credential: identity.credential, schema: identity.schema, attestation,
        nonce: wallet, data: Uint8Array.from(SAS_NAMES.data), expiry: expiresAt,
      })]
    },
    async revokeInstructions(wallet) {
      const attestation = await attestationAddress(identity, wallet)
      return [getCloseAttestationInstruction({ payer, authority: issuer, credential: identity.credential, attestation })]
    },
  }
}

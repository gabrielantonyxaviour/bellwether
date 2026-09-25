/**
 * Membership fallback (CREDENTIAL_GATE=membership): the venue's own PDA ["member", venue,
 * wallet], created or renewed by grant_member (6) and closed by revoke_member (7), both
 * signed by the venue's credential issuer. The venue must have gate flag 2 set to honour it.
 */
import { getAddressDecoder, type Address, type TransactionSigner } from "@solana/kit"
import type { Chain } from "../../scripts/assets/tx.js"
import { fetchRaw, type CredentialBackend, type CredentialRecord } from "./backend.js"
import { GATE_MEMBER, MEMBER_DISC, M_EXPIRES, V_GATE, V_ISSUER, grantMemberIx, memberPda, revokeMemberIx } from "./venue-ix.js"

export function membershipBackend(opts: {
  chain: Chain
  issuer: TransactionSigner
  programId: Address
  venue: Address
}): CredentialBackend {
  const { chain, issuer, programId, venue } = opts
  let ready: Promise<void> | null = null

  async function check(): Promise<void> {
    const v = await fetchRaw(chain.rpc, venue)
    if (!v || v.owner !== programId || v.data[0] !== 1) throw new Error(`venue ${venue} is not a VenueConfig of program ${programId}`)
    const onChainIssuer = getAddressDecoder().decode(v.data.subarray(V_ISSUER, V_ISSUER + 32))
    if (onChainIssuer !== issuer.address) throw new Error(`venue credential issuer is ${onChainIssuer}, not this service's issuer ${issuer.address}`)
    if ((v.data[V_GATE] & GATE_MEMBER) === 0) throw new Error(`venue ${venue} does not accept membership credentials (gate flags ${v.data[V_GATE]})`)
  }

  return {
    kind: "membership",
    describe: () => ({ program: programId, venue, issuer: issuer.address }),
    ensureReady() {
      ready ??= check().catch((error) => { ready = null; throw error })
      return ready
    },
    async read(wallet): Promise<CredentialRecord> {
      const address = await memberPda(programId, venue, wallet)
      const raw = await fetchRaw(chain.rpc, address)
      const ok = raw !== null && raw.owner === programId && raw.data.length >= 80 && raw.data[0] === MEMBER_DISC
      const expiresAt = ok ? new DataView(raw.data.buffer, raw.data.byteOffset).getBigInt64(M_EXPIRES, true) : null
      return { kind: "membership", address, exists: ok, expiresAt }
    },
    async issueInstructions(wallet, expiresAt) {
      return [await grantMemberIx(programId, issuer, venue, wallet, expiresAt)]
    },
    async revokeInstructions(wallet) {
      return [await revokeMemberIx(programId, issuer, venue, wallet)]
    },
  }
}

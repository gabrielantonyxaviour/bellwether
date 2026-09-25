/** Single-use proof that the requesting wallet controls its Ed25519 key. */
import { createPublicKey, randomBytes, verify } from "node:crypto"
import { getBase58Encoder, type Address } from "@solana/kit"
import { AdmissionError } from "./admission.js"

const TTL_MS = 5 * 60_000
const MAX_PENDING = 10_000
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const base58 = getBase58Encoder()

export interface Challenge { wallet: Address; message: string; expiresAt: string; expiresAtUnix: number }

export function createChallenges(now: () => number = Date.now) {
  const pending = new Map<string, Challenge>()

  function prune() {
    for (const [wallet, challenge] of pending) {
      if (Date.parse(challenge.expiresAt) <= now()) pending.delete(wallet)
    }
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!)
  }

  return {
    issue(wallet: Address): Challenge {
      prune()
      const expiresAt = new Date(now() + TTL_MS).toISOString()
      const nonce = randomBytes(32).toString("base64url")
      const message = `Bellwether test admission\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${expiresAt}\n\nSign this message to request test admission. No transaction or fee.`
      const challenge = { wallet, message, expiresAt, expiresAtUnix: Math.floor(Date.parse(expiresAt) / 1000) }
      pending.set(wallet, challenge)
      return challenge
    },
    consume(wallet: Address, message: string, signature: string): void {
      const challenge = pending.get(wallet)
      if (!challenge || Date.parse(challenge.expiresAt) <= now()) {
        pending.delete(wallet)
        throw new AdmissionError("INVALID_PROOF", 401, "Admission challenge expired or already used. Request a new challenge.")
      }
      if (message !== challenge.message) throw new AdmissionError("INVALID_PROOF", 401, "The admission challenge does not match the latest one for this wallet.")
      let bytes: Buffer
      if (/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
        bytes = Buffer.from(signature, "base64")
        if (bytes.toString("base64") !== signature) throw new AdmissionError("INVALID_PROOF", 401, "Invalid wallet signature encoding.")
      } else if (/^[1-9A-HJ-NP-Za-km-z]{86,90}$/.test(signature)) {
        bytes = Buffer.from(base58.encode(signature))
      } else {
        throw new AdmissionError("INVALID_PROOF", 401, "The wallet signature must be base64 or base58 encoded.")
      }
      if (bytes.length !== 64) throw new AdmissionError("INVALID_PROOF", 401, "The wallet signature must contain 64 bytes.")
      const publicKeyBytes = base58.encode(wallet)
      const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]), format: "der", type: "spki" })
      if (!verify(null, Buffer.from(message, "utf8"), publicKey, bytes)) {
        throw new AdmissionError("INVALID_PROOF", 401, "The wallet signature does not verify for this challenge.")
      }
      pending.delete(wallet)
    },
  }
}

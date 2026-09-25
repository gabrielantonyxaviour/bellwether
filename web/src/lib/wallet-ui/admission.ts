import { SolanaSignMessage, type SolanaSignMessageFeature } from "@solana/wallet-standard-features"
import { getWallets } from "@wallet-standard/app"
import type { Wallet } from "@wallet-standard/base"
import { z } from "zod"
import { AdmitResponseSchema, request } from "@/lib/api"
import { clusterConfig } from "@/lib/cluster"

const challengeSchema = z.looseObject({ message: z.string().min(1) })
const signatureSchema = z.instanceof(Uint8Array)

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function signingWallet(name: string | null, address: string): Wallet & { features: SolanaSignMessageFeature } {
  const wallet = getWallets().get().find((candidate) => candidate.name === name && candidate.accounts.some((a) => a.address === address))
  if (!wallet || !(SolanaSignMessage in wallet.features)) throw new Error("This wallet cannot sign the admission challenge")
  return wallet as Wallet & { features: SolanaSignMessageFeature }
}

/** The issuer owns nonce, expiry and replay protection. The wallet signs only its exact challenge bytes. */
export async function admitWithWallet(name: string | null, address: string, onScreening?: () => void) {
  const base = clusterConfig().credentialApiUrl
  const challenge = await request(base, `/admit/challenge?wallet=${encodeURIComponent(address)}`, challengeSchema)
  const wallet = signingWallet(name, address)
  const account = wallet.accounts.find((item) => item.address === address)
  if (!account) throw new Error("Connected wallet account changed; reconnect and retry")
  const output = await wallet.features[SolanaSignMessage].signMessage({ account, message: new TextEncoder().encode(challenge.message) })
  const signature = signatureSchema.parse(output[0]?.signature)
  onScreening?.()
  return request(base, "/admit", AdmitResponseSchema, {
    method: "POST", body: { wallet: address, message: challenge.message, signature: base64(signature) },
  })
}

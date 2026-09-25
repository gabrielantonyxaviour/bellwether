import { SolanaSignMessage, type SolanaSignMessageFeature } from "@solana/wallet-standard-features"
import { getWallets } from "@wallet-standard/app"
import type { Wallet } from "@wallet-standard/base"
import { api } from "@/lib/api"

function signingWallet(name: string | null, address: string): Wallet & { features: SolanaSignMessageFeature } {
  const wallet = getWallets().get().find((candidate) => candidate.name === name && candidate.accounts.some((a) => a.address === address))
  if (!wallet || !(SolanaSignMessage in wallet.features)) throw new Error("This wallet cannot sign the admission challenge")
  return wallet as Wallet & { features: SolanaSignMessageFeature }
}

/** The issuer owns nonce, expiry and replay protection. The wallet signs only its exact challenge bytes. */
export async function admitWithWallet(name: string | null, address: string, onScreening?: () => void) {
  const wallet = signingWallet(name, address)
  const account = wallet.accounts.find((item) => item.address === address)
  if (!account) throw new Error("Connected wallet account changed; reconnect and retry")
  return api.admit(address, async (message) => {
    const output = await wallet.features[SolanaSignMessage].signMessage({ account, message })
    if (!(output[0]?.signature instanceof Uint8Array)) throw new Error("Wallet did not return an admission signature")
    onScreening?.()
    return output[0].signature
  })
}

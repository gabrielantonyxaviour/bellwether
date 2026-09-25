import { generateKeyPairSigner, getAddressEncoder, type KeyPairSigner } from "@solana/kit"
import type { Page } from "@playwright/test"

const RPC = "https://bellwether-api.larinova.com/rpc"

/** Fresh Wallet Standard signer whose secret remains in the Playwright process. */
export async function installDevnetWallet(page: Page): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner()
  const publicKey = Array.from(getAddressEncoder().encode(signer.address))
  const sign = (bytes: number[]) => crypto.subtle.sign("Ed25519", signer.keyPair.privateKey, Uint8Array.from(bytes))
    .then((result) => Array.from(new Uint8Array(result)))
  await page.exposeFunction("__journeySignMessage", sign)
  await page.exposeFunction("__journeySignTransaction", async (bytes: number[]) => {
    const wire = Uint8Array.from(bytes)
    if (wire[0] !== 1) throw new Error("Journey signer expects one transaction signature")
    wire.set(await sign(Array.from(wire.subarray(65))), 1)
    return Array.from(wire)
  })
  await page.addInitScript(({ walletAddress, publicKeyBytes, rpcUrl }) => {
    const bridge = window as typeof window & {
      __journeySignMessage: (bytes: number[]) => Promise<number[]>
      __journeySignTransaction: (bytes: number[]) => Promise<number[]>
    }
    const account = { address: walletAddress, publicKey: Uint8Array.from(publicKeyBytes), chains: ["solana:devnet"],
      features: ["solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction"] }
    const wallet = { version: "1.0.0", name: "Bellwether journey signer", chains: ["solana:devnet"],
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz48L3N2Zz4=",
      accounts: [account], features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
        "solana:signMessage": { version: "1.0.0", signMessage: async ({ message }: { message: Uint8Array }) =>
          [{ signature: Uint8Array.from(await bridge.__journeySignMessage(Array.from(message))) }] },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: [0],
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(async ({ transaction }) => {
            const signedTransaction = Uint8Array.from(await bridge.__journeySignTransaction(Array.from(transaction)))
            return { signedTransaction }
          })) },
        "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: [0],
          signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(async ({ transaction }) => {
            const signed = Uint8Array.from(await bridge.__journeySignTransaction(Array.from(transaction)))
            const wire = btoa(String.fromCharCode(...signed))
            const response = await fetch(rpcUrl, { method: "POST", headers: {
              "content-type": "application/json", "solana-client": "bellwether-journey",
            }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction",
              params: [wire, { encoding: "base64", preflightCommitment: "confirmed" }] }) })
            const result = await response.json() as { result?: string; error?: { message?: string; data?: unknown } }
            if (!response.ok || !result.result) throw new Error(`Devnet send failed: ${JSON.stringify(result.error ?? response.status)}`)
            return { signature: signed.slice(1, 65) }
          })) },
      } }
    window.addEventListener("wallet-standard:app-ready", (event) => {
      (event as Event & { detail: { register: (wallet: unknown) => void } }).detail.register(wallet)
    })
  }, { walletAddress: signer.address, publicKeyBytes: publicKey, rpcUrl: RPC })
  return signer
}

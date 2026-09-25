import { generateKeyPairSigner, getAddressEncoder, getBase58Encoder, type KeyPairSigner } from "@solana/kit"
import type { Page } from "@playwright/test"

const RPC = "https://api.devnet.solana.com"

/** Fresh Wallet Standard signer whose secret remains in the Playwright process. */
export async function installDevnetWallet(page: Page): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner()
  const publicKey = Array.from(getAddressEncoder().encode(signer.address))
  const sign = (bytes: number[]) => crypto.subtle.sign("Ed25519", signer.keyPair.privateKey, Uint8Array.from(bytes))
    .then((result) => Array.from(new Uint8Array(result)))
  await page.exposeFunction("__journeySignMessage", sign)
  await page.exposeFunction("__journeySignAndSend", async (bytes: number[]) => {
    const wire = Uint8Array.from(bytes)
    if (wire[0] !== 1) throw new Error("Journey signer expects one transaction signature")
    wire.set(await sign(Array.from(wire.subarray(65))), 1)
    const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction",
        params: [Buffer.from(wire).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }] }) })
    const result = await response.json() as { result?: string; error?: { message?: string; data?: unknown } }
    if (!response.ok || !result.result) throw new Error(`Devnet send failed: ${JSON.stringify(result.error ?? response.status)}`)
    return Array.from(getBase58Encoder().encode(result.result))
  })
  await page.addInitScript(({ walletAddress, publicKeyBytes }) => {
    const bridge = window as typeof window & {
      __journeySignMessage: (bytes: number[]) => Promise<number[]>
      __journeySignAndSend: (bytes: number[]) => Promise<number[]>
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
            const wire = new Uint8Array(transaction)
            if (wire[0] !== 1) throw new Error("Journey signer expects one transaction signature")
            wire.set(await bridge.__journeySignMessage(Array.from(wire.subarray(65))), 1)
            return { signedTransaction: wire }
          })) },
        "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: [0],
          signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(async ({ transaction }) =>
            ({ signature: Uint8Array.from(await bridge.__journeySignAndSend(Array.from(transaction))) }))) },
      } }
    window.addEventListener("wallet-standard:app-ready", (event) => {
      (event as Event & { detail: { register: (wallet: unknown) => void } }).detail.register(wallet)
    })
  }, { walletAddress: signer.address, publicKeyBytes: publicKey })
  return signer
}

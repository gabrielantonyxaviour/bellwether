/**
 * A thin wallet layer on Wallet Standard (@wallet-standard/app + @solana/wallet-standard-features).
 * Screens depend only on the BellwetherWallet interface through useWallet(); the provider below
 * is one implementation. Wallet UI (@wallet-ui/react) or ConnectorKit (@solana/connector) can
 * replace it later by providing the same context value; both require @solana/kit 7, which is why
 * web/ pins kit 7.1.1.
 *
 *   const { publicKey, signer, connect } = useWallet()
 *   swapInstruction(market, { owner: signer!, ownerStock, ownerUsdc }, args)   // signer is a kit TransactionSendingSigner
 */
import {
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getTransactionEncoder,
  type Address,
  type Signature,
  type SignatureBytes,
  type Transaction,
  type TransactionSendingSigner,
} from "@solana/kit"
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features"
import { getWallets } from "@wallet-standard/app"
import type { Wallet, WalletAccount } from "@wallet-standard/base"
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { clusterConfig, walletChain } from "@/lib/cluster"
import { sendForkTransaction } from "@/lib/wallet-ui/fork-rpc"

export type WalletStatus = "disconnected" | "connecting" | "connected"

export interface WalletOption {
  name: string
  icon: string
}

/** What every screen may use. Keep this stable: a replacement provider implements exactly this. */
export interface BellwetherWallet {
  wallets: readonly WalletOption[]
  /** Name of the connected (or connecting) wallet. */
  walletName: string | null
  status: WalletStatus
  publicKey: Address | null
  /** kit signer for the connected account; pass as `owner` to the instruction builders. */
  signer: TransactionSendingSigner | null
  connect(name?: string): Promise<void>
  disconnect(): Promise<void>
  /** Sign and send one compiled transaction; resolves with its signature once the wallet submits it. */
  signAndSendTransaction(transaction: Transaction): Promise<Signature>
}

export class WalletError extends Error {}

type SolanaWallet = Wallet & {
  features: StandardConnectFeature &
    SolanaSignAndSendTransactionFeature &
    Partial<StandardDisconnectFeature & StandardEventsFeature & SolanaSignTransactionFeature>
}

const LAST_WALLET_KEY = "bellwether.wallet"
const b58 = getBase58Decoder()
const b58Bytes = getBase58Encoder()
const b64 = getBase64Decoder()
const txEncoder = getTransactionEncoder()

function isSolanaWallet(w: Wallet): w is SolanaWallet {
  return StandardConnect in w.features && SolanaSignAndSendTransaction in w.features && w.chains.some((c) => c.startsWith("solana:"))
}

const registry = typeof window === "undefined" ? null : getWallets()
let snapshot: readonly SolanaWallet[] = registry ? registry.get().filter(isSolanaWallet) : []
function subscribe(onChange: () => void): () => void {
  if (!registry) return () => {}
  const refresh = () => {
    snapshot = registry.get().filter(isSolanaWallet)
    onChange()
  }
  const offs = [registry.on("register", refresh), registry.on("unregister", refresh)]
  return () => offs.forEach((off) => off())
}

const WalletContext = createContext<BellwetherWallet | null>(null)

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallets = useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
  const [wallet, setWallet] = useState<SolanaWallet | null>(null)
  const [account, setAccount] = useState<WalletAccount | null>(null)
  const [status, setStatus] = useState<WalletStatus>("disconnected")
  const autoConnectTried = useRef(false)

  const connectTo = useCallback(async (target: SolanaWallet, silent: boolean) => {
    setWallet(target)
    setStatus("connecting")
    try {
      const { accounts } = await target.features[StandardConnect].connect(silent ? { silent: true } : undefined)
      const first = accounts[0] ?? target.accounts[0] ?? null
      if (!first) throw new WalletError(`${target.name} returned no account`)
      setAccount(first)
      setStatus("connected")
      try { localStorage.setItem(LAST_WALLET_KEY, target.name) } catch { /* storage unavailable */ }
    } catch (error) {
      setWallet(null)
      setAccount(null)
      setStatus("disconnected")
      if (!silent) throw error
    }
  }, [])

  // Reconnect silently to the last wallet once it registers; one attempt per page load.
  useEffect(() => {
    if (autoConnectTried.current || wallet || status !== "disconnected") return
    let last: string | null = null
    try { last = localStorage.getItem(LAST_WALLET_KEY) } catch { /* storage unavailable */ }
    const target = last ? wallets.find((w) => w.name === last) : undefined
    if (!target) return
    autoConnectTried.current = true
    void connectTo(target, true)
  }, [wallets, wallet, status, connectTo])

  // Follow account switches and disconnects made inside the wallet.
  useEffect(() => {
    const events = wallet?.features[StandardEvents]
    if (!events) return
    return events.on("change", ({ accounts }) => {
      if (!accounts) return
      setAccount(accounts[0] ?? null)
      setStatus(accounts[0] ? "connected" : "disconnected")
    })
  }, [wallet])

  const connect = useCallback(async (name?: string) => {
    const target = name ? wallets.find((w) => w.name === name) : wallets[0]
    if (!target) throw new WalletError(name ? `${name} is not installed` : "No Solana wallet found. Install Phantom, Solflare or Backpack.")
    await connectTo(target, false)
  }, [wallets, connectTo])

  const disconnect = useCallback(async () => {
    try { localStorage.removeItem(LAST_WALLET_KEY) } catch { /* storage unavailable */ }
    await wallet?.features[StandardDisconnect]?.disconnect()
    setWallet(null)
    setAccount(null)
    setStatus("disconnected")
  }, [wallet])

  const sendRaw = useCallback(async (transactions: readonly Transaction[]): Promise<SignatureBytes[]> => {
    if (!wallet || !account) throw new WalletError("Connect a wallet first")
    const chain = walletChain()
    // The fork is not a cluster any wallet knows: sign in the wallet, send through our own RPC.
    if (clusterConfig().local) {
      const sign = wallet.features[SolanaSignTransaction]
      if (!sign) throw new WalletError(`${wallet.name} cannot sign without sending, which the local fork needs`)
      const signed = await sign.signTransaction(
        ...transactions.map((tx) => ({ account, chain, transaction: new Uint8Array(txEncoder.encode(tx)) })),
      )
      const sigs: SignatureBytes[] = []
      for (const { signedTransaction } of signed) {
        const wire = b64.decode(signedTransaction)
        const sig = await sendForkTransaction(clusterConfig().rpcUrl, wire)
        sigs.push(b58Bytes.encode(sig) as SignatureBytes)
      }
      return sigs
    }
    const outputs = await wallet.features[SolanaSignAndSendTransaction].signAndSendTransaction(
      ...transactions.map((tx) => ({ account, chain, transaction: new Uint8Array(txEncoder.encode(tx)) })),
    )
    return outputs.map((o) => o.signature as SignatureBytes)
  }, [wallet, account])

  const value = useMemo<BellwetherWallet>(() => {
    const publicKey = account ? (account.address as Address) : null
    return {
      wallets: wallets.map((w) => ({ name: w.name, icon: w.icon })),
      walletName: wallet?.name ?? null,
      status,
      publicKey,
      signer: publicKey ? { address: publicKey, signAndSendTransactions: (txs) => sendRaw(txs) } : null,
      connect,
      disconnect,
      signAndSendTransaction: async (tx) => b58.decode((await sendRaw([tx]))[0]) as Signature,
    }
  }, [wallets, wallet, account, status, connect, disconnect, sendRaw])

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): BellwetherWallet {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error("useWallet() must be used inside <WalletProvider>")
  return ctx
}

/** For a replacement provider (Wallet UI, ConnectorKit): provide this context with a BellwetherWallet. */
export const WalletContextProvider = WalletContext.Provider

/** "7xKX…9fPq" */
export function shortAddress(a: string, chars = 4): string {
  return a.length <= chars * 2 + 1 ? a : `${a.slice(0, chars)}…${a.slice(-chars)}`
}

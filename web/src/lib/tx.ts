/**
 * Transaction lifecycle: review → awaiting signature → pending (explorer link) → confirmed | failed,
 * mirrored in one sonner toast that updates in place (the SolanaUI "Txn Toast" pattern).
 *
 *   const tx = useTransaction("Buy FWDI")
 *   tx.review()                                        // screen shows its review panel
 *   await tx.submit([swapInstruction(...)], signer)    // wallet prompt, toast, confirmation
 *   tx.state.phase, tx.state.signature, tx.state.error // drive inline UI
 */
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type Instruction,
  type Signature,
  type TransactionSendingSigner,
} from "@solana/kit"
import { useCallback, useState } from "react"
import { toast } from "sonner"
import { txnToast } from "@/components/sol/txn-toast"
import { clusterConfig, explorerUrl } from "@/lib/cluster"
import { describeError, toVenueError, type VenueError } from "@/lib/venue/errors"

export type TxPhase = "idle" | "review" | "awaiting-signature" | "pending" | "confirmed" | "failed"

export interface TxState {
  phase: TxPhase
  signature: Signature | null
  explorer: string | null
  /** Plain one-line reason on failure. */
  error: string | null
  /** The venue rejection (NotAdmitted, TradingHalted, …) when the failure was one. */
  venueError: VenueError | null
}

export const IDLE: TxState = { phase: "idle", signature: null, explorer: null, error: null, venueError: null }

export interface SendOptions {
  label: string
  instructions: readonly Instruction[]
  signer: TransactionSendingSigner
  onPhase?: (state: TxState) => void
  /** Give up waiting for confirmation after this long (default 90 s). */
  timeoutMs?: number
  toastVariant?: "standard" | "solana"
  successLink?: { href: string; label: string }
}

const POLL_MS = 1_500

/** Builds, signs, sends and confirms one transaction, keeping one toast current throughout. */
export async function sendTransaction(opts: SendOptions): Promise<TxState> {
  const solanaToast = opts.toastVariant === "solana"
  const toastId = solanaToast
    ? txnToast({ status: "pending", title: `${opts.label} · awaiting signature`, description: "Approve in your wallet" })
    : toast.loading(`${opts.label} · awaiting signature`, { description: "Approve in your wallet" })
  let state: TxState = { ...IDLE, phase: "awaiting-signature" }
  const set = (next: Partial<TxState>) => {
    state = { ...state, ...next }
    opts.onPhase?.(state)
    return state
  }
  set({})

  try {
    const rpc = createSolanaRpc(clusterConfig().rpcUrl)
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(opts.signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(opts.instructions, m),
    )
    const signature = getBase58Decoder().decode(await signAndSendTransactionMessageWithSigners(message)) as Signature
    const explorer = explorerUrl("tx", signature)
    set({ phase: "pending", signature, explorer })
    const view = { label: "View", onClick: () => window.open(explorer, "_blank", "noopener") }
    if (solanaToast) txnToast.update(toastId, { status: "pending", title: `${opts.label} · pending`, signature, explorerUrl: explorer })
    else toast.loading(`${opts.label} · pending`, { id: toastId, description: shortSig(signature), action: view })

    const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
    while (Date.now() < deadline) {
      const { value } = await rpc.getSignatureStatuses([signature]).send()
      const status = value[0]
      if (status?.err) throw status.err
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        if (solanaToast) txnToast.update(toastId, { status: "confirmed", title: `${opts.label} · confirmed`, signature, explorerUrl: explorer,
          secondaryUrl: opts.successLink?.href, secondaryLabel: opts.successLink?.label })
        else toast.success(`${opts.label} · confirmed`, { id: toastId, description: shortSig(signature), action: view })
        return set({ phase: "confirmed" })
      }
      const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send()
      if (height > blockhash.lastValidBlockHeight) throw new Error("Transaction expired before it confirmed")
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    throw new Error("Still unconfirmed after 90 s · check the explorer")
  } catch (error) {
    const venueError = toVenueError(error)
    const message = describeError(error)
    const action = state.explorer ? { label: "View", onClick: () => window.open(state.explorer!, "_blank", "noopener") } : undefined
    if (solanaToast) txnToast.update(toastId, { status: "error", title: `${opts.label} · failed`, description: message,
      signature: state.signature ?? undefined, explorerUrl: state.explorer ?? undefined })
    else toast.error(`${opts.label} · failed`, { id: toastId, description: message, action })
    return set({ phase: "failed", error: message, venueError })
  }
}

/** React state around sendTransaction for one action on a screen. */
export function useTransaction(label: string, ui?: Pick<SendOptions, "toastVariant" | "successLink">) {
  const [state, setState] = useState<TxState>(IDLE)
  const review = useCallback(() => setState({ ...IDLE, phase: "review" }), [])
  const reset = useCallback(() => setState(IDLE), [])
  const submit = useCallback(
    (instructions: readonly Instruction[], signer: TransactionSendingSigner) =>
      sendTransaction({ label, instructions, signer, onPhase: setState, ...ui }),
    [label, ui?.toastVariant, ui?.successLink?.href, ui?.successLink?.label],
  )
  const busy = state.phase === "awaiting-signature" || state.phase === "pending"
  return { state, busy, review, reset, submit }
}

function shortSig(sig: string): string {
  return `${sig.slice(0, 8)}…${sig.slice(-8)}`
}

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AddressDisplay } from "@/components/sol/address-display"
import { OnboardingHeader } from "@/components/blocks/onboarding-1/components/onboarding-header"
import { OnboardingStepper, type OnboardingStep } from "@/components/blocks/onboarding-1/components/onboarding-stepper"
import { paths } from "@/app/paths"
import { ApiError, queryKeys, useCredential } from "@/lib/api"
import { clusterConfig, explorerUrl } from "@/lib/cluster"
import { useWallet } from "@/lib/wallet"
import { admitWithWallet } from "@/lib/wallet-ui/admission"
import { WalletPicker } from "@/lib/wallet-ui/wallet-picker"

const STEPS: OnboardingStep[] = [
  { id: "connect", value: 1, label: "Connect wallet" },
  { id: "screen", value: 2, label: "Screen address" },
  { id: "admitted", value: 3, label: "Admitted" },
]

export function OnboardPage() {
  const wallet = useWallet()
  const credential = useCredential(wallet.publicKey)
  const qc = useQueryClient()
  const [phase, setPhase] = useState<"idle" | "signing" | "screening">("idle")
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
  const admitted = credential.data?.status === "admitted"
  const rejected = error?.code === "SANCTIONED" || error?.code === "REVOKED" || credential.data?.status === "revoked"
  const retryable = error && !rejected
  const step = admitted ? 3 : wallet.publicKey ? 2 : 1
  const busy = phase !== "idle"

  const admit = async () => {
    if (!wallet.publicKey) return
    setError(null)
    setPhase("signing")
    try {
      await admitWithWallet(wallet.walletName, wallet.publicKey, () => setPhase("screening"))
      await qc.invalidateQueries({ queryKey: queryKeys.credential(wallet.publicKey) })
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : "Admission failed", code: cause instanceof ApiError ? cause.code : undefined })
    } finally { setPhase("idle") }
  }

  return <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6 sm:py-10">
    <div><h1 className="text-2xl font-semibold">Get admitted</h1><p className="mt-2 text-sm text-muted-foreground">Connect your wallet, sign a one-time challenge, and wait for address screening and an onchain test credential.</p></div>
    <div className="overflow-hidden rounded-xl border bg-card">
      <OnboardingStepper currentStep={step} steps={STEPS} />
      <OnboardingHeader currentStep={step} statusLabel={admitted ? "Admission active" : undefined} />
      <div className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <section className="space-y-4 p-5 sm:p-8" aria-live="polite">
          <div><h2 className="font-semibold">{admitted ? "Ready to trade" : wallet.publicKey ? "Screen this wallet" : "Connect a Solana wallet"}</h2><p className="mt-1 text-sm text-muted-foreground">{admitted ? "The venue can verify your credential onchain." : wallet.publicKey ? "Only this wallet can sign its admission challenge." : "Choose the wallet that will hold the stock token and LP position."}</p></div>
          <WalletPicker />
          {wallet.publicKey && credential.isPending && <p role="status" className="text-sm text-muted-foreground">Checking your onchain admission…</p>}
          {wallet.publicKey && credential.isError && <div role="alert" className="rounded-lg border p-3 text-sm">Admission status unavailable: {credential.error.message}<Button variant="outline" size="sm" className="ml-2" onClick={() => void credential.refetch()}>Retry</Button></div>}
          {admitted && credential.data && <div className="space-y-3 rounded-lg border p-4"><Badge variant="secondary">Admitted · test credential</Badge><h3 className="font-semibold">Your credential is onchain</h3>
            <dl className="space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Valid until</dt><dd>{credential.data.expiresAt ? new Date(credential.data.expiresAt).toLocaleString() : "Unknown"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Credential</dt><dd><AddressDisplay address={credential.data.credential.address} href={explorerUrl("account", credential.data.credential.address)} /></dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Stock account</dt><dd>{credential.data.stockAccount.state}</dd></div></dl>
            <Button nativeButton={false} render={<Link to={paths.trade(clusterConfig().defaultSymbol)} />}>Start trading →</Button></div>}
          {rejected && <div className="rounded-lg border border-destructive p-4 text-sm" role="alert"><strong>Admission refused</strong><p className="mt-1">{error?.code === "SANCTIONED" ? "This address matched the OFAC SDN list. No credential was issued." : error?.message ?? "This credential was revoked. Contact the venue operator."}</p></div>}
          {retryable && <div role="alert" className="rounded-lg border p-4 text-sm"><strong>{error.code === "SCREENING_UNAVAILABLE" ? "Screening unavailable" : "Admission did not finish"}</strong><p className="mt-1 text-muted-foreground">{error.message}</p><Button variant="outline" className="mt-3" onClick={() => void admit()}>Retry admission</Button></div>}
          {wallet.publicKey && !admitted && !rejected && !credential.isPending && !credential.isError && !retryable && <Button disabled={busy} onClick={() => void admit()}>{phase === "signing" ? "Awaiting wallet signature…" : phase === "screening" ? "Screening address and issuing credential…" : "Sign challenge and get admitted"}</Button>}
          {busy && <p role="status" className="text-sm text-muted-foreground">{phase === "signing" ? "Approve the one-time challenge in your wallet…" : "Screening against the current OFAC list and issuing on chain…"}</p>}
        </section>
        <aside className="space-y-5 border-t bg-muted/20 p-5 text-sm lg:border-t-0 lg:border-l sm:p-8"><h2 className="font-semibold">What happens next</h2><ol className="space-y-4"><li><strong>1 · Connect</strong><p className="text-muted-foreground">Your wallet address identifies the credential holder.</p></li><li><strong>2 · Screen</strong><p className="text-muted-foreground">Sign a one-time message. The issuer checks the public OFAC SDN list.</p></li><li><strong>3 · Admit</strong><p className="text-muted-foreground">The credential and thawed stock account are verified by the venue program.</p></li></ol><p className="border-t pt-4 text-muted-foreground"><strong className="text-foreground">Test admission, not KYC.</strong> A live venue requires broker-led identity checks.</p></aside>
      </div>
    </div>
  </div>
}

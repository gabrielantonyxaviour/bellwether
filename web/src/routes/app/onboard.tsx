import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ApiError, queryKeys, useCredential } from "@/lib/api"
import { clusterConfig, explorerUrl } from "@/lib/cluster"
import { shortAddress, useWallet } from "@/lib/wallet"
import { admitWithWallet } from "@/lib/wallet-ui/admission"
import { WalletPicker } from "@/lib/wallet-ui/wallet-picker"
import { paths } from "@/app/paths"

export function OnboardPage() {
  const wallet = useWallet()
  const credential = useCredential(wallet.publicKey)
  const qc = useQueryClient()
  const [phase, setPhase] = useState<"idle" | "signing" | "screening">("idle")
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
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
  const admitted = credential.data?.status === "admitted"
  const rejected = error?.code === "SANCTIONED" || error?.code === "REVOKED" || credential.data?.status === "revoked"
  const retryable = error && !rejected
  return <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:py-12">
    <div><h1 className="text-2xl font-semibold">Get admitted</h1><p className="mt-2 text-sm text-muted-foreground">Connect your wallet, sign a one-time challenge, and wait for address screening and an onchain test credential.</p></div>
    <ol className="grid grid-cols-3 gap-2 text-center text-xs sm:text-sm" aria-label="Admission steps">
      {[["1", "Connect"], ["2", "Screen"], ["3", "Admitted"]].map(([number, title], index) => <li key={number} className={`rounded-lg border p-3 ${index === 0 || (index === 1 && wallet.publicKey) || (index === 2 && admitted) ? "font-semibold" : "text-muted-foreground"}`}><span className="block">{number}</span>{title}</li>)}
    </ol>
    <section className="space-y-4 rounded-xl border bg-card p-5" aria-live="polite">
      <WalletPicker />
      {wallet.publicKey && credential.isPending && <p role="status" className="text-sm text-muted-foreground">Checking your onchain admission…</p>}
      {wallet.publicKey && credential.isError && <div role="alert" className="rounded-lg border p-3 text-sm">Admission status unavailable: {credential.error.message}<Button variant="outline" size="sm" className="ml-2" onClick={() => void credential.refetch()}>Retry</Button></div>}
      {admitted && credential.data && <div className="space-y-3 rounded-lg border p-4">
        <Badge variant="secondary">Admitted · test credential</Badge>
        <h2 className="font-semibold">Your credential is onchain</h2>
        <dl className="grid gap-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Valid until</dt><dd>{credential.data.expiresAt ? new Date(credential.data.expiresAt).toLocaleString() : "Unknown"}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Credential</dt><dd><a href={explorerUrl("account", credential.data.credential.address)} target="_blank" rel="noreferrer" className="font-mono underline">{shortAddress(credential.data.credential.address, 6)} ↗</a></dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Stock account</dt><dd>{credential.data.stockAccount.state}</dd></div></dl>
        <Button render={<Link to={paths.trade(clusterConfig().defaultSymbol)} />}>Start trading →</Button>
      </div>}
      {rejected && <div className="rounded-lg border border-destructive p-4 text-sm" role="alert"><strong>Admission refused</strong><p className="mt-1">{error?.code === "SANCTIONED" ? "This address matched the OFAC SDN list. No credential was issued." : error?.message ?? "This credential was revoked. Contact the venue operator."}</p></div>}
      {retryable && <div role="alert" className="rounded-lg border p-4 text-sm"><strong>{error.code === "SCREENING_UNAVAILABLE" ? "Screening unavailable" : "Admission did not finish"}</strong><p className="mt-1 text-muted-foreground">{error.message}</p><Button variant="outline" className="mt-3" onClick={() => void admit()}>Retry admission</Button></div>}
      {wallet.publicKey && !admitted && !rejected && !credential.isPending && !credential.isError && !retryable && <Button disabled={busy} onClick={() => void admit()}>{busy ? "Screening address and issuing credential…" : "Sign challenge and get admitted"}</Button>}
      {busy && <p role="status" className="text-sm text-muted-foreground">{phase === "signing" ? "Approve the one-time challenge in your wallet…" : "Awaiting wallet signature, then screening and onchain issuance…"}</p>}
    </section>
    <aside className="rounded-lg border p-4 text-sm text-muted-foreground"><strong className="text-foreground">Test admission, not KYC.</strong> The issuer screens this address against the public OFAC SDN list. A live venue requires broker-led identity checks.</aside>
  </div>
}

import { AddressDisplay } from "@/components/sol/address-display"
import { Button } from "@/components/ui/button"
import { useCredentialHealth, type AdmitResponse, type CredentialStatus } from "@/lib/api"
import { explorerUrl } from "@/lib/cluster"

function Account({ value, kind = "account" }: { value: string; kind?: "account" | "tx" }) {
  return <AddressDisplay address={value} href={explorerUrl(kind, value)} />
}

function EvidenceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t py-2 text-sm">
    <dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-all text-right">{children}</dd>
  </div>
}

export function AdmissionEvidence({ status, result }: { status: CredentialStatus; result: AdmitResponse | null }) {
  const health = useCredentialHealth(status.status === "admitted")
  const sdn = health.data?.sdn
  const sas = health.data?.gate === "sas" ? health.data.credential : null
  const signature = status.admissionSignature ?? (result?.wallet === status.wallet ? result.signature : null)
  return <section aria-label="How you were admitted" className="space-y-4 rounded-lg border p-4">
    <div><h3 className="font-semibold">How you were admitted</h3><p className="mt-1 text-sm text-muted-foreground">Evidence from the credential issuer and Solana devnet. Test admission, not KYC.</p></div>
    <div>
      <h4 className="text-sm font-medium">Screened against the OFAC SDN list</h4>
      {health.isPending && <p role="status" className="mt-2 text-sm text-muted-foreground">Reading the issuer’s list record…</p>}
      {health.isError && <div role="alert" className="mt-2 text-sm">List record unavailable: {health.error.message} <Button size="sm" variant="outline" onClick={() => void health.refetch()}>Retry</Button></div>}
      {health.isSuccess && !sdn && <p className="mt-2 text-sm text-muted-foreground">The issuer has not loaded a list record.</p>}
      {sdn && <dl className="mt-2">
        <EvidenceRow label="Official list"><a className="underline" href={sdn.source} target="_blank" rel="noreferrer">OFAC SDN.XML ↗</a></EvidenceRow>
        <EvidenceRow label="Published">{sdn.publishDate ?? "Date unavailable"}</EvidenceRow>
        <EvidenceRow label="Digital currency addresses">{sdn.officialAddresses.toLocaleString()}</EvidenceRow>
        {sdn.fixtureAddresses > 0 && <EvidenceRow label="Rehearsal-only addresses">{sdn.fixtureAddresses.toLocaleString()}</EvidenceRow>}
        <EvidenceRow label="Fetched by issuer">{new Date(sdn.fetchedAt).toLocaleString()}{sdn.stale ? " · cached list is stale" : ""}</EvidenceRow>
      </dl>}
      {sdn && <p className="mt-1 text-xs text-muted-foreground">List details show the issuer’s current cache; the wallet was screened when its credential was issued.</p>}
    </div>
    <div>
      <h4 className="text-sm font-medium">Credential issued via Solana Attestation Service</h4>
      {sas?.program && sas.credential && sas.schema ? <dl className="mt-2">
        <EvidenceRow label="SAS program"><Account value={sas.program} /></EvidenceRow>
        <EvidenceRow label="Credential account"><Account value={sas.credential} /></EvidenceRow>
        <EvidenceRow label="Schema account"><Account value={sas.schema} /></EvidenceRow>
        <EvidenceRow label="Your attestation"><Account value={status.credential.address} /></EvidenceRow>
      </dl> : <p className="mt-2 text-sm text-muted-foreground">{health.isPending ? "Reading SAS accounts…" : "SAS account details are unavailable from the issuer."}</p>}
    </div>
    <div>
      <h4 className="text-sm font-medium">Onchain admission and stock thaw</h4>
      <dl className="mt-2">
        <EvidenceRow label="Admission transaction">{signature ? <Account value={signature} kind="tx" /> : "Issuer has no transaction reference"}</EvidenceRow>
        <EvidenceRow label="Stock account"><Account value={status.stockAccount.address} /></EvidenceRow>
        <EvidenceRow label="Stock account state">{status.stockAccount.state}</EvidenceRow>
        <EvidenceRow label="Expires">{status.expiresAt ? new Date(status.expiresAt).toLocaleString() : "Issuer did not return an expiry"}</EvidenceRow>
      </dl>
      {signature && <p className="mt-2 text-xs text-muted-foreground">The admission transaction issued the attestation and thawed this stock account.</p>}
    </div>
  </section>
}

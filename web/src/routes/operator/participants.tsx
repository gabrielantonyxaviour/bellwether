import { useState } from "react"
import { z } from "zod"
import { AddressLink, EmptyBlock, ErrorBlock, LoadingBlock, OperatorPage, ReviewPanel } from "@/components/operator/states"
import { useOperatorAdmit, useOperatorRevoke, useOperatorToken, useScreeningLog } from "@/components/operator/use-operator"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCredential } from "@/lib/api"

const walletSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Enter a base58 wallet address")

export function OperatorParticipantsPage() {
  const { token, save } = useOperatorToken()
  const [draft, setDraft] = useState("")
  const log = useScreeningLog(token)
  const [lookup, setLookup] = useState("")
  const [lookupWallet, setLookupWallet] = useState<string | null>(null)
  const credential = useCredential(lookupWallet)
  const admit = useOperatorAdmit()
  const revoke = useOperatorRevoke()
  const [action, setAction] = useState<{ kind: "issue" | "revoke"; wallet: string } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const run = async () => {
    if (!action || !token) return
    const mutation = action.kind === "issue" ? admit : revoke
    await mutation.mutateAsync({ wallet: action.wallet, token })
    setAction(null)
    setLookupWallet(action.wallet)
  }

  return (
    <OperatorPage title="Participants" lede="Credentials the issuer has written, when they expire, and the screening log. Issue and revoke need the operator token; it stays in this browser session.">
      <form className="flex max-w-xl flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); save(draft.trim()); setDraft("") }}>
        <label className="flex-1 text-sm">Operator token
          <Input className="mt-1" type="password" autoComplete="off" aria-label="Operator token" value={draft} placeholder={token ? "Token saved for this session" : "Paste operator token"} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <Button className="sm:mt-5" type="submit" disabled={!draft.trim()}>Save token</Button>
        {token && <Button className="sm:mt-5" type="button" variant="outline" onClick={() => save("")}>Clear token</Button>}
      </form>
      {!token && <EmptyBlock title="No operator token" detail="Paste the credential service token to read the screening log and to issue or revoke." />}
      {token && log.isPending && <LoadingBlock label="Reading the screening log…" />}
      {token && log.isError && <ErrorBlock message={log.error.message} onRetry={() => void log.refetch()} />}
      {token && log.data && log.data.entries.length === 0 && <EmptyBlock title="Screening log is empty" detail="Admissions and revocations appear here after the issuer writes them." />}
      {log.data && log.data.entries.length > 0 && (
        <div className="min-w-0 overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[640px] text-left text-sm" aria-label="Screening log">
            <thead><tr className="border-b text-xs text-muted-foreground"><th className="px-3 py-2">When</th><th className="px-3 py-2">Wallet</th><th className="px-3 py-2">Event</th><th className="px-3 py-2">Result</th></tr></thead>
            <tbody>
              {log.data.entries.map((entry, index) => (
                <tr key={`${entry.at}-${entry.wallet}-${index}`} className="border-b last:border-0">
                  <td className="px-3 py-2">{new Date(entry.at).toLocaleString()}</td>
                  <td className="px-3 py-2"><AddressLink kind="account" value={entry.wallet} /></td>
                  <td className="px-3 py-2">{entry.event}</td>
                  <td className="px-3 py-2">{entry.result ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="grid max-w-xl gap-3 rounded-xl border p-4" onSubmit={(event) => {
        event.preventDefault()
        const parsed = walletSchema.safeParse(lookup.trim())
        if (!parsed.success) { setFormError(parsed.error.issues[0]?.message ?? "Check the address"); return }
        setFormError(null)
        setLookupWallet(parsed.data)
      }}>
        <h2 className="font-semibold">Look up, issue, revoke</h2>
        <label className="text-sm">Wallet<Input className="mt-1 font-mono" aria-label="Participant wallet" value={lookup} onChange={(event) => setLookup(event.target.value.trim())} /></label>
        {formError && <p role="alert" className="text-sm">{formError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline">Look up</Button>
          <Button type="button" disabled={!token} onClick={() => start(lookup, "issue", setFormError, setAction)}>Review issue</Button>
          <Button type="button" variant="outline" disabled={!token} onClick={() => start(lookup, "revoke", setFormError, setAction)}>Review revoke</Button>
        </div>
        {!lookupWallet && <EmptyBlock title="No wallet selected" detail="Enter a wallet address and choose Look up to read its public credential." />}
        {lookupWallet && credential.isPending && <p role="status" className="text-sm">Reading credential…</p>}
        {lookupWallet && credential.isError && <ErrorBlock message={credential.error.message} onRetry={() => void credential.refetch()} />}
        {credential.data && (
          <dl className="text-sm">
            <div className="flex justify-between gap-3 border-b py-2"><dt>Status</dt><dd>{credential.data.status}</dd></div>
            <div className="flex justify-between gap-3 border-b py-2"><dt>Expires</dt><dd>{credential.data.expiresAt ? new Date(credential.data.expiresAt).toLocaleString() : "—"}</dd></div>
            <div className="flex justify-between gap-3 py-2"><dt>Credential</dt><dd><AddressLink kind="account" value={credential.data.credential.address} /></dd></div>
          </dl>
        )}
        {admit.isError && <p role="alert" className="text-sm">{admit.error.message}</p>}
        {revoke.isError && <p role="alert" className="text-sm">{revoke.error.message}</p>}
        {admit.data && <p role="status" className="text-sm">Issued · expires {new Date(admit.data.expiresAt).toLocaleString()}</p>}
        {revoke.data && <p role="status" className="text-sm">Revoked {revoke.data.wallet}</p>}
      </form>
      {action && (
        <ReviewPanel
          title={action.kind === "issue" ? "Issue credential" : "Revoke credential"}
          confirmLabel={action.kind === "issue" ? "Confirm issue" : "Confirm revoke"}
          detail={action.kind === "issue"
            ? `The issuer will screen ${action.wallet} and write a test admission. This is not KYC.`
            : `Revoke closes the attestation for ${action.wallet}. The wallet can no longer trade.`}
          busy={admit.isPending || revoke.isPending}
          onCancel={() => setAction(null)}
          onConfirm={() => void run()}
        />
      )}
    </OperatorPage>
  )
}

function start(value: string, kind: "issue" | "revoke", setFormError: (value: string | null) => void, setAction: (value: { kind: "issue" | "revoke"; wallet: string }) => void) {
  const parsed = walletSchema.safeParse(value.trim())
  if (!parsed.success) { setFormError(parsed.error.issues[0]?.message ?? "Check the address"); return }
  setFormError(null)
  setAction({ kind, wallet: parsed.data })
}

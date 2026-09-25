import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Address } from "@solana/kit"
import { z } from "zod"
import { activation, activationLabel, NOTICE_WINDOW_S } from "@/components/operator/budget"
import { rememberMint, type BookRow, type OperatorBook } from "@/components/operator/book"
import { tickerOf } from "@/components/operator/book"
import { activatePoolInstruction, recordIssuerNoticeInstruction, recordObjectionInstruction, registerSymbolInstruction } from "@/components/operator/instructions"
import { ErrorBlock, ReviewPanel, TxNote } from "@/components/operator/states"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { symbolPda } from "@/lib/program"
import { useTransaction } from "@/lib/tx"
import { useWallet } from "@/lib/wallet"

const registerSchema = z.object({
  ticker: z.string().trim().regex(/^[A-Za-z0-9.]{1,8}$/, "1–8 letters, digits or dots"),
  mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Stock mint must be a base58 address"),
  tier: z.union([z.literal(1), z.literal(2)]),
  issuerSponsored: z.boolean(),
})

type Draft = z.infer<typeof registerSchema>
type Pending =
  | { kind: "register"; draft: Draft; detail: string }
  | { kind: "notice"; row: BookRow; receivedAt: number; detail: string }
  | { kind: "objection"; row: BookRow; detail: string }
  | { kind: "activate"; row: BookRow; detail: string }

export function SymbolActions({ book }: { book: OperatorBook }) {
  const wallet = useWallet()
  const qc = useQueryClient()
  const tx = useTransaction("Operator symbol action")
  const [pending, setPending] = useState<Pending | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const admin = wallet.publicKey === book.venue.admin
  const signer = wallet.signer

  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["operator-book"] }) }

  const confirm = async () => {
    if (!pending || !signer) return
    const programId = book.programId
    const venue = book.venueAddress
    let instructions
    if (pending.kind === "register") {
      const mint = pending.draft.mint as Address
      const symbol = await symbolPda(programId, venue, mint)
      instructions = [registerSymbolInstruction(programId, signer, venue, symbol, mint, pending.draft)]
    } else if (pending.kind === "notice") {
      instructions = [recordIssuerNoticeInstruction(programId, signer, venue, pending.row.address, pending.receivedAt)]
    } else if (pending.kind === "objection") {
      instructions = [recordObjectionInstruction(programId, signer, venue, pending.row.address)]
    } else {
      instructions = [activatePoolInstruction(programId, signer, venue, pending.row.address)]
    }
    const result = await tx.submit(instructions, signer)
    if (result.phase === "confirmed") {
      if (pending.kind === "register") rememberMint(pending.draft.mint)
      setPending(null)
      await refresh()
    }
  }

  return (
    <div className="space-y-4">
      {!wallet.publicKey && <p className="text-sm text-muted-foreground">Connect the venue admin wallet to register a symbol, record a notice, or activate a pool.</p>}
      {wallet.publicKey && !admin && <ErrorBlock message="This wallet is not the venue admin, so the program will reject every write on this page." />}
      <RegisterForm disabled={!admin || tx.busy} onReview={(draft) => {
        const parsed = registerSchema.safeParse(draft)
        if (!parsed.success) { setFormError(parsed.error.issues[0]?.message ?? "Check the form"); return }
        setFormError(null)
        tx.review()
        setPending({
          kind: "register",
          draft: parsed.data,
          detail: `Register ${parsed.data.ticker} as tier ${parsed.data.tier}, ${parsed.data.issuerSponsored ? "issuer sponsored" : "third-party tokenized"}. The symbol account is created; the pool is not opened.`,
        })
      }} error={formError} />
      {pending?.kind === "register" && tx.state.phase === "review" && (
        <ReviewPanel title="Register symbol" confirmLabel="Confirm registration" detail={pending.detail} busy={tx.busy} onCancel={() => { tx.reset(); setPending(null) }} onConfirm={() => void confirm()} />
      )}
      <TxNote phase={tx.state.phase} error={tx.state.error} signature={tx.state.signature} />
      <ul className="space-y-3">
        {book.rows.map((row) => (
          <li key={row.address}>
            <SymbolRow row={row} now={book.chainTime} disabled={!admin || tx.busy} onNotice={() => {
              const receivedAt = book.chainTime - 30
              tx.review()
              setPending({ kind: "notice", row, receivedAt, detail: `Record that the issuer received notice at chain time ${receivedAt}. The 30-day clock ends ${new Date((receivedAt + NOTICE_WINDOW_S) * 1000).toISOString().slice(0, 10)}.` })
            }} onObjection={() => {
              tx.review()
              setPending({ kind: "objection", row, detail: `${tickerOf(row)} will be marked objected. Activation is refused, and an active symbol is taken down. Amend the public notice within 5 business days.` })
            }} onActivate={() => {
              const state = activation(row.symbol, book.chainTime)
              const prediction = state.kind === "objected"
                ? "The program will refuse this with Objected."
                : state.kind === "window" || state.kind === "unnoticed"
                  ? "The program will refuse this with NoticeWindowOpen until 30 days after the receipt."
                  : "The program will mark the symbol active."
              tx.review()
              setPending({ kind: "activate", row, detail: `Activate ${tickerOf(row)}. ${prediction}` })
            }} />
          </li>
        ))}
      </ul>
      {pending && pending.kind !== "register" && tx.state.phase === "review" && (
        <ReviewPanel title={pending.kind === "notice" ? "Record issuer notice" : pending.kind === "objection" ? "Record objection" : "Activate symbol"} confirmLabel={pending.kind === "notice" ? "Confirm notice" : pending.kind === "objection" ? "Confirm objection" : "Confirm activation"} detail={pending.detail} busy={tx.busy} onCancel={() => { tx.reset(); setPending(null) }} onConfirm={() => void confirm()} />
      )}
    </div>
  )
}

function RegisterForm({ disabled, error, onReview }: { disabled: boolean; error: string | null; onReview: (draft: Draft) => void }) {
  const [ticker, setTicker] = useState("")
  const [mint, setMint] = useState("")
  const [tier, setTier] = useState<1 | 2>(2)
  const [issuerSponsored, setIssuerSponsored] = useState(false)
  return (
    <form className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); onReview({ ticker, mint, tier, issuerSponsored }) }}>
      <h2 className="font-semibold sm:col-span-2">Register a symbol</h2>
      <label className="text-sm">Ticker<Input className="mt-1" value={ticker} onChange={(event) => setTicker(event.target.value.toUpperCase())} aria-label="Ticker" /></label>
      <label className="text-sm">Stock mint<Input className="mt-1 font-mono" value={mint} onChange={(event) => setMint(event.target.value.trim())} aria-label="Stock mint" /></label>
      <label className="text-sm">Tier
        <select className="mt-1 h-8 w-full rounded-lg border bg-transparent px-2 text-sm" aria-label="Tier" value={tier} onChange={(event) => setTier(event.target.value === "1" ? 1 : 2)}>
          <option value={1}>Tier 1</option>
          <option value={2}>Tier 2</option>
        </select>
      </label>
      <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={issuerSponsored} onChange={(event) => setIssuerSponsored(event.target.checked)} /> Issuer sponsored</label>
      {error && <p role="alert" className="text-sm sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2"><Button type="submit" disabled={disabled}>Review registration</Button></div>
    </form>
  )
}

function SymbolRow({ row, now, disabled, onNotice, onObjection, onActivate }: {
  row: BookRow; now: number; disabled: boolean; onNotice: () => void; onObjection: () => void; onActivate: () => void
}) {
  const state = activation(row.symbol, now)
  const thirdParty = !row.symbol.issuerSponsored
  return (
    <article className="rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{tickerOf(row)}</h3>
        <span>{activationLabel(state)}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Tier {row.symbol.tier} · {thirdParty ? "third-party" : "issuer sponsored"} · {row.pool ? "pool open" : "no pool yet"}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {thirdParty && <Button variant="outline" disabled={disabled || row.symbol.noticeReceivedAt > 0n} onClick={onNotice}>Record receipt at chain time</Button>}
        {thirdParty && <Button variant="outline" disabled={disabled} onClick={onObjection}>Review objection</Button>}
        <Button variant="outline" disabled={disabled} onClick={onActivate}>Review activation</Button>
      </div>
    </article>
  )
}

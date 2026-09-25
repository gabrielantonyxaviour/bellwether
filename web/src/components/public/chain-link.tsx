import { useState } from "react"
import { shortAddress } from "@/lib/wallet"
import type { ExplorerKind } from "@/components/public/records"

/** A fork id that is not on public Solscan. The full value is copied; the page does not link it. */
export function LocalRecording({ id, name }: { id: string; name: string }) {
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setRevealed(true)
    }
  }
  return (
    <span className="inline-flex max-w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <code className={revealed ? "font-mono text-xs break-all" : "font-mono text-xs"}>{revealed ? id : shortAddress(id)}</code>
      <button type="button" className="text-xs underline" aria-label={`Copy local recording ${name} ${id}`} onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  )
}

export function ChainLink({ href, id, kind }: { href: string; id: string; kind: ExplorerKind }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs underline-offset-2 hover:underline"
      title={id}
    >
      {shortAddress(id, kind === "tx" ? 4 : 4)}
      <span className="sr-only"> on Solscan</span>
    </a>
  )
}

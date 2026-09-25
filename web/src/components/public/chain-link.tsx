import { useState } from "react"
import { shortAddress } from "@/lib/wallet"
import type { ExplorerKind } from "@/components/public/records"

/** Fork value. Monospace and copyable. Never a Solscan link. */
export function LocalRecording({ id, name }: { id: string; name: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <span className="grid max-w-full justify-items-start gap-1">
      <code className="block max-w-full font-mono text-xs break-all">{id}</code>
      <button type="button" className="text-xs underline" aria-label={`Copy ${name} ${id}`} onClick={() => void copy()}>
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

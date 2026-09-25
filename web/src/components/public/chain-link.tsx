import { shortAddress } from "@/lib/wallet"
import type { ExplorerKind } from "@/components/public/records"

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

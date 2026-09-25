import { useState } from "react"
import { Button } from "@/components/ui/button"
import { shortAddress, useWallet } from "@/lib/wallet"

export function WalletPicker() {
  const { wallets, publicKey, walletName, status, connect, disconnect } = useWallet()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const run = async (name: string) => {
    setError(null)
    try { await connect(name); setOpen(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Wallet connection failed") }
  }
  if (publicKey) return <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
    <div><div className="font-medium">{walletName}</div><div className="font-mono text-muted-foreground" title={publicKey}>{shortAddress(publicKey, 6)}</div></div>
    <Button variant="outline" size="sm" onClick={() => void disconnect().catch((cause: unknown) => setError(String(cause)))}>Disconnect</Button>
    {error && <p role="alert" className="w-full text-destructive">{error}</p>}
  </div>
  return <div className="space-y-3">
    <Button disabled={status === "connecting"} onClick={() => setOpen((value) => !value)}>{status === "connecting" ? "Connecting…" : "Connect wallet"}</Button>
    {open && <div className="rounded-lg border p-3" role="group" aria-label="Available wallets">
      {wallets.length ? <div className="flex flex-wrap gap-2">{wallets.map((wallet) => <Button key={wallet.name} variant="outline" onClick={() => void run(wallet.name)}>
        <img src={wallet.icon} alt="" className="size-4" />{wallet.name}
      </Button>)}</div> : <p className="text-sm text-muted-foreground">No Solana wallet detected. Install Phantom, Solflare or Backpack, then refresh.</p>}
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}

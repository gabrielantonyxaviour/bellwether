/** Header wallet slot: connect (pick a Wallet Standard wallet), show the address, disconnect. */
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { shortAddress, useWallet } from "@/lib/wallet"

export function WalletButton() {
  const { wallets, status, publicKey, walletName, connect, disconnect } = useWallet()
  const run = (p: Promise<void>) => p.catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Wallet error"))

  if (status === "connected" && publicKey) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="font-mono" />}>
          {shortAddress(publicKey)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{walletName}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(publicKey)}>Copy address</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void run(disconnect())}>Disconnect</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  if (wallets.length <= 1) {
    return (
      <Button size="sm" disabled={status === "connecting"} onClick={() => void run(connect())}>
        {status === "connecting" ? "Connecting…" : "Connect wallet"}
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" disabled={status === "connecting"} />}>
        {status === "connecting" ? "Connecting…" : "Connect wallet"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {wallets.map((w) => (
          <DropdownMenuItem key={w.name} onClick={() => void run(connect(w.name))}>
            <img src={w.icon} alt="" className="size-4" />
            {w.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

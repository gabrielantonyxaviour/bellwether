/** Header credential slot: the connected wallet's admission state from the credential issuer. */
import { Link } from "react-router"
import { Badge } from "@/components/ui/badge"
import { useCredential } from "@/lib/api"
import { useWallet } from "@/lib/wallet"
import { paths } from "@/app/paths"

export function CredentialBadge() {
  const { publicKey } = useWallet()
  const credential = useCredential(publicKey)
  if (!publicKey) return null
  if (credential.isPending) return <Badge variant="outline">Checking…</Badge>
  if (credential.isError) return <Badge variant="outline" title={credential.error.message}>Credential unknown</Badge>
  const { status, expiresAt } = credential.data
  if (status === "admitted") {
    return <Badge variant="secondary" title={expiresAt ? `Test admission, not KYC · expires ${expiresAt}` : undefined}>Admitted</Badge>
  }
  const label = status === "expired" ? "Admission expired" : status === "revoked" ? "Revoked" : "Not admitted"
  return <Badge variant="destructive" render={<Link to={paths.onboard} />}>{label} · Get admitted →</Badge>
}

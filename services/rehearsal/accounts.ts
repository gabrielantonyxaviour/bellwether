/** Chain reads shared by market discovery and the activity ledger. */
import { FWDI_MINT, TOKEN_2022_PROGRAM } from "./constants.js"
import type { RpcClient } from "./rpc.js"
import type { TokenAccountFact } from "./schema.js"

type StateName = TokenAccountFact["state"]
interface ParsedTokenInfo { mint: string; owner: string; state: StateName; tokenAmount: { amount: string; decimals: number } }
interface ParsedAccount { owner: string; data: { parsed?: { type: string; info: ParsedTokenInfo } } | [string, string] }

export async function enumerateTokenAccounts(rpc: RpcClient, mint = FWDI_MINT): Promise<{ accounts: TokenAccountFact[]; fetchedAt: string; slot: number }> {
  const { result, fetchedAt } = await rpc.call<{ context: { slot: number }; value: { pubkey: string; account: ParsedAccount }[] }>(
    "getProgramAccounts",
    [TOKEN_2022_PROGRAM, { encoding: "jsonParsed", withContext: true, commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: mint } }] }],
  )
  const accounts: TokenAccountFact[] = []
  for (const { pubkey, account } of result.value) {
    const parsed = Array.isArray(account.data) ? undefined : account.data.parsed
    if (parsed?.type !== "account" || parsed.info.mint !== mint) continue
    const { owner, state, tokenAmount } = parsed.info
    accounts.push({ account: pubkey, owner, state, amountRaw: tokenAmount.amount, shares: Number(tokenAmount.amount) / 10 ** tokenAmount.decimals })
  }
  return { accounts, fetchedAt, slot: result.context.slot }
}

/** Which program owns each address (null: no account on chain — a data-less PDA or an empty wallet). */
export async function ownerPrograms(rpc: RpcClient, addresses: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(addresses)]
  const owners = new Map<string, string | null>()
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100)
    const { result } = await rpc.call<{ value: ({ owner: string } | null)[] }>(
      "getMultipleAccounts", [batch, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])
    batch.forEach((address, j) => owners.set(address, result.value[j]?.owner ?? null))
  }
  return owners
}

export interface VaultRead { exists: boolean; mint: string | null; owner: string | null; state: StateName | null; amountRaw: string | null }

export async function readTokenAccounts(rpc: RpcClient, addresses: string[]): Promise<{ reads: Map<string, VaultRead>; fetchedAt: string }> {
  const reads = new Map<string, VaultRead>()
  let fetchedAt = new Date().toISOString()
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100)
    const response = await rpc.call<{ value: (ParsedAccount | null)[] }>("getMultipleAccounts", [batch, { encoding: "jsonParsed" }])
    fetchedAt = response.fetchedAt
    batch.forEach((address, j) => {
      const value = response.result.value[j]
      const parsed = value && !Array.isArray(value.data) ? value.data.parsed : undefined
      reads.set(address, parsed?.type === "account"
        ? { exists: true, mint: parsed.info.mint, owner: parsed.info.owner, state: parsed.info.state, amountRaw: parsed.info.tokenAmount.amount }
        : { exists: value !== null, mint: null, owner: null, state: null, amountRaw: null })
    })
  }
  return { reads, fetchedAt }
}

export interface SignatureInfo { signature: string; slot: number; blockTime: number | null; err: unknown }

/**
 * Signatures for an address, newest first. With `sinceUnix`, pages back until the window is
 * covered; without it, returns one page (≤1000) and says whether it was capped.
 */
export async function signaturesFor(rpc: RpcClient, address: string, options: { sinceUnix?: number; maxPages?: number } = {}): Promise<{
  signatures: SignatureInfo[]; pages: number; capped: boolean; fetchedAt: string
}> {
  const all: SignatureInfo[] = []
  let before: string | undefined
  let pages = 0
  let fetchedAt = new Date().toISOString()
  const maxPages = options.sinceUnix === undefined ? 1 : options.maxPages ?? 5
  while (pages < maxPages) {
    const response = await rpc.call<SignatureInfo[]>("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }])
    fetchedAt = response.fetchedAt
    pages++
    const page = response.result
    all.push(...page)
    const oldest = page.at(-1)
    const windowCovered = options.sinceUnix !== undefined && oldest?.blockTime != null && oldest.blockTime < options.sinceUnix
    if (page.length < 1000 || windowCovered) return { signatures: all, pages, capped: false, fetchedAt }
    before = oldest?.signature
  }
  return { signatures: all, pages, capped: true, fetchedAt }
}

export const toIso = (unix: number | null | undefined): string | null => (unix == null ? null : new Date(unix * 1000).toISOString())

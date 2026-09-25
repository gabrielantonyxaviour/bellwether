/** FWDI's authorities and Token-2022 extensions, read from chain (jsonParsed). */
import { FWDI_MINT } from "./constants.js"
import type { RpcClient } from "./rpc.js"
import type { MintFacts } from "./schema.js"

interface ParsedExtension { extension: string; state?: Record<string, unknown> }
interface ParsedMint {
  context: { slot: number }
  value: {
    owner: string; space: number
    data: { parsed: { type: string; info: {
      decimals: number; supply: string; mintAuthority: string | null; freezeAuthority: string | null; extensions?: ParsedExtension[]
    } } }
  } | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? NaN))

const POWERS: Record<string, string> = {
  "mint authority": "mints new tokens (issuance)",
  "freeze authority": "freezes and thaws accounts: every new account starts frozen, so this key runs the allowlist",
  "permanent delegate": "can transfer or burn tokens from any account",
  "metadata pointer authority": "can repoint where the token's metadata lives",
  "metadata update authority": "can edit the token's name, symbol and URI",
  "scaled-UI authority": "sets the UI multiplier (splits and similar corporate actions)",
}

export async function readFwdiMint(rpc: RpcClient, mint = FWDI_MINT): Promise<MintFacts> {
  const { result, fetchedAt } = await rpc.call<ParsedMint>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }])
  const value = result.value
  if (!value || value.data.parsed.type !== "mint") throw new Error(`${mint} is not a parsed mint account`)
  const info = value.data.parsed.info
  const extensions = info.extensions ?? []
  const state = (name: string) => extensions.find((e) => e.extension === name)?.state
  const das = state("defaultAccountState")
  const pd = state("permanentDelegate")
  const mp = state("metadataPointer")
  const su = state("scaledUiAmountConfig")
  const md = state("tokenMetadata")

  const facts: Omit<MintFacts, "authorityMap"> = {
    address: mint,
    symbol: str(md?.symbol) ?? "",
    name: str(md?.name) ?? "",
    tokenProgram: value.owner,
    decimals: info.decimals,
    supplyRaw: info.supply,
    supplyShares: Number(info.supply) / 10 ** info.decimals,
    space: value.space,
    mintAuthority: str(info.mintAuthority),
    freezeAuthority: str(info.freezeAuthority),
    permanentDelegate: str(pd?.delegate),
    defaultAccountState: das ? (str(das.accountState) as MintFacts["defaultAccountState"]) : null,
    metadataPointer: mp ? { authority: str(mp.authority), metadataAddress: str(mp.metadataAddress) } : null,
    scaledUiAmount: su ? {
      authority: str(su.authority), multiplier: num(su.multiplier), newMultiplier: num(su.newMultiplier),
      newMultiplierEffectiveTimestamp: num(su.newMultiplierEffectiveTimestamp),
    } : null,
    metadata: md ? { updateAuthority: str(md.updateAuthority), name: str(md.name) ?? "", symbol: str(md.symbol) ?? "", uri: str(md.uri) ?? "" } : null,
    extensions: extensions.map((e) => e.extension),
    hasPausable: extensions.some((e) => /^pausable/i.test(e.extension)),
    hasTransferHook: extensions.some((e) => e.extension === "transferHook"),
    source: {
      name: "Solana mainnet RPC getAccountInfo (jsonParsed)", url: rpc.url, method: "getAccountInfo",
      fetchedAt, slot: result.context.slot,
    },
  }

  const roles: [string, string | null][] = [
    ["mint authority", facts.mintAuthority],
    ["freeze authority", facts.freezeAuthority],
    ["permanent delegate", facts.permanentDelegate],
    ["metadata pointer authority", facts.metadataPointer?.authority ?? null],
    ["metadata update authority", facts.metadata?.updateAuthority ?? null],
    ["scaled-UI authority", facts.scaledUiAmount?.authority ?? null],
  ]
  const byAddress = new Map<string, string[]>()
  for (const [role, who] of roles) if (who) byAddress.set(who, [...(byAddress.get(who) ?? []), role])
  const authorityMap = [...byAddress].map(([address, list]) => ({ address, roles: list, powers: list.map((r) => POWERS[r]) }))
  return { ...facts, authorityMap }
}

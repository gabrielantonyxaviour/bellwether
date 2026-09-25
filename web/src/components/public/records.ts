/**
 * Recorded deployments. Addresses and signatures are the files written by the deploy
 * and fork scenario; the page does not invent a cluster that has no file.
 */
import { z } from "zod"
import devnetFile from "../../../../scripts/deploy/deployments/devnet.json" with { type: "json" }
import forkFile from "../../../../scripts/fork/out/fork-scenario.json" with { type: "json" }

const signatures = z.record(z.string(), z.string().min(32))

const DevnetSchema = z.object({
  cluster: z.literal("devnet"),
  rpcUrl: z.string(),
  programId: z.string(),
  venue: z.string(),
  stockMint: z.string(),
  usdcMint: z.string(),
  symbol: z.string(),
  pool: z.string(),
  stockVault: z.string(),
  usdcVault: z.string(),
  sasCredential: z.string(),
  signatures,
  updatedAt: z.string(),
})

const ForkSchema = z.object({
  cluster: z.literal("fork"),
  rpcUrl: z.string(),
  programId: z.string(),
  venue: z.string(),
  fwdiMint: z.string(),
  transferAgentApproval: z.string(),
  signatures,
  checkedAt: z.string(),
})

export type DevnetRecord = z.infer<typeof DevnetSchema>
export type ForkRecord = z.infer<typeof ForkSchema>
export type ExplorerKind = "tx" | "account" | "token"

export const devnetRecord = DevnetSchema.parse(devnetFile)
export const forkRecord = ForkSchema.parse(forkFile)

/** No mainnet deployment file exists. The pitch target stays an empty state. */
export const mainnetRecord = null

/** Public Solscan only. Fork recordings are not linked: their RPC is local to the machine that ran the fork. */
export function solscanUrl(cluster: "devnet" | "mainnet", kind: ExplorerKind, id: string): string {
  const url = new URL(`https://solscan.io/${kind}/${id}`)
  if (cluster === "devnet") url.searchParams.set("cluster", "devnet")
  return url.toString()
}

const LEAD = ["program", "venue", "symbol", "pool", "activate", "seedLiquidity", "smokeSwap", "deploy", "initVenue", "fwdiSwap"]

export function orderedSignatures(map: Record<string, string>): [string, string][] {
  const lead = LEAD.filter((key) => map[key]).map((key) => [key, map[key]] as [string, string])
  const rest = Object.entries(map).filter(([key]) => !LEAD.includes(key))
  return [...lead, ...rest]
}

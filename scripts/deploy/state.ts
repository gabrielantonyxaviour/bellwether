/** Persistent, public deployment journal. Secret keys live only in ~/.config/solana. */
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { address, type Address } from "@solana/kit"
import { z } from "zod"
import { type Cluster } from "../../config/clusters.js"
import { loadKeypairSigner } from "../assets/tx.js"

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,100}$/)
const journalSchema = z.object({
  cluster: z.enum(["fork", "devnet", "mainnet"]),
  rpcUrl: z.string().url(),
  genesisHash: base58,
  deployer: base58,
  programId: base58.optional(),
  venue: base58.optional(),
  stockMint: base58.optional(),
  usdcMint: base58.optional(),
  symbol: base58.optional(),
  pool: base58.optional(),
  stockVault: base58.optional(),
  usdcVault: base58.optional(),
  sasCredential: base58.optional(),
  sasSchema: base58.optional(),
  signatures: z.record(z.string(), signature).default({}),
  completed: z.array(z.string()).default([]),
  durationsMs: z.record(z.string(), z.number().int().nonnegative()).default({}),
  updatedAt: z.string().datetime().optional(),
})
export type Deployment = z.infer<typeof journalSchema>

export const deploymentPath = (cluster: Cluster) => join("scripts", "deploy", "deployments",
  cluster === "fork" && process.env.BELLWETHER_FORK_PORT && process.env.BELLWETHER_FORK_PORT !== "8899"
    ? `fork-${process.env.BELLWETHER_FORK_PORT}.json` : `${cluster}.json`)
export const keyDir = (cluster: Cluster) => join(homedir(), ".config", "solana", "bellwether", cluster)
export const deployerPath = join(homedir(), ".config", "solana", "bellwether-deployer.json")

export function loadDeployment(cluster: Cluster): Deployment | null {
  const file = deploymentPath(cluster)
  if (!existsSync(file)) return null
  const parsed = journalSchema.parse(JSON.parse(readFileSync(file, "utf8")))
  if (parsed.cluster !== cluster) throw new Error(`${file} records ${parsed.cluster}, expected ${cluster}`)
  return parsed
}

export function saveDeployment(record: Deployment): void {
  const file = deploymentPath(record.cluster)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(journalSchema.parse({ ...record, updatedAt: new Date().toISOString() }), null, 2) + "\n")
  renameSync(temp, file)
}

export function ensureKey(cluster: Cluster, name: string): string {
  if (!/^[a-z][a-z-]*$/.test(name)) throw new Error(`invalid key name ${name}`)
  const dir = keyDir(cluster)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, `${name}.json`)
  if (!existsSync(file)) execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--outfile", file], { stdio: "ignore" })
  chmodSync(file, 0o600)
  return file
}

export async function key(cluster: Cluster, name: string) {
  return loadKeypairSigner(ensureKey(cluster, name))
}

export function addressFromKey(file: string): Address {
  return address(execFileSync("solana-keygen", ["pubkey", file], { encoding: "utf8" }).trim())
}

export function mark(record: Deployment, step: string, signature?: string): void {
  const now = Date.now()
  record.durationsMs[step] = now - lastMarkAt
  lastMarkAt = now
  if (!record.completed.includes(step)) record.completed.push(step)
  if (signature) record.signatures[step] = signature
  saveDeployment(record)
}

let lastMarkAt = Date.now()

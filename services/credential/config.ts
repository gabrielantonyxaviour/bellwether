/**
 * Environment contract for the credential issuer (all validated with zod):
 *
 *   CREDENTIAL_CLUSTER                  fork | devnet | mainnet (default fork)
 *   CREDENTIAL_RPC_URL                  override; else config/clusters.ts for the cluster
 *   CREDENTIAL_ISSUER_KEYPAIR           keypair file: the venue's credential issuer (SAS credential
 *                                       authority + signer; membership grant/revoke signer)   required
 *   CREDENTIAL_FREEZE_AUTHORITY_KEYPAIR keypair file: the venue key, BWRS freeze authority      required
 *   CREDENTIAL_PAYER_KEYPAIR            fee/rent payer (default: the issuer)
 *   BELLWETHER_STOCK_MINT               BWRS mint (default: scripts/assets/deployments/<cluster>.json)
 *   CREDENTIAL_GATE                     sas (default) | membership
 *   BELLWETHER_VENUE_PROGRAM_ID, BELLWETHER_VENUE   required when CREDENTIAL_GATE=membership
 *   CREDENTIAL_TTL_DAYS                 attestation lifetime (default 30)
 *   CREDENTIAL_OPERATOR_TOKEN           bearer token for /revoke and /screening-log (≥ 16 chars)
 *   CREDENTIAL_DATA_DIR                 runtime dir (default services/credential/data)
 *   CREDENTIAL_SDN_URL / _MAX_AGE_HOURS official SDN.XML source and cache age (default 24 h)
 *   CREDENTIAL_SDN_FIXTURE              extra list path, or "none" (default: the committed fixture
 *                                       on fork/devnet, none on mainnet)
 *   CREDENTIAL_HOST / CREDENTIAL_PORT   bind (default 127.0.0.1:8790)
 *   CREDENTIAL_CORS_ORIGIN              "*" or a comma list (default *)
 *   CREDENTIAL_ALLOW_MAINNET=1          required before the service will sign on mainnet
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { address, type Address, type TransactionSigner } from "@solana/kit"
import { z } from "zod"
import { CLUSTERS, DEPLOYMENTS_DIR, clusterConfig, type Cluster } from "../../config/clusters.js"
import { loadKeypairSigner } from "../../scripts/assets/tx.js"
import { OFAC_SDN_XML_URL } from "./sdn.js"

export const SERVICE_DIR = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_FIXTURE = join(SERVICE_DIR, "fixtures", "sdn-fixture.json")

export type GateConfig = { kind: "sas" } | { kind: "membership"; programId: Address; venue: Address }

export interface CredentialConfig {
  cluster: Cluster
  rpcUrl: string
  issuer: TransactionSigner
  freezeAuthority: TransactionSigner
  payer: TransactionSigner
  stockMint: Address
  gate: GateConfig
  ttlSeconds: bigint
  operatorToken: string | null
  dataDir: string
  sdnCachePath: string
  logPath: string
  sdnUrl: string
  sdnMaxAgeMs: number
  fixturePath: string | null
  host: string
  port: number
  corsOrigin: string
}

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 address")
const envSchema = z.object({
  CREDENTIAL_CLUSTER: z.enum(CLUSTERS).default("fork"),
  CREDENTIAL_RPC_URL: z.string().url().optional(),
  CREDENTIAL_ISSUER_KEYPAIR: z.string().min(1, "CREDENTIAL_ISSUER_KEYPAIR is required"),
  CREDENTIAL_FREEZE_AUTHORITY_KEYPAIR: z.string().min(1, "CREDENTIAL_FREEZE_AUTHORITY_KEYPAIR is required"),
  CREDENTIAL_PAYER_KEYPAIR: z.string().min(1).optional(),
  BELLWETHER_STOCK_MINT: base58.optional(),
  CREDENTIAL_GATE: z.enum(["sas", "membership"]).default("sas"),
  BELLWETHER_VENUE_PROGRAM_ID: base58.optional(),
  BELLWETHER_VENUE: base58.optional(),
  CREDENTIAL_TTL_DAYS: z.coerce.number().positive().max(365).default(30),
  CREDENTIAL_OPERATOR_TOKEN: z.string().min(16, "CREDENTIAL_OPERATOR_TOKEN must be at least 16 characters").optional(),
  CREDENTIAL_DATA_DIR: z.string().min(1).optional(),
  CREDENTIAL_SDN_URL: z.string().url().default(OFAC_SDN_XML_URL),
  CREDENTIAL_SDN_MAX_AGE_HOURS: z.coerce.number().positive().default(24),
  CREDENTIAL_SDN_FIXTURE: z.string().min(1).optional(),
  CREDENTIAL_HOST: z.string().min(1).default("127.0.0.1"),
  CREDENTIAL_PORT: z.coerce.number().int().min(0).max(65_535).default(8790),
  CREDENTIAL_CORS_ORIGIN: z.string().min(1).default("*"),
  CREDENTIAL_ALLOW_MAINNET: z.enum(["1"]).optional(),
})

export function runtimePaths(dataDir: string) {
  return { sdnCachePath: join(dataDir, "sdn-cache.json"), logPath: join(dataDir, "screening-log.jsonl") }
}

export function defaultFixture(cluster: Cluster): string | null {
  return cluster === "mainnet" ? null : DEFAULT_FIXTURE
}

function mintFromDeployments(cluster: Cluster): Address | null {
  const file = join(DEPLOYMENTS_DIR, `${cluster}.json`)
  if (!existsSync(file)) return null
  const parsed = z.object({ stockMint: base58 }).passthrough().safeParse(JSON.parse(readFileSync(file, "utf8")))
  return parsed.success ? address(parsed.data.stockMint) : null
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<CredentialConfig> {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) throw new Error(`credential config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
  const e = parsed.data
  if (e.CREDENTIAL_CLUSTER === "mainnet" && e.CREDENTIAL_ALLOW_MAINNET !== "1") {
    throw new Error("credential config: mainnet signs real transactions; set CREDENTIAL_ALLOW_MAINNET=1 once that spend is approved")
  }
  const stockMint = e.BELLWETHER_STOCK_MINT ? address(e.BELLWETHER_STOCK_MINT) : mintFromDeployments(e.CREDENTIAL_CLUSTER)
  if (!stockMint) throw new Error(`credential config: set BELLWETHER_STOCK_MINT or create ${e.CREDENTIAL_CLUSTER}'s rehearsal mint first`)
  let gate: GateConfig = { kind: "sas" }
  if (e.CREDENTIAL_GATE === "membership") {
    if (!e.BELLWETHER_VENUE_PROGRAM_ID || !e.BELLWETHER_VENUE) throw new Error("credential config: membership needs BELLWETHER_VENUE_PROGRAM_ID and BELLWETHER_VENUE")
    gate = { kind: "membership", programId: address(e.BELLWETHER_VENUE_PROGRAM_ID), venue: address(e.BELLWETHER_VENUE) }
  }
  const issuer = await loadKeypairSigner(e.CREDENTIAL_ISSUER_KEYPAIR)
  const dataDir = e.CREDENTIAL_DATA_DIR ?? join(SERVICE_DIR, "data")
  const fixture = e.CREDENTIAL_SDN_FIXTURE
  return {
    cluster: e.CREDENTIAL_CLUSTER,
    rpcUrl: e.CREDENTIAL_RPC_URL ?? clusterConfig(e.CREDENTIAL_CLUSTER, env).rpcUrl,
    issuer,
    freezeAuthority: await loadKeypairSigner(e.CREDENTIAL_FREEZE_AUTHORITY_KEYPAIR),
    payer: e.CREDENTIAL_PAYER_KEYPAIR ? await loadKeypairSigner(e.CREDENTIAL_PAYER_KEYPAIR) : issuer,
    stockMint,
    gate,
    ttlSeconds: BigInt(Math.round(e.CREDENTIAL_TTL_DAYS * 86_400)),
    operatorToken: e.CREDENTIAL_OPERATOR_TOKEN ?? null,
    dataDir,
    ...runtimePaths(dataDir),
    sdnUrl: e.CREDENTIAL_SDN_URL,
    sdnMaxAgeMs: e.CREDENTIAL_SDN_MAX_AGE_HOURS * 3_600_000,
    fixturePath: fixture === "none" ? null : fixture ?? defaultFixture(e.CREDENTIAL_CLUSTER),
    host: e.CREDENTIAL_HOST,
    port: e.CREDENTIAL_PORT,
    corsOrigin: e.CREDENTIAL_CORS_ORIGIN,
  }
}

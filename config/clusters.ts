/**
 * Cluster map: where each environment's RPC lives and which USDC mint its pools quote in.
 *
 * - mainnet: real USDC, public RPC unless overridden.
 * - fork:    a local Surfpool mainnet fork (never exposed publicly); real mainnet USDC,
 *            which the fork copies lazily from mainnet on first touch.
 * - devnet:  a test USDC mint created by `scripts/assets/create.ts --cluster devnet`,
 *            recorded in scripts/assets/deployments/devnet.json (or given by env).
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { address, type Address } from "@solana/kit"
import { z } from "zod"

export const CLUSTERS = ["mainnet", "fork", "devnet"] as const
export type Cluster = (typeof CLUSTERS)[number]

export const MAINNET_USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
export const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")

export type UsdcSource = "mainnet-usdc" | "devnet-test-usdc"

export interface ClusterConfig {
  cluster: Cluster
  rpcUrl: string
  wsUrl: string
  /** null only on devnet before the test USDC mint has been created. */
  usdcMint: Address | null
  usdcSource: UsdcSource
  /** USDC (real or test) is a classic SPL Token mint on every cluster. */
  usdcTokenProgram: Address
  /** The rehearsal stock is always a Token-2022 mint. */
  stockTokenProgram: Address
  /** True when this cluster's state is disposable and cheatcodes (surfnet_*) are available. */
  local: boolean
}

const clusterSchema = z.enum(CLUSTERS)
const urlSchema = z.string().url()
const base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 address")

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const DEPLOYMENTS_DIR = join(REPO_ROOT, "scripts", "assets", "deployments")

export function parseCluster(value: unknown): Cluster {
  const parsed = clusterSchema.safeParse(value)
  if (!parsed.success) throw new Error(`unknown cluster ${JSON.stringify(value)}; expected one of ${CLUSTERS.join(", ")}`)
  return parsed.data
}

/** http(s)://host:port → ws(s)://host:port+1 for local validators, same host for hosted RPCs. */
export function wsUrlFor(rpcUrl: string, local: boolean): string {
  const url = new URL(rpcUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (local && url.port) url.port = String(Number(url.port) + 1)
  return url.toString()
}

function devnetUsdcFromDeployments(): Address | null {
  const file = join(DEPLOYMENTS_DIR, "devnet.json")
  if (!existsSync(file)) return null
  const parsed = z.object({ usdcMint: base58Address.optional() }).passthrough().safeParse(JSON.parse(readFileSync(file, "utf8")))
  return parsed.success && parsed.data.usdcMint ? address(parsed.data.usdcMint) : null
}

export function clusterConfig(cluster: Cluster, env: NodeJS.ProcessEnv = process.env): ClusterConfig {
  const override = (name: string, fallback: string) => urlSchema.parse(env[name] && env[name]!.length > 0 ? env[name] : fallback)
  switch (cluster) {
    case "mainnet": {
      const rpcUrl = override("BELLWETHER_MAINNET_RPC_URL", "https://api.mainnet-beta.solana.com")
      return {
        cluster, rpcUrl, wsUrl: wsUrlFor(rpcUrl, false), usdcMint: MAINNET_USDC_MINT, usdcSource: "mainnet-usdc",
        usdcTokenProgram: TOKEN_PROGRAM, stockTokenProgram: TOKEN_2022_PROGRAM, local: false,
      }
    }
    case "fork": {
      const rpcUrl = override("BELLWETHER_FORK_RPC_URL", "http://127.0.0.1:8899")
      return {
        cluster, rpcUrl, wsUrl: wsUrlFor(rpcUrl, true), usdcMint: MAINNET_USDC_MINT, usdcSource: "mainnet-usdc",
        usdcTokenProgram: TOKEN_PROGRAM, stockTokenProgram: TOKEN_2022_PROGRAM, local: true,
      }
    }
    case "devnet": {
      const rpcUrl = override("BELLWETHER_DEVNET_RPC_URL", "https://api.devnet.solana.com")
      const fromEnv = env.BELLWETHER_DEVNET_USDC_MINT ? address(base58Address.parse(env.BELLWETHER_DEVNET_USDC_MINT)) : null
      return {
        cluster, rpcUrl, wsUrl: wsUrlFor(rpcUrl, false), usdcMint: fromEnv ?? devnetUsdcFromDeployments(),
        usdcSource: "devnet-test-usdc", usdcTokenProgram: TOKEN_PROGRAM, stockTokenProgram: TOKEN_2022_PROGRAM, local: false,
      }
    }
  }
}

export function requireUsdcMint(config: ClusterConfig): Address {
  if (!config.usdcMint) {
    throw new Error(`no USDC mint for ${config.cluster}: run \`npx tsx scripts/assets/create.ts --cluster devnet\` or set BELLWETHER_DEVNET_USDC_MINT`)
  }
  return config.usdcMint
}

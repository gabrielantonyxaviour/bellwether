/**
 * Cluster config for the browser: which chain, which RPC, which program and mints, which
 * services. Resolved once at boot from three layers, later wins:
 *
 *   1. per-cluster defaults (public RPCs, mainnet USDC)
 *   2. build-time env (VITE_*), baked in by `vite build`
 *   3. runtime /config.json, fetched before first render
 *
 * /config.json lets one build be pointed at another cluster without rebuilding. When it names
 * a different `cluster` than the build's VITE_CLUSTER, the build's VITE_* values are dropped
 * (they describe the other cluster) and only defaults + config.json apply.
 */
import { address, type Address } from "@solana/kit"
import { z } from "zod"

export const CLUSTERS = ["fork", "devnet", "mainnet"] as const
export type Cluster = (typeof CLUSTERS)[number]

export const MAINNET_USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
export const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111")

export interface ClusterConfig {
  cluster: Cluster
  rpcUrl: string
  wsUrl: string
  /** Venue program id; null until deployed on this cluster. */
  programId: Address | null
  /** VenueConfig PDA (["venue", admin]); null until initialised on this cluster. */
  venue: Address | null
  /** Quote mint (classic SPL Token). Null on devnet until the test USDC mint exists. */
  usdcMint: Address | null
  /** Rehearsal stock mint BWRS (Token-2022). Null until created on this cluster. */
  bwrsMint: Address | null
  /** Symbol the Trade and Liquidity nav links open. */
  defaultSymbol: string
  /** Venue API (tape, symbols, venue, halts; notice and rehearsal when served). */
  apiBaseUrl: string
  /** Credential issuer (admit, revoke, credential status). */
  credentialApiUrl: string
  /** True for the local Surfpool fork (disposable state, custom RPC). */
  local: boolean
}

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 address")
const optionalText = z.string().trim().optional().transform((v) => (v ? v : undefined))
const httpOrWs = z.string().refine((v) => {
  try {
    return ["http:", "https:", "ws:", "wss:"].includes(new URL(v).protocol)
  } catch {
    return false
  }
}, "must be an http(s) or ws(s) URL")
const optionalUrl = optionalText.pipe(httpOrWs.optional())
const optionalAddress = optionalText.pipe(base58.optional())

/** Everything a layer may set. Missing keys fall through to the layer below. */
export const ConfigLayerSchema = z.object({
  cluster: z.enum(CLUSTERS).optional(),
  rpcUrl: optionalUrl,
  wsUrl: optionalUrl,
  programId: optionalAddress,
  venue: optionalAddress,
  usdcMint: optionalAddress,
  bwrsMint: optionalAddress,
  defaultSymbol: optionalText.pipe(z.string().regex(/^[A-Za-z0-9.]{1,8}$/).optional()),
  apiBaseUrl: optionalUrl,
  credentialApiUrl: optionalUrl,
})
export type ConfigLayer = z.infer<typeof ConfigLayerSchema>

const DEFAULTS: Record<Cluster, { rpcUrl: string; usdcMint: Address | null; defaultSymbol: string; local: boolean }> = {
  mainnet: { rpcUrl: "https://api.mainnet-beta.solana.com", usdcMint: MAINNET_USDC_MINT, defaultSymbol: "BWRS", local: false },
  devnet: { rpcUrl: "https://api.devnet.solana.com", usdcMint: null, defaultSymbol: "BWRS", local: false },
  fork: { rpcUrl: "http://127.0.0.1:8899", usdcMint: MAINNET_USDC_MINT, defaultSymbol: "FWDI", local: true },
}
/** services/api and services/credential default binds (BELLWETHER_API_PORT, CREDENTIAL_PORT). */
const DEFAULT_API = "http://localhost:8787"
const DEFAULT_CREDENTIAL_API = "http://localhost:8790"

/** http(s)://host:port → ws(s)://host:port+1 for a local validator; same host for hosted RPCs. */
export function wsUrlFor(rpcUrl: string, local: boolean): string {
  const url = new URL(rpcUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (local && url.port) url.port = String(Number(url.port) + 1)
  return url.toString()
}

/** Reads the VITE_* build-time layer. */
export function envLayer(env: Record<string, string | boolean | undefined>): ConfigLayer {
  const s = (k: string) => (typeof env[k] === "string" ? (env[k] as string) : undefined)
  return ConfigLayerSchema.parse({
    cluster: s("VITE_CLUSTER") || undefined,
    rpcUrl: s("VITE_RPC_URL"),
    wsUrl: s("VITE_WS_URL"),
    programId: s("VITE_PROGRAM_ID"),
    venue: s("VITE_VENUE"),
    usdcMint: s("VITE_USDC_MINT"),
    bwrsMint: s("VITE_BWRS_MINT"),
    defaultSymbol: s("VITE_DEFAULT_SYMBOL"),
    apiBaseUrl: s("VITE_API_BASE_URL"),
    credentialApiUrl: s("VITE_CREDENTIAL_API_URL"),
  })
}

/** Pure merge of the three layers; exported for tests. */
export function resolveClusterConfig(env: ConfigLayer, runtime: ConfigLayer = {}): ClusterConfig {
  const buildCluster = env.cluster ?? "devnet"
  const cluster = runtime.cluster ?? buildCluster
  const fromEnv = cluster === buildCluster ? env : {}
  const d = DEFAULTS[cluster]
  const pick = <K extends keyof ConfigLayer>(k: K) => runtime[k] ?? fromEnv[k]
  const rpcUrl = pick("rpcUrl") ?? d.rpcUrl
  const apiBaseUrl = (pick("apiBaseUrl") ?? DEFAULT_API).replace(/\/+$/, "")
  const addr = (k: "programId" | "venue" | "usdcMint" | "bwrsMint") => {
    const v = pick(k)
    return v ? address(v) : null
  }
  return {
    cluster,
    rpcUrl,
    wsUrl: pick("wsUrl") ?? wsUrlFor(rpcUrl, d.local),
    programId: addr("programId"),
    venue: addr("venue"),
    usdcMint: addr("usdcMint") ?? d.usdcMint,
    bwrsMint: addr("bwrsMint"),
    defaultSymbol: (pick("defaultSymbol") ?? d.defaultSymbol).toUpperCase(),
    apiBaseUrl,
    credentialApiUrl: (pick("credentialApiUrl") ?? DEFAULT_CREDENTIAL_API).replace(/\/+$/, ""),
    local: d.local,
  }
}

let current: ClusterConfig | null = null

/** Fetches /config.json (optional; a missing or empty file is fine) and resolves the config. */
export async function initClusterConfig(fetcher: typeof fetch = fetch): Promise<ClusterConfig> {
  let runtime: ConfigLayer = {}
  try {
    const res = await fetcher(`${import.meta.env.BASE_URL}config.json`, { cache: "no-store" })
    if (res.ok) {
      const parsed = ConfigLayerSchema.safeParse(await res.json())
      if (parsed.success) runtime = parsed.data
      else console.warn("[cluster] /config.json ignored:", parsed.error.issues[0]?.message)
    }
  } catch {
    // No runtime override: the build-time config stands.
  }
  current = resolveClusterConfig(envLayer(import.meta.env), runtime)
  return current
}

/** The resolved config. Available synchronously after initClusterConfig() (main.tsx awaits it). */
export function clusterConfig(): ClusterConfig {
  if (!current) throw new Error("clusterConfig() read before initClusterConfig() resolved")
  return current
}

/** Sets the config directly (tests, storybook-style harnesses). */
export function setClusterConfig(config: ClusterConfig): void {
  current = config
}

export type ExplorerKind = "tx" | "account" | "token"

/**
 * Solscan link. Devnet adds ?cluster=devnet; the fork points Solscan at its own RPC with
 * ?cluster=custom&customUrl=… (only resolvable from the machine that runs the fork).
 */
export function explorerUrl(kind: ExplorerKind, id: string, config: ClusterConfig = clusterConfig()): string {
  const url = new URL(`https://solscan.io/${kind}/${id}`)
  if (config.cluster === "devnet") url.searchParams.set("cluster", "devnet")
  if (config.cluster === "fork") {
    url.searchParams.set("cluster", "custom")
    url.searchParams.set("customUrl", config.rpcUrl)
  }
  return url.toString()
}

/** Chain id in Wallet Standard form, for signAndSendTransaction. The fork reports as mainnet. */
export function walletChain(config: ClusterConfig = clusterConfig()): `solana:${"mainnet" | "devnet"}` {
  return config.cluster === "devnet" ? "solana:devnet" : "solana:mainnet"
}

/** Emit the private service env and public browser config for an initialized venue. */
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { clusterConfig } from "../../config/clusters.js"
import { deployerPath, deploymentPath, ensureKey, type Deployment } from "./state.js"

export function writeRuntime(d: Deployment): void {
  if (!d.programId || !d.venue || !d.stockMint || !d.usdcMint) throw new Error("runtime requires program, venue and mints")
  const config = clusterConfig(d.cluster)
  const publicFile = deploymentPath(d.cluster).replace(/\.json$/, ".web.json")
  const customForkPort = d.cluster === "fork" && process.env.BELLWETHER_FORK_PORT && process.env.BELLWETHER_FORK_PORT !== "8899"
    ? Number(process.env.BELLWETHER_FORK_PORT) : null
  const apiPort = customForkPort ? customForkPort + 2 : 8787
  const credentialPort = customForkPort ? customForkPort + 3 : 8790
  const browser = {
    cluster: d.cluster, rpcUrl: d.rpcUrl, wsUrl: config.wsUrl, programId: d.programId, venue: d.venue,
    usdcMint: d.usdcMint, bwrsMint: d.stockMint, defaultSymbol: "BWRS",
    apiBaseUrl: `http://localhost:${apiPort}`, credentialApiUrl: `http://localhost:${credentialPort}`,
  }
  mkdirSync(dirname(publicFile), { recursive: true })
  writeFileSync(publicFile, JSON.stringify(browser, null, 2) + "\n")

  const suffix = d.cluster === "fork" && process.env.BELLWETHER_FORK_PORT && process.env.BELLWETHER_FORK_PORT !== "8899"
    ? `fork-${process.env.BELLWETHER_FORK_PORT}` : d.cluster
  const envFile = `services/.env.${suffix}`
  const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : ""
  const oldToken = existing.match(/^CREDENTIAL_OPERATOR_TOKEN=(.+)$/m)?.[1]
  const token = oldToken ?? randomBytes(24).toString("hex")
  const env: Record<string, string> = {
    BELLWETHER_CLUSTER: d.cluster,
    BELLWETHER_PROGRAM_ID: d.programId,
    BELLWETHER_VENUE_PROGRAM_ID: d.programId,
    BELLWETHER_VENUE: d.venue,
    BELLWETHER_RPC_URL: d.rpcUrl,
    BELLWETHER_WS_URL: config.wsUrl,
    BELLWETHER_STOCK_MINT: d.stockMint,
    BELLWETHER_USDC_MINT: d.usdcMint,
    BELLWETHER_TAPE_DB: `services/indexer/.data/${suffix}.sqlite`,
    BELLWETHER_API_PORT: String(apiPort),
    BELLWETHER_HALT_LEDGER: `services/relay/data/${suffix}/relay.json`,
    RELAY_RPC_URL: d.rpcUrl,
    RELAY_KEYPAIR_PATH: resolve(ensureKey(d.cluster, "relay")),
    RELAY_PROGRAM_ID: d.programId,
    RELAY_VENUE: d.venue,
    RELAY_SYMBOL_MAP: JSON.stringify([{ nasdaq: "FWDI", stockMint: d.stockMint, ticker: "BWRS" }]),
    RELAY_DATA_DIR: `services/relay/data/${suffix}`,
    RELAY_NYSE_FALLBACK: "1",
    CAPS_RPC_URL: d.rpcUrl,
    CAPS_PROGRAM_ID: d.programId,
    CAPS_VENUE: d.venue,
    CAPS_DATA_AUTHORITY_KEYPAIR: resolve(ensureKey(d.cluster, "data-authority")),
    CAPS_SYMBOLS: "BWRS",
    ...(d.cluster === "fork" && d.symbol ? { CAPS_SYMBOL_ACCOUNTS: d.symbol } : {}),
    CREDENTIAL_CLUSTER: d.cluster,
    CREDENTIAL_RPC_URL: d.rpcUrl,
    CREDENTIAL_ISSUER_KEYPAIR: resolve(ensureKey(d.cluster, "credential-issuer")),
    CREDENTIAL_FREEZE_AUTHORITY_KEYPAIR: resolve(ensureKey(d.cluster, "freeze-authority")),
    CREDENTIAL_PAYER_KEYPAIR: resolve(deployerPath),
    CREDENTIAL_GATE: "sas",
    CREDENTIAL_PORT: String(credentialPort),
    CREDENTIAL_OPERATOR_TOKEN: token,
    CREDENTIAL_DATA_DIR: `services/credential/data/${suffix}`,
  }
  writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 })
  chmodSync(envFile, 0o600)
  process.stdout.write(`service env: ${envFile}; browser config: ${publicFile}\n`)
}

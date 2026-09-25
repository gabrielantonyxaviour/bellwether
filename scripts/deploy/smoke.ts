/** Real admission HTTP call → on-chain swap → indexer tape, on the chosen cluster. */
import { readFileSync } from "node:fs"
import { address, type Address } from "@solana/kit"
import { getTransferSolInstruction } from "@solana-program/system"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintToCheckedInstruction } from "@solana-program/token"
import { z } from "zod"
import { clusterConfig, parseCluster } from "../../config/clusters.js"
import { errorText, loadKeypairSigner } from "../assets/tx.js"
import { setTokenBalance } from "../../services/credential/fork/surfnet.js"
import { associatedStockAccount } from "../assets/thaw.js"
import { attestationAddress, sasIdentity } from "../../services/credential/sas.js"
import * as v from "../../services/credential/venue-ix.js"
import { deployerPath, key, loadDeployment, mark } from "./state.js"
import { createDeploymentChain } from "./chain.js"

function env(cluster: string) {
  const suffix = cluster === "fork" && process.env.BELLWETHER_FORK_PORT && process.env.BELLWETHER_FORK_PORT !== "8899"
    ? `fork-${process.env.BELLWETHER_FORK_PORT}` : cluster
  const out: Record<string, string> = {}
  for (const line of readFileSync(`services/.env.${suffix}`, "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

async function waitForPrint(api: string, signature: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(`${api}/tape?limit=50`)
    if (!response.ok) throw new Error(`GET /tape returned ${response.status}`)
    const body = await response.json()
    if (JSON.stringify(body).includes(signature)) return body
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  throw new Error(`swap ${signature} did not appear on GET /tape within 30 seconds`)
}

async function main() {
  const index = process.argv.indexOf("--cluster")
  if (index < 0) throw new Error("--cluster fork|devnet is required")
  const cluster = parseCluster(process.argv[index + 1])
  if (cluster === "mainnet") throw new Error("mainnet smoke requires its separate approval path")
  const d = loadDeployment(cluster)
  if (!d?.programId || !d.venue || !d.symbol || !d.pool || !d.stockMint || !d.usdcMint || !d.stockVault || !d.usdcVault) throw new Error("deployment journal incomplete")
  const e = env(cluster)
  const api = `http://127.0.0.1:${e.BELLWETHER_API_PORT ?? 8787}`
  const credentialApi = `http://127.0.0.1:${e.CREDENTIAL_PORT ?? 8790}`
  if (!e.CREDENTIAL_OPERATOR_TOKEN) throw new Error("credential operator token missing")
  if (d.completed.includes("smokeSwap") && d.signatures.smokeSwap) {
    await waitForPrint(api, d.signatures.smokeSwap)
    process.stdout.write(`smoke read-back passed: ${d.signatures.smokeSwap} on GET /tape\n`)
    return
  }
  const chain = createDeploymentChain(clusterConfig(cluster).rpcUrl)
  if (chain.rpcUrl !== d.rpcUrl) throw new Error(`runtime RPC ${chain.rpcUrl} differs from deployment ${d.rpcUrl}`)
  const payer = await loadKeypairSigner(deployerPath)
  const trader = await key(cluster, "smoke-trader")
  const issuer = await key(cluster, "credential-issuer")
  const market: v.PoolKeys = { venue: address(d.venue), symbol: address(d.symbol), pool: address(d.pool),
    stockMint: address(d.stockMint), usdcMint: address(d.usdcMint), stockVault: address(d.stockVault), usdcVault: address(d.usdcVault) }
  if (cluster === "fork") await chain.fundSol(trader.address, 100_000_000n)
  else if (!d.completed.includes("smokeFundSol")) {
    mark(d, "smokeFundSol", await chain.send([getTransferSolInstruction({ source: payer, destination: trader.address, amount: 50_000_000n })], payer))
  }
  const [traderUsdc] = await findAssociatedTokenPda({ owner: trader.address, mint: market.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  if (!d.completed.includes("smokeFundUsdc")) {
    if (cluster === "fork") {
      await setTokenBalance(chain.rpcUrl, trader.address, market.usdcMint, 100_000n, TOKEN_PROGRAM_ADDRESS)
      mark(d, "smokeFundUsdc")
    } else {
      mark(d, "smokeFundUsdc", await chain.send([
        getCreateAssociatedTokenIdempotentInstruction({ payer, ata: traderUsdc, owner: trader.address, mint: market.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        getMintToCheckedInstruction({ mint: market.usdcMint, token: traderUsdc, mintAuthority: payer, amount: 100_000n, decimals: 6 }),
      ], payer))
    }
  }
  const response = await fetch(`${credentialApi}/admit`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${e.CREDENTIAL_OPERATOR_TOKEN}` },
    body: JSON.stringify({ wallet: trader.address }), signal: AbortSignal.timeout(45_000),
  })
  const admitted = await response.json()
  if (!response.ok || (admitted as { status?: string }).status !== "admitted") throw new Error(`credential API admission failed: ${response.status} ${JSON.stringify(admitted)}`)
  const identity = await sasIdentity(issuer.address)
  const credential = await attestationAddress(identity, trader.address)
  const account = await associatedStockAccount(trader.address, market.stockMint)
  const swap = await chain.send([v.swapIx(address(d.programId), market, trader, account, traderUsdc, credential, v.BUY, 10_000n, 1n)], trader)
  mark(d, "smokeSwap", swap)
  const print = await waitForPrint(api, swap)
  process.stdout.write(`smoke passed: admitted ${trader.address}; swap ${swap}; GET /tape contains print (${JSON.stringify(print).length} response bytes)\n`)
}

main().catch((error) => { process.stderr.write(`smoke failed: ${errorText(error)}\n`); process.exitCode = 1 })

/** Fresh wallet → public signed admission/funding → devnet swap → public tape. */
import { address } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token"
import { z } from "zod"
import { associatedStockAccount } from "../assets/thaw.js"
import { errorText } from "../assets/tx.js"
import { attestationAddress, sasIdentity } from "../../services/credential/sas.js"
import * as venue from "../../services/credential/venue-ix.js"
import { createDeploymentChain } from "./chain.js"
import { key, loadDeployment, saveDeployment } from "./state.js"

const origin = "https://bellwether-api.larinova.com"
const challengeSchema = z.object({ wallet: z.string(), message: z.string().min(1), expiresAt: z.string() })
const admitSchema = z.object({ status: z.literal("admitted"), signature: z.string().nullable(),
  funding: z.object({ status: z.enum(["funded", "already_funded"]), signature: z.string().nullable(),
    solLamports: z.string(), testUsdcRaw: z.string() }),
})

async function responseJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) })
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function waitForPrint(signature: string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const tape = await responseJson(`${origin}/tape?limit=50`)
    if (JSON.stringify(tape).includes(signature)) return
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`public tape has not indexed ${signature} after 90 seconds`)
}

async function main() {
  const deployment = loadDeployment("devnet")
  if (!deployment?.programId || !deployment.venue || !deployment.symbol || !deployment.pool ||
      !deployment.stockMint || !deployment.usdcMint || !deployment.stockVault || !deployment.usdcVault) {
    throw new Error("devnet deployment journal is incomplete")
  }
  const health = z.object({ ok: z.literal(true), cluster: z.literal("devnet") }).passthrough()
    .parse(await responseJson(`${origin}/health`))
  if (!health.ok) throw new Error("public credential health failed")
  const trader = await key("devnet", "public-smoke-trader")
  const issuer = await key("devnet", "credential-issuer")
  const chain = createDeploymentChain(deployment.rpcUrl)
  const [traderUsdc] = await findAssociatedTokenPda({
    owner: trader.address, mint: address(deployment.usdcMint), tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  const credential = await attestationAddress(await sasIdentity(issuer.address), trader.address)
  const market: venue.PoolKeys = {
    venue: address(deployment.venue), symbol: address(deployment.symbol), pool: address(deployment.pool),
    stockMint: address(deployment.stockMint), usdcMint: address(deployment.usdcMint),
    stockVault: address(deployment.stockVault), usdcVault: address(deployment.usdcVault),
  }

  if (!deployment.signatures.publicFreshSwap) {
    const challenge = challengeSchema.parse(await responseJson(`${origin}/admit/challenge?wallet=${trader.address}`))
    if (challenge.wallet !== trader.address) throw new Error("challenge wallet mismatch")
    const signature = Buffer.from(await crypto.subtle.sign("Ed25519", trader.keyPair.privateKey,
      new TextEncoder().encode(challenge.message))).toString("base64")
    const admitted = admitSchema.parse(await responseJson(`${origin}/admit`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://bellwether.larinova.com" },
      body: JSON.stringify({ wallet: trader.address, message: challenge.message, signature }),
    }))
    if (admitted.funding.status === "funded" && admitted.funding.signature) {
      deployment.signatures.publicFreshFunding = admitted.funding.signature
    }
    if (!deployment.signatures.publicFreshFunding) throw new Error("fresh wallet has no recorded funding transaction")
    if (admitted.signature) deployment.signatures.publicFreshAdmission = admitted.signature
    saveDeployment(deployment)
    const [sol, usdc] = await Promise.all([
      chain.rpc.getBalance(trader.address).send(),
      chain.rpc.getTokenAccountBalance(traderUsdc).send(),
    ])
    if (sol.value < 10_000_000n || BigInt(usdc.value.amount) < 10_000n) {
      throw new Error("fresh wallet lacks funded devnet SOL or test USDC")
    }
    const swap = await chain.send([venue.swapIx(address(deployment.programId), market, trader,
      await associatedStockAccount(trader.address, market.stockMint), traderUsdc,
      credential, venue.BUY, 10_000n, 1n)], trader)
    deployment.signatures.publicFreshSwap = swap
    saveDeployment(deployment)
  }
  await waitForPrint(deployment.signatures.publicFreshSwap)
  process.stdout.write(`public smoke passed: wallet ${trader.address}; swap ${deployment.signatures.publicFreshSwap}; funding ${deployment.signatures.publicFreshFunding}; ${origin}/tape\n`)
}

main().catch((error) => { process.stderr.write(`public smoke failed: ${errorText(error)}\n`); process.exitCode = 1 })

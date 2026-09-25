/** Resumable venue bootstrap. Mainnet always stops at the plan unless explicitly authorized. */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { address, type Address } from "@solana/kit"
import { getTransferSolInstruction } from "@solana-program/system"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token"
import { z } from "zod"
import { clusterConfig, parseCluster } from "../../config/clusters.js"
import { errorText, loadKeypairSigner } from "../assets/tx.js"
import { createRehearsalMint, readRehearsalMint, rehearsalMintSizes } from "../assets/rehearsal-mint.js"
import { createTestUsdc } from "../assets/test-usdc.js"
import { admitInstructions } from "../assets/thaw.js"
import { sasBackend, sasIdentity } from "../../services/credential/sas.js"
import { withRetry } from "../../services/credential/retry.js"
import * as v from "../../services/credential/venue-ix.js"
import { deployerPath, ensureKey, key, loadDeployment, mark, saveDeployment, type Deployment } from "./state.js"
import { writeRuntime } from "./runtime.js"
import { finishVenue } from "./finish.js"
import { createDeploymentChain } from "./chain.js"

const argsSchema = z.object({ cluster: z.string(), "confirm-mainnet": z.boolean().default(false), execute: z.boolean().default(false), "seed-usdc": z.coerce.number().positive().max(10_000).default(3) })
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
const SO = "programs/venue/target/deploy/bellwether_venue.so"

function args(argv: string[]) {
  const raw: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith("--")) throw new Error(`unexpected argument ${flag}`)
    const name = flag.slice(2)
    if (name === "execute" || name === "confirm-mainnet") raw[name] = true
    else raw[name] = argv[++i] ?? ""
  }
  return argsSchema.parse(raw)
}

async function lastClose(): Promise<{ price: number; source: string; date: string }> {
  const source = "https://api.nasdaq.com/api/quote/FWDI/summary?assetclass=stocks"
  const response = await fetch(source, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`FWDI last close source returned HTTP ${response.status}`)
  const parsed = z.object({ data: z.object({ summaryData: z.object({ PreviousClose: z.object({ value: z.string() }) }) }) }).parse(await response.json())
  const price = Number(parsed.data.summaryData.PreviousClose.value.replace(/[$,]/g, ""))
  if (!Number.isFinite(price) || price <= 0) throw new Error("FWDI previous close source returned no positive price")
  return { price, source, date: new Date().toISOString().slice(0, 10) }
}

async function main() {
  const option = args(process.argv.slice(2))
  const cluster = parseCluster(option.cluster)
  if (!existsSync(deployerPath)) throw new Error(`deployer keypair missing at ${deployerPath}`)
  if (!existsSync(SO)) throw new Error(`compiled program missing at ${SO}`)
  const config = clusterConfig(cluster)
  const chain = createDeploymentChain(config.rpcUrl)
  const genesisHash = await withRetry(() => chain.rpc.getGenesisHash().send())
  if (cluster === "devnet" && genesisHash !== DEVNET) throw new Error(`devnet RPC has genesis ${genesisHash}`)
  if (cluster !== "devnet" && genesisHash !== MAINNET) throw new Error(`${cluster} RPC has genesis ${genesisHash}`)
  if (cluster === "fork" && !["127.0.0.1", "localhost"].includes(new URL(config.rpcUrl).hostname)) throw new Error("fork RPC must be local")
  const payer = await loadKeypairSigner(deployerPath)
  const expectedDeployer = address("CXMB67kJoMrYNKLyQNHc1nXMWW6DbubmxxSQZ7UfsgZq")
  if (payer.address !== expectedDeployer) throw new Error(`deployer keypair is ${payer.address}, expected ${expectedDeployer}`)
  if (cluster === "mainnet" && !option["confirm-mainnet"]) throw new Error("mainnet requires --confirm-mainnet; no transaction sent")
  const program = await key(cluster, "program")
  const admin = await key(cluster, "venue-admin")
  const relay = await key(cluster, "relay")
  const dataAuthority = await key(cluster, "data-authority")
  const issuer = await key(cluster, "credential-issuer")
  const freezeAuthority = await key(cluster, "freeze-authority")
  const mintAuthority = await key(cluster, "mint-authority")
  const stockMint = await key(cluster, "stock-mint")
  const usdcMintKey = cluster === "devnet" ? await key(cluster, "test-usdc-mint") : null
  const sas = await sasIdentity(issuer.address)
  const venue = await v.venuePda(program.address, admin.address)
  const symbol = await v.symbolPda(program.address, venue, stockMint.address)
  const pool = await v.poolPda(program.address, symbol)
  const usdcMint = usdcMintKey?.address ?? config.usdcMint
  if (!usdcMint) throw new Error("no quote mint")
  const stockVault = (await admitInstructions({ payer, owner: pool, mint: stockMint.address, freezeAuthority })).account
  const [usdcVault] = await findAssociatedTokenPda({ owner: pool, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const { value: balance } = await withRetry(() => chain.rpc.getBalance(payer.address).send())
  const elfSize = readFileSync(SO).length
  const rentProgram = await withRetry(() => chain.rpc.getMinimumBalanceForRentExemption(BigInt(elfSize + 45)).send())
  const rentProgramAccount = await withRetry(() => chain.rpc.getMinimumBalanceForRentExemption(36n).send())
  const mintRent = await withRetry(() => chain.rpc.getMinimumBalanceForRentExemption(BigInt(rehearsalMintSizes({ payer, mint: stockMint, mintAuthority, freezeAuthority: freezeAuthority.address }).rentSpace)).send())
  const roleFunding = 180_000_000n
  const accountAndFeeReserve = 50_000_000n
  const minimumPeak = rentProgram * 2n + rentProgramAccount + mintRent + roleFunding + accountAndFeeReserve
  const plan = { cluster, genesisHash, payer: payer.address, programId: program.address, venue, stockMint: stockMint.address,
    usdcMint, seedUsdc: option["seed-usdc"], programBytes: elfSize, programDataRentLamports: String(rentProgram),
    temporaryBufferRentLamports: String(rentProgram), programAccountRentLamports: String(rentProgramAccount),
    stockMintRentLamports: String(mintRent), roleFundingLamports: String(roleFunding),
    accountAndFeeReserveLamports: String(accountAndFeeReserve), minimumPeakLamports: String(minimumPeak), balanceLamports: String(balance) }
  process.stdout.write(`${JSON.stringify({ plan }, null, 2)}\n`)
  if (cluster === "mainnet" && !option.execute) return
  if (cluster === "mainnet" && balance < minimumPeak) throw new Error(`mainnet deployer needs at least ${minimumPeak} lamports working balance; has ${balance}`)
  if (cluster === "devnet" && balance < 1_000_000_000n) throw new Error(`deployer requires at least 1 devnet SOL; has ${balance} lamports`)
  if (cluster === "fork" && balance < 1_000_000_000n) await chain.fundSol(payer.address, 2_000_000_000n)
  const record: Deployment = loadDeployment(cluster) ?? {
    cluster, rpcUrl: config.rpcUrl, genesisHash, deployer: payer.address, signatures: {}, completed: [], durationsMs: {},
  }
  if (record.genesisHash !== genesisHash || record.deployer !== payer.address || record.rpcUrl !== config.rpcUrl) throw new Error("deployment journal belongs to another chain or deployer")
  Object.assign(record, { programId: program.address, venue, stockMint: stockMint.address, usdcMint, symbol, pool, stockVault, usdcVault,
    sasCredential: sas.credential, sasSchema: sas.schema })
  saveDeployment(record)
  const done = (step: string) => record.completed.includes(step)
  const requireAccount = async (step: string, account: Address) => {
    if (done(step) && !(await withRetry(() => chain.rpc.getAccountInfo(account, { encoding: "base64" }).send())).value) throw new Error(`${step} journaled but ${account} missing`)
  }
  if (!done("program")) {
    const output = execFileSync("solana", ["program", "deploy", "--url", config.rpcUrl, "--keypair", deployerPath,
      "--program-id", ensureKey(cluster, "program"), "--upgrade-authority", deployerPath, "--max-len", String(elfSize), "--output", "json", SO],
      { encoding: "utf8", maxBuffer: 1024 * 1024 })
    const deployed = z.object({ programId: z.string(), signature: z.string().optional() }).parse(JSON.parse(output))
    if (deployed.programId !== program.address) throw new Error(`CLI deployed ${deployed.programId}, expected ${program.address}`)
    mark(record, "program", deployed.signature)
  }
  await requireAccount("program", program.address)
  for (const [name, signer, lamports] of [["admin", admin, 100_000_000n], ["relay", relay, 30_000_000n],
    ["dataAuthority", dataAuthority, 30_000_000n], ["issuer", issuer, 20_000_000n]] as const) {
    const step = `fund:${name}`
    if (done(step)) continue
    const current = (await withRetry(() => chain.rpc.getBalance(signer.address).send())).value
    if (current >= lamports) { mark(record, step); continue }
    const sig = await chain.send([getTransferSolInstruction({ source: payer, destination: signer.address, amount: lamports - current })], payer)
    mark(record, step, sig)
  }
  if (!done("stockMint")) {
    const existing = await withRetry(() => chain.rpc.getAccountInfo(stockMint.address, { encoding: "base64" }).send())
    if (existing.value) {
      const mint = await readRehearsalMint(chain.rpc, stockMint.address)
      if (mint.freezeAuthority !== freezeAuthority.address || mint.mintAuthority !== mintAuthority.address || mint.metadata?.symbol !== "BWRS") {
        throw new Error(`existing stock mint ${stockMint.address} does not match the deployment authorities and metadata`)
      }
      const history = await withRetry(() => chain.rpc.getSignaturesForAddress(stockMint.address, { limit: 1 }).send())
      mark(record, "stockMint", history[0]?.signature)
    } else {
      const created = await createRehearsalMint(chain, { payer, mint: stockMint, mintAuthority, freezeAuthority: freezeAuthority.address })
      mark(record, "stockMint", created.signature)
    }
  }
  await requireAccount("stockMint", stockMint.address)
  if (usdcMintKey && !done("testUsdcMint")) {
    const existing = await withRetry(() => chain.rpc.getAccountInfo(usdcMint, { encoding: "base64" }).send())
    if (existing.value) {
      if (existing.value.owner !== TOKEN_PROGRAM_ADDRESS) throw new Error(`existing test USDC mint ${usdcMint} has wrong owner`)
      const history = await withRetry(() => chain.rpc.getSignaturesForAddress(usdcMint, { limit: 1 }).send())
      mark(record, "testUsdcMint", history[0]?.signature)
    } else {
      const created = await createTestUsdc(chain, { payer, mint: usdcMintKey, mintAuthority: payer.address })
      mark(record, "testUsdcMint", created.signature)
    }
  }
  if (usdcMintKey) await requireAccount("testUsdcMint", usdcMint)
  if (!done("sas")) {
    const backend = sasBackend({ chain, payer, issuer, identity: sas, onSetup: ({ signature }) => { if (signature) mark(record, "sas", signature) } })
    await backend.ensureReady()
    if (!done("sas")) mark(record, "sas")
  }
  if (!done("venue")) {
    mark(record, "venue", await chain.send([await v.initVenueIx(program.address, admin, {
      gate: v.GATE_SAS, heartbeatMaxAge: 180n, cutoff: 28_800n, relay: relay.address, dataAuthority: dataAuthority.address,
      credentialIssuer: issuer.address, sasCredential: sas.credential, sasSchema: sas.schema, affiliateGroup: admin.address,
    })], payer))
  }
  await requireAccount("venue", venue)
  if (!done("symbol")) mark(record, "symbol", await chain.send([await v.registerSymbolIx(program.address, admin, venue, stockMint.address, 2, true, "BWRS")], payer))
  if (!done("vaults")) mark(record, "vaults", await chain.send([
    ...(await admitInstructions({ payer, owner: pool, mint: stockMint.address, freezeAuthority })).instructions,
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: usdcVault, owner: pool, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
  ], payer))
  if (!done("pool")) mark(record, "pool", await chain.send([v.initPoolIx(program.address, admin, {
    venue, symbol, pool, stockMint: stockMint.address, usdcMint, stockVault, usdcVault,
  }, 30)], payer))
  if (!done("activate")) mark(record, "activate", await chain.send([v.activatePoolIx(program.address, admin, venue, symbol)], payer))
  writeRuntime(record)
  await finishVenue({ chain, record, payer, admin, relay, dataAuthority, issuer, freezeAuthority, mintAuthority, stockMint,
    usdcMint, sas, seedUsdc: option["seed-usdc"], close: await lastClose() })
  process.stdout.write(`deployment setup complete; journal ${cluster}.json\n`)
}

main().catch((error) => { process.stderr.write(`go-live failed: ${errorText(error)}\n`); process.exitCode = 1 })

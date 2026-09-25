/**
 * Create the rehearsal stock mint (and, on devnet, a test USDC mint) and record the addresses.
 *
 *   npx tsx scripts/assets/create.ts --cluster fork   --payer <keypair.json> [--out <file>]
 *   npx tsx scripts/assets/create.ts --cluster devnet --payer <keypair.json>
 *   npx tsx scripts/assets/create.ts --cluster mainnet --payer <keypair.json> --confirm-mainnet
 *
 * Optional: --mint-authority <keypair.json> (default: payer), --freeze-authority <keypair.json|address>
 * (the venue key; default: payer), --mint-keypair <keypair.json> (default: fresh), --uri <uri>.
 * Mainnet spends real SOL (mint rent ≈ 0.005 SOL) and refuses to run without --confirm-mainnet.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { address, generateKeyPairSigner, lamports as toLamports, type Address, type KeyPairSigner } from "@solana/kit"
import { z } from "zod"
import { DEPLOYMENTS_DIR, clusterConfig, parseCluster } from "../../config/clusters.js"
import { REHEARSAL, createRehearsalMint, readRehearsalMint, rehearsalMintSizes } from "./rehearsal-mint.js"
import { createTestUsdc } from "./test-usdc.js"
import { createChain, errorText, loadKeypairSigner } from "./tx.js"

const argsSchema = z.object({
  cluster: z.string(),
  payer: z.string().min(1),
  "mint-authority": z.string().optional(),
  "freeze-authority": z.string().optional(),
  "mint-keypair": z.string().optional(),
  uri: z.string().url().or(z.literal("")).optional(),
  out: z.string().optional(),
  "confirm-mainnet": z.boolean().optional(),
})

function parseArgs(argv: string[]): z.infer<typeof argsSchema> {
  const raw: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "")
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`)
    if (key === "confirm-mainnet") raw[key] = true
    else raw[key] = argv[++i] ?? ""
  }
  return argsSchema.parse(raw)
}

async function signerOrAddress(value: string | undefined, fallback: KeyPairSigner): Promise<{ signer?: KeyPairSigner; address: Address }> {
  if (!value) return { signer: fallback, address: fallback.address }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return { address: address(value) }
  const signer = await loadKeypairSigner(value)
  return { signer, address: signer.address }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cluster = parseCluster(args.cluster)
  if (cluster === "mainnet" && !args["confirm-mainnet"]) {
    throw new Error("mainnet creation spends real SOL; rerun with --confirm-mainnet once the amount is approved")
  }
  const config = clusterConfig(cluster)
  const chain = createChain(config.rpcUrl)
  const payer = await loadKeypairSigner(args.payer)
  const mintAuthority = args["mint-authority"] ? await loadKeypairSigner(args["mint-authority"]) : payer
  const venue = await signerOrAddress(args["freeze-authority"], payer)
  const mint = args["mint-keypair"] ? await loadKeypairSigner(args["mint-keypair"]) : await generateKeyPairSigner()

  const input = { payer, mint, mintAuthority, freezeAuthority: venue.address, uri: args.uri }
  const { rentSpace } = rehearsalMintSizes(input)
  const rent = await chain.rpc.getMinimumBalanceForRentExemption(BigInt(rentSpace)).send()
  if (config.local) {
    const { value: balance } = await chain.rpc.getBalance(payer.address).send()
    if (balance < toLamports(1_000_000_000n)) await chain.fundSol(payer.address, 2_000_000_000n)
  }
  process.stdout.write(`${cluster}: creating ${REHEARSAL.symbol} (${rentSpace} B, rent ${rent} lamports) payer ${payer.address}\n`)
  const created = await createRehearsalMint(chain, input)
  const state = await readRehearsalMint(chain.rpc, created.mint)

  let usdcMint = config.usdcMint
  let usdcSignature: string | undefined
  if (cluster === "devnet" && !usdcMint) {
    const usdc = await createTestUsdc(chain, { payer, mint: await generateKeyPairSigner(), mintAuthority: payer.address })
    usdcMint = usdc.mint
    usdcSignature = usdc.signature
  }

  const record = {
    cluster, rpcUrl: config.rpcUrl, createdAt: new Date().toISOString(),
    stockMint: created.mint, stockTokenProgram: state.tokenProgram, createSignature: created.signature,
    name: state.metadata?.name, symbol: state.metadata?.symbol, decimals: state.decimals,
    mintAuthority: state.mintAuthority, freezeAuthority: state.freezeAuthority, permanentDelegate: state.permanentDelegate,
    scaledUiMultiplier: state.scaledUiAmount?.multiplier, defaultAccountState: state.defaultAccountState,
    rentLamports: created.lamports.toString(),
    usdcMint, usdcSource: config.usdcSource, ...(usdcSignature ? { usdcCreateSignature: usdcSignature } : {}),
  }
  const out = args.out ?? join(DEPLOYMENTS_DIR, `${cluster}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n")
  process.stdout.write(`${JSON.stringify(record, null, 2)}\nwrote ${out}\n`)
}

main().catch((error) => {
  process.stderr.write(`create failed: ${errorText(error)}\n`)
  process.exit(1)
})

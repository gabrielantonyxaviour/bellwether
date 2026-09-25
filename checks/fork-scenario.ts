/** Fresh, local mainnet-fork acceptance: real FWDI mint, live venue instructions, time travel. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AccountRole, address, generateKeyPairSigner, type TransactionSigner } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda as usdcAta, getCreateAssociatedTokenIdempotentInstruction as createUsdcAta } from "@solana-program/token"
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda as stockAta, getCreateAssociatedTokenIdempotentInstruction as createStockAta } from "@solana-program/token-2022"
import { MAINNET_USDC_MINT } from "../config/clusters.js"
import { startOwnFork, nextSlots, chainNow, timeTravelTo } from "../services/notice/fork/env.js"
import { deployUpgradeable } from "../services/notice/fork/deploy.js"
import { createChain, errorText } from "../scripts/assets/tx.js"
import { setTokenBalance } from "../services/credential/fork/surfnet.js"
import * as venue from "../services/indexer/venue-ix.js"

const FWDI = address("7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9")
const TSLA_X = address("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB")
const PORT = 8960
const DAY = 86_400
const outPath = join("scripts", "fork", "out", "fork-scenario.json")

function code(error: unknown): number | null {
  const message = errorText(error)
  const hex = message.match(/custom program error: 0x([0-9a-f]+)/i)
  if (hex) return Number.parseInt(hex[1], 16)
  const dec = message.match(/"?Custom"?\s*[:(]\s*(\d+)/)
  return dec ? Number(dec[1]) : null
}

async function main() {
  const fork = await startOwnFork(PORT)
  const signatures: Record<string, string> = {}
  const observed: Record<string, number | string> = {}
  try {
    const chain = createChain(fork.rpcUrl)
    const [payer, program, buffer, admin, trader] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()))
    for (const signer of [payer, admin, trader]) await chain.fundSol(signer.address, 50_000_000_000n)
    const elf = readFileSync("programs/venue/target/deploy/bellwether_venue.so")
    const deployed = await deployUpgradeable(chain, { payer, program, buffer, upgradeAuthority: payer, elf })
    signatures.deploy = deployed.signature
    await nextSlots(fork.rpcUrl)
    const programId = program.address
    const venueId = await venue.venuePda(programId, admin.address)
    const symbol = await venue.symbolPda(programId, venueId, FWDI)
    const thirdParty = await venue.symbolPda(programId, venueId, TSLA_X)
    const pool = await venue.poolPda(programId, symbol)
    const [stockVault] = await stockAta({ owner: pool, mint: FWDI, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    const [usdcVault] = await usdcAta({ owner: pool, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    const market: venue.MarketAccounts = { venue: venueId, symbol, pool, stockMint: FWDI, usdcMint: MAINNET_USDC_MINT, stockVault, usdcVault }
    const send = async (name: string, instructions: Parameters<typeof chain.send>[0], signer: TransactionSigner) => {
      const signature = await chain.send(instructions, signer)
      signatures[name] = signature
      process.stdout.write(`${name}: ${signature}\n`)
      return signature
    }
    const reject = async (name: string, expected: number, instructions: Parameters<typeof chain.send>[0], signer: TransactionSigner) => {
      let actual: number | null = null
      try { await chain.send(instructions, signer) } catch (error) { actual = code(error) }
      if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`)
      observed[name] = actual
      process.stdout.write(`${name}: rejected with ${actual}\n`)
    }

    await send("initVenue", [venue.initVenue(programId, {
      admin, venue: venueId, gate: venue.GATE_MEMBER, heartbeatMaxAge: 180n, tradeDateCutoff: 28_800n,
      relay: admin.address, dataAuthority: admin.address, credentialIssuer: admin.address,
      sasCredential: admin.address, sasSchema: admin.address, affiliateGroup: admin.address,
    })], admin)
    await send("registerFwdi", [venue.registerSymbol(programId, { admin, venue: venueId, symbol, stockMint: FWDI, tier: 2, sponsored: true, ticker: "FWDI" })], admin)
    await send("registerThirdParty", [venue.registerSymbol(programId, { admin, venue: venueId, symbol: thirdParty, stockMint: TSLA_X, tier: 1, sponsored: false, ticker: "TSLAx" })], admin)

    await send("createVaults", [
      createStockAta({ payer: admin, ata: stockVault, owner: pool, mint: FWDI, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      createUsdcAta({ payer: admin, ata: usdcVault, owner: pool, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    ], admin)
    // Superstate alone can thaw real FWDI accounts. Surfpool changes their fork-only state
    // to represent explicit transfer-agent approval; the public devnet path never uses this.
    await setTokenBalance(fork.rpcUrl, pool, FWDI, 0n, TOKEN_2022_PROGRAM_ADDRESS)
    await send("initPool", [venue.initPool(programId, { admin, feeBps: 30, ...market })], admin)

    const [lpStock] = await stockAta({ owner: admin.address, mint: FWDI, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    const [lpUsdc] = await usdcAta({ owner: admin.address, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    const [traderStock] = await stockAta({ owner: trader.address, mint: FWDI, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    const [traderUsdc] = await usdcAta({ owner: trader.address, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    await send("createAccounts", [
      createStockAta({ payer: admin, ata: lpStock, owner: admin.address, mint: FWDI, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      createStockAta({ payer: admin, ata: traderStock, owner: trader.address, mint: FWDI, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      createUsdcAta({ payer: admin, ata: lpUsdc, owner: admin.address, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      createUsdcAta({ payer: admin, ata: traderUsdc, owner: trader.address, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    ], admin)
    for (const [owner, mint, amount, tokenProgram] of [
      [admin.address, FWDI, 100_000_000n, TOKEN_2022_PROGRAM_ADDRESS],
      [admin.address, MAINNET_USDC_MINT, 1_000_000_000n, TOKEN_PROGRAM_ADDRESS],
      [trader.address, FWDI, 0n, TOKEN_2022_PROGRAM_ADDRESS],
      [trader.address, MAINNET_USDC_MINT, 10_000_000n, TOKEN_PROGRAM_ADDRESS],
    ] as const) await setTokenBalance(fork.rpcUrl, owner, mint, amount, tokenProgram)

    const expiry = BigInt((await chainNow(fork.rpcUrl)) + 200 * DAY)
    await send("admit", [
      venue.grantMember(programId, { issuer: admin, venue: venueId, member: await venue.memberPda(programId, venueId, admin.address), wallet: admin.address, expiresAt: expiry }),
      venue.grantMember(programId, { issuer: admin, venue: venueId, member: await venue.memberPda(programId, venueId, trader.address), wallet: trader.address, expiresAt: expiry }),
    ], admin)
    await send("rulebook", [
      venue.setCap(programId, { dataAuthority: admin, venue: venueId, symbol, capShares: 1_000_000_000n, advShares: 10_000_000_000n, multiplierNum: 1, multiplierDen: 1 }),
      venue.heartbeat(programId, { relay: admin, venue: venueId, symbol, seq: 1n }),
      venue.activatePool(programId, { admin, venue: venueId, symbol }),
    ], admin)
    await send("seedLiquidity", [venue.addLiquidity(programId, {
      owner: admin, ...market, lp: await venue.lpPda(programId, pool, admin.address), ownerStock: lpStock, ownerUsdc: lpUsdc,
      credential: await venue.memberPda(programId, venueId, admin.address), stockMax: 100_000_000n, usdcMax: 1_000_000_000n, minLp: 1n,
    })], admin)
    const credential = await venue.memberPda(programId, venueId, trader.address)
    const swapIx = () => venue.swap(programId, {
      trader, ...market, traderStock, traderUsdc, credential,
      direction: venue.BUY, amountIn: 1_000_000n, minOut: 1n,
    })
    await send("fwdiSwap", [swapIx()], trader)

    const now = await chainNow(fork.rpcUrl)
    const noticeAt = now - 3_600
    const rule = (disc: number, timestamp: number) => ({
      programAddress: programId,
      accounts: [
        { address: admin.address, role: AccountRole.READONLY_SIGNER, signer: admin },
        { address: venueId, role: AccountRole.READONLY },
        { address: thirdParty, role: AccountRole.WRITABLE },
      ],
      data: (() => { const bytes = new Uint8Array(9); bytes[0] = disc; new DataView(bytes.buffer).setBigInt64(1, BigInt(timestamp), true); return bytes })(),
    }) as Parameters<typeof chain.send>[0][number]
    await send("issuerNotice", [rule(21, noticeAt)], admin)
    await reject("noticeWindowOpen", 6008, [venue.activatePool(programId, { admin, venue: venueId, symbol: thirdParty })], admin)
    await timeTravelTo(fork.rpcUrl, noticeAt + 30 * DAY + 1)
    await send("thirdPartyActivated", [venue.activatePool(programId, { admin, venue: venueId, symbol: thirdParty })], admin)
    const fwdiSymbol = symbol
    const breach = () => ({ ...rule(20, 0), accounts: rule(20, 0).accounts?.map((account, index) => index === 2 ? { ...account, address: fwdiSymbol } : account) })
    await send("firstBreach", [breach()], admin)
    await send("secondBreach", [breach()], admin)
    await send("heartbeatAfterBreach", [venue.heartbeat(programId, { relay: admin, venue: venueId, symbol, seq: 2n })], admin)
    await reject("paused", 6004, [swapIx()], trader)
    await timeTravelTo(fork.rpcUrl, (await chainNow(fork.rpcUrl)) + 92 * DAY + 5)
    await send("heartbeatAfterPause", [venue.heartbeat(programId, { relay: admin, venue: venueId, symbol, seq: 3n })], admin)
    await send("fwdiSwapAfterPause", [swapIx()], trader)
    mkdirSync(join("scripts", "fork", "out"), { recursive: true })
    writeFileSync(outPath, JSON.stringify({ cluster: "fork", rpcUrl: fork.rpcUrl, programId, venue: venueId, fwdiMint: FWDI,
      transferAgentApproval: "fork-only surfnet_setTokenAccount", signatures, observed, checkedAt: new Date().toISOString() }, null, 2) + "\n")
    process.stdout.write(`fork scenario passed; ${Object.keys(signatures).length} signatures; ${outPath}\n`)
  } finally {
    await fork.stop()
  }
}

main().catch((error) => { process.stderr.write(`fork scenario failed: ${errorText(error)}\n`); process.exitCode = 1 })

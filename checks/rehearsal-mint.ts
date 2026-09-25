/**
 * Accept check for blk_rehearsal_assets:
 *   npx tsx checks/rehearsal-mint.ts --cluster fork
 *
 * Starts (or reuses) a local Surfpool mainnet fork, creates the rehearsal stock mint on it with
 * throwaway keypairs, reads the mint back and asserts FWDI's design: DefaultAccountState Frozen,
 * the venue's freeze authority, ScaledUiAmount (multiplier 1), self-pointing metadata labelled
 * as a rehearsal asset, 6 decimals. Then proves a fresh wallet account and a PDA-owned pool vault
 * are frozen until the freeze authority thaws them. Exits non-zero on any mismatch.
 */
import { generateKeyPairSigner, getProgramDerivedAddress, address, type Address } from "@solana/kit"
import { AccountState } from "@solana-program/token-2022"
import { clusterConfig, parseCluster, MAINNET_USDC_MINT, TOKEN_PROGRAM } from "../config/clusters.js"
import { startOrReuseSurfpool } from "../scripts/assets/surfpool.js"
import { createChain, errorText } from "../scripts/assets/tx.js"
import { REHEARSAL, createRehearsalMint, readRehearsalMint } from "../scripts/assets/rehearsal-mint.js"
import { ensureTokenAccount, thawTokenAccount, readTokenAccount, mintRehearsalStock } from "../scripts/assets/thaw.js"

const failures: string[] = []
const passes: string[] = []
function expect(ok: boolean, what: string, detail?: unknown) {
  if (ok) passes.push(what)
  else failures.push(`${what}${detail === undefined ? "" : ` — got ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`}`)
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${what}\n`)
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function expectFailure(what: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run()
    expect(false, what, "transaction succeeded")
  } catch (error) {
    const text = errorText(error)
    const match = text.match(pattern)
    expect(match !== null, match ? `${what} [${match[0]}]` : what, text.slice(0, 400))
  }
}

async function main() {
  const cluster = parseCluster(argValue("cluster") ?? "fork")
  if (cluster !== "fork") throw new Error("this check creates throwaway mints and funds keypairs with cheatcodes; it only runs with --cluster fork")
  const config = clusterConfig("fork")
  const fork = await startOrReuseSurfpool({ rpcUrl: config.rpcUrl })
  process.stdout.write(`surfpool ${fork.reused ? "reused (already listening locally)" : "started (mainnet datasource, 127.0.0.1 only)"} at ${fork.rpcUrl}\n`)
  try {
    const chain = createChain(fork.rpcUrl)
    const [payer, mintAuthority, venue, holder, mintKeypair] = await Promise.all(
      Array.from({ length: 5 }, () => generateKeyPairSigner()),
    )
    await chain.fundSol(payer.address, 10_000_000_000n)
    await chain.fundSol(venue.address, 1_000_000_000n)
    await chain.fundSol(mintAuthority.address, 1_000_000_000n)

    // 1. The fork's USDC is real mainnet USDC, copied from mainnet on first touch.
    expect(config.usdcMint === MAINNET_USDC_MINT, "fork cluster quotes in mainnet USDC", config.usdcMint)
    const usdc = await chain.rpc.getAccountInfo(MAINNET_USDC_MINT, { encoding: "base64" }).send()
    expect(usdc.value?.owner === TOKEN_PROGRAM, "mainnet USDC mint is readable on the fork (SPL Token)", usdc.value?.owner)

    // 2. Create the rehearsal mint and read every extension back from the fork.
    const created = await createRehearsalMint(chain, {
      payer, mint: mintKeypair, mintAuthority, freezeAuthority: venue.address,
    })
    process.stdout.write(`created ${created.mint} (${created.space} B, ${created.lamports} lamports) in ${created.signature}\n`)
    const state = await readRehearsalMint(chain.rpc, created.mint)
    expect(state.tokenProgram === config.stockTokenProgram, "mint is owned by Token-2022", state.tokenProgram)
    expect(state.decimals === REHEARSAL.decimals, "6 decimals", state.decimals)
    expect(state.defaultAccountState === "frozen", "DefaultAccountState = Frozen", state.defaultAccountState)
    expect(state.freezeAuthority === venue.address, "freeze authority = venue key", state.freezeAuthority)
    expect(state.permanentDelegate === venue.address, "permanent delegate = venue key (FWDI pattern)", state.permanentDelegate)
    expect(state.mintAuthority === mintAuthority.address, "mint authority = issuer key", state.mintAuthority)
    expect(state.scaledUiAmount !== null, "ScaledUiAmount extension present", state.scaledUiAmount)
    expect(state.scaledUiAmount?.multiplier === 1, "ScaledUiAmount multiplier = 1", state.scaledUiAmount?.multiplier)
    expect(state.scaledUiAmount?.authority === mintAuthority.address, "ScaledUiAmount authority = issuer key", state.scaledUiAmount?.authority)
    expect(state.metadataPointer?.metadataAddress === created.mint, "MetadataPointer points at the mint itself", state.metadataPointer)
    expect(state.metadataPointer?.authority === mintAuthority.address, "MetadataPointer authority = issuer key", state.metadataPointer?.authority)
    const md = state.metadata
    expect(md !== null && md.mint === created.mint, "TokenMetadata stored on the mint", md?.mint)
    expect(/rehearsal/i.test(md?.name ?? ""), `metadata name says rehearsal ("${md?.name}")`, md?.name)
    expect(md?.symbol === REHEARSAL.symbol, `metadata symbol = ${REHEARSAL.symbol}`, md?.symbol)
    expect(/rehearsal/i.test(md?.additionalMetadata.notice ?? ""), "metadata notice field says rehearsal", md?.additionalMetadata)
    expect(md?.updateAuthority === mintAuthority.address, "metadata update authority = issuer key", md?.updateAuthority)

    // 3. A fresh wallet account is frozen until the venue thaws it.
    const holderAta = await ensureTokenAccount(chain, { payer, owner: holder.address, mint: created.mint })
    const fresh = await readTokenAccount(chain.rpc, holderAta)
    expect(fresh.state === AccountState.Frozen, "fresh wallet token account is Frozen", fresh.state)
    await expectFailure(
      "minting into the frozen account is rejected (AccountFrozen)",
      () => mintRehearsalStock(chain, { payer, mint: created.mint, to: holderAta, mintAuthority, shares: 1n }),
      /Account is frozen|custom program error: 0x11\b/i,
    )
    await expectFailure(
      "a non-freeze-authority key cannot thaw",
      () => thawTokenAccount(chain, { payer, account: holderAta, mint: created.mint, freezeAuthority: mintAuthority }),
      /owner does not match|custom program error: 0x4\b/i,
    )
    await thawTokenAccount(chain, { payer, account: holderAta, mint: created.mint, freezeAuthority: venue })
    const thawed = await readTokenAccount(chain.rpc, holderAta)
    expect(thawed.state === AccountState.Initialized, "after venue thaw the account is Initialized", thawed.state)
    await mintRehearsalStock(chain, { payer, mint: created.mint, to: holderAta, mintAuthority, shares: 25n })
    const funded = await readTokenAccount(chain.rpc, holderAta)
    expect(funded.amount === 25_000_000n, "thawed account receives 25 shares (25_000_000 raw)", funded.amount)

    // 4. A pool vault owned by a program PDA is also born frozen and thawed by the venue.
    const [poolPda] = await getProgramDerivedAddress({
      programAddress: address("11111111111111111111111111111111"),
      seeds: ["bellwether-rehearsal-pool", created.mint.slice(0, 16)],
    })
    const vault = await ensureTokenAccount(chain, { payer, owner: poolPda as Address, mint: created.mint })
    expect((await readTokenAccount(chain.rpc, vault)).state === AccountState.Frozen, "fresh PDA-owned pool vault is Frozen")
    await thawTokenAccount(chain, { payer, account: vault, mint: created.mint, freezeAuthority: venue })
    expect((await readTokenAccount(chain.rpc, vault)).state === AccountState.Initialized, "pool vault is Initialized after venue thaw")
  } finally {
    await fork.stop()
  }
  process.stdout.write(`\n${passes.length} passed, ${failures.length} failed\n`)
  if (failures.length > 0) {
    process.stdout.write(failures.map((f) => `FAIL ${f}`).join("\n") + "\n")
    process.exit(1)
  }
}

main().catch((error) => {
  process.stderr.write(`rehearsal-mint check crashed: ${errorText(error)}\n`)
  process.exit(1)
})

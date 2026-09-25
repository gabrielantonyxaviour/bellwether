/** Short, reversible devnet halt proof using the venue's shipped relay instructions. */
import { address, AccountRole, createSolanaRpc, type Instruction } from "@solana/kit"
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token"
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda as stockAta } from "@solana-program/token-2022"
import { fetchRaw, chainNow } from "../../services/credential/backend.js"
import { attestationAddress, sasIdentity } from "../../services/credential/sas.js"
import { addLiquidityIx, lpPda, swapIx, BUY, type PoolKeys } from "../../services/credential/venue-ix.js"
import { clearHaltInstruction, decodeSymbolRecord, setHaltInstruction, venueErrorIn } from "../../services/relay/program.js"
import { createDeploymentChain } from "../deploy/chain.js"
import { key, loadDeployment } from "../deploy/state.js"
import { errorText } from "../assets/tx.js"

const emit = (event: string, fields: Record<string, unknown>) => process.stdout.write(JSON.stringify({ event, ...fields }) + "\n")
const u64 = (value: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, value, true); return b }

async function main() {
  if (process.env.BELLWETHER_HALT_WINDOW !== "BWRS") {
    throw new Error("Set BELLWETHER_HALT_WINDOW=BWRS only after coordinating a devnet halt window")
  }
  const d = loadDeployment("devnet")
  if (!d?.programId || !d.venue || !d.symbol || !d.pool || !d.stockMint || !d.usdcMint || !d.stockVault || !d.usdcVault) {
    throw new Error("Incomplete devnet deployment journal")
  }
  const programId = address(d.programId)
  const pool: PoolKeys = { venue: address(d.venue), symbol: address(d.symbol), pool: address(d.pool),
    stockMint: address(d.stockMint), usdcMint: address(d.usdcMint), stockVault: address(d.stockVault),
    usdcVault: address(d.usdcVault) }
  const chain = createDeploymentChain(d.rpcUrl)
  const rpc = createSolanaRpc(d.rpcUrl)
  const provider = await key("devnet", "integration-liquidity")
  const relay = await key("devnet", "relay")
  const issuer = await key("devnet", "credential-issuer")
  const credential = await attestationAddress(await sasIdentity(issuer.address), provider.address)
  const [stock] = await stockAta({ owner: provider.address, mint: pool.stockMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const [usdc] = await findAssociatedTokenPda({ owner: provider.address, mint: pool.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const position = await lpPda(programId, pool.pool, provider.address)
  const currentSymbol = async () => {
    const raw = await fetchRaw(rpc, pool.symbol)
    if (!raw) throw new Error("Symbol account missing")
    return decodeSymbolRecord(raw.data)
  }
  const initial = await currentSymbol()
  if (initial.halted) throw new Error("BWRS already halted; this runner must not clear someone else's halt")
  const deposit = await chain.send([await addLiquidityIx(programId, pool, provider, stock, usdc, credential,
    1_000n, 10_000n, 1n)], provider)
  emit("pre_halt_deposit", { signature: deposit, wallet: provider.address })
  let ownsHalt = false
  try {
    const beforeHalt = await currentSymbol()
    const base = { programId, relay, venue: pool.venue, symbol: pool.symbol, seq: beforeHalt.seq + 1n }
    const halt = await chain.send([setHaltInstruction({ ...base, reason: "LUDP", feedTs: await chainNow(rpc) })], relay)
    ownsHalt = true
    const halted = await currentSymbol()
    if (!halted.halted || halted.haltReason !== "LUDP") throw new Error("Halt did not land on symbol")
    emit("halt", { signature: halt, sequence: halted.seq.toString(), reason: halted.haltReason })

    const refused = async (label: string, ix: Instruction) => {
      try { const signature = await chain.send([ix], provider); throw new Error(`${label} unexpectedly confirmed ${signature}`) }
      catch (cause) {
        const detail = errorText(cause)
        if (detail.includes("unexpectedly confirmed")) throw cause
        const venueError = venueErrorIn(detail)
        if (venueError !== "TradingHalted") throw new Error(`${label} expected TradingHalted, got ${venueError}: ${detail}`)
        emit("refused", { label, venueError, detail: detail.slice(0, 400) })
      }
    }
    await refused("add_liquidity", await addLiquidityIx(programId, pool, provider, stock, usdc, credential,
      100n, 1_000n, 1n))
    await refused("swap", swapIx(programId, pool, provider, stock, usdc, credential, BUY, 1_000n, 1n))

    const rawLp = await fetchRaw(rpc, position)
    if (!rawLp) throw new Error("LP position missing")
    const shares = new DataView(rawLp.data.buffer, rawLp.data.byteOffset).getBigUint64(72, true)
    const accounts = [
      { address: provider.address, role: AccountRole.WRITABLE_SIGNER, signer: provider },
      { address: pool.venue, role: AccountRole.READONLY }, { address: pool.symbol, role: AccountRole.READONLY },
      { address: pool.pool, role: AccountRole.WRITABLE }, { address: position, role: AccountRole.WRITABLE },
      { address: pool.stockMint, role: AccountRole.READONLY }, { address: pool.usdcMint, role: AccountRole.READONLY },
      { address: pool.stockVault, role: AccountRole.WRITABLE }, { address: pool.usdcVault, role: AccountRole.WRITABLE },
      { address: stock, role: AccountRole.WRITABLE }, { address: usdc, role: AccountRole.WRITABLE },
      { address: credential, role: AccountRole.READONLY }, { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ] as const
    const withdraw: Instruction = { programAddress: programId, accounts,
      data: Uint8Array.from([4, ...u64(shares), ...u64(1n), ...u64(1n)]) }
    const withdrawal = await chain.send([withdraw], provider)
    const remainingRaw = await fetchRaw(rpc, position)
    const remaining = remainingRaw ? new DataView(remainingRaw.data.buffer, remainingRaw.data.byteOffset).getBigUint64(72, true) : 0n
    if (remaining !== 0n) throw new Error(`Withdrawal left ${remaining} LP shares`)
    emit("withdraw_while_halted", { signature: withdrawal, shares: shares.toString(), sharesRemaining: "0" })
  } finally {
    if (ownsHalt) {
      const beforeClear = await currentSymbol()
      if (beforeClear.halted) {
        const clear = await chain.send([clearHaltInstruction({ programId, relay, venue: pool.venue,
          symbol: pool.symbol, seq: beforeClear.seq + 1n })], relay)
        emit("resume", { signature: clear, sequence: (beforeClear.seq + 1n).toString() })
      }
      const final = await currentSymbol()
      if (final.halted) throw new Error("BWRS remains halted after cleanup")
      emit("final_state", { halted: final.halted, reason: final.haltReason })
    }
  }
}

main().catch((error) => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1 })

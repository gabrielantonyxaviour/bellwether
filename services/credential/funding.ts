/** Devnet-only first-admission funding, with onchain shortfall checks and a durable wallet ledger. */
import type { Address, TransactionSigner } from "@solana/kit"
import { getTransferSolInstruction } from "@solana-program/system"
import {
  TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
  getMintToCheckedInstruction,
} from "@solana-program/token"
import type { Chain } from "../../scripts/assets/tx.js"
import { AdmissionError } from "./admission.js"
import type { ScreeningLog } from "./screening-log.js"

export interface FundingResult {
  status: "funded" | "already_funded"
  signature: string | null
  solLamports: string
  testUsdcRaw: string
}

export interface Funder { fund(wallet: Address): Promise<FundingResult> }

export function createDevnetFunder(input: {
  chain: Chain; payer: TransactionSigner; usdcMint: Address; log: ScreeningLog
  solTarget: bigint; usdcTarget: bigint; dailyCap: number
}): Funder {
  return {
    async fund(wallet) {
      const prior = input.log.recent(Number.MAX_SAFE_INTEGER, wallet).find((entry) => entry.event === "funded")
      if (prior) return { status: "already_funded", signature: null, solLamports: "0", testUsdcRaw: "0" }
      const today = new Date().toISOString().slice(0, 10)
      const fundedToday = input.log.recent(Number.MAX_SAFE_INTEGER).filter((entry) => entry.event === "funded" && entry.at.startsWith(today)).length
      if (fundedToday >= input.dailyCap) throw new AdmissionError("DAILY_CAP", 429, "The daily devnet test-funding limit has been reached.")
      const [ata] = await findAssociatedTokenPda({ owner: wallet, mint: input.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
      let solBalance: bigint
      let usdcBalance = 0n
      try {
        const [sol, account] = await Promise.all([
          input.chain.rpc.getBalance(wallet).send(),
          input.chain.rpc.getAccountInfo(ata, { encoding: "base64" }).send(),
        ])
        solBalance = sol.value
        if (account.value) {
          const token = await input.chain.rpc.getTokenAccountBalance(ata).send()
          usdcBalance = BigInt(token.value.amount)
        }
      } catch {
        throw new AdmissionError("FUNDING_UNAVAILABLE", 502, "Could not read devnet balances for test funding. Admission can be retried.")
      }

      const solShortfall = input.solTarget > solBalance ? input.solTarget - solBalance : 0n
      const usdcShortfall = input.usdcTarget > usdcBalance ? input.usdcTarget - usdcBalance : 0n
      const instructions = []
      if (solShortfall > 0n) instructions.push(getTransferSolInstruction({ source: input.payer, destination: wallet, amount: solShortfall }))
      if (usdcShortfall > 0n) {
        instructions.push(getCreateAssociatedTokenIdempotentInstruction({
          payer: input.payer, ata, owner: wallet, mint: input.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS,
        }))
        instructions.push(getMintToCheckedInstruction({
          mint: input.usdcMint, token: ata, mintAuthority: input.payer, amount: usdcShortfall, decimals: 6,
        }))
      }
      let signature: string | null = null
      if (instructions.length > 0) {
        try { signature = await input.chain.send(instructions, input.payer) }
        catch {
          throw new AdmissionError("FUNDING_UNAVAILABLE", 502, "Devnet test funding failed. Admission can be retried.")
        }
      }
      input.log.append({ wallet, event: "funded", signature, solLamports: solShortfall.toString(), testUsdcRaw: usdcShortfall.toString() })
      return { status: "funded", signature, solLamports: solShortfall.toString(), testUsdcRaw: usdcShortfall.toString() }
    },
  }
}

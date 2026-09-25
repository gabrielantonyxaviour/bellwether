/**
 * Admin instructions for the operator workbench (docs/program-contract.md):
 * 1 register_symbol, 21 record_issuer_notice, 22 record_objection, 23 activate_pool.
 */
import { AccountRole, type Address, type Instruction, type TransactionSigner } from "@solana/kit"
import { SYSTEM_PROGRAM } from "@/lib/cluster"

const signerMeta = (signer: TransactionSigner, writable: boolean) =>
  ({ address: signer.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer })
const writable = (address: Address) => ({ address, role: AccountRole.WRITABLE })
const readonly = (address: Address) => ({ address, role: AccountRole.READONLY })

function bytes(size: number, fill: (view: DataView, out: Uint8Array) => void): Uint8Array {
  const out = new Uint8Array(size)
  fill(new DataView(out.buffer), out)
  return out
}

export function registerSymbolInstruction(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address, mint: Address,
  args: { tier: 1 | 2; issuerSponsored: boolean; ticker: string }): Instruction {
  const ticker = new TextEncoder().encode(args.ticker)
  if (ticker.length === 0 || ticker.length > 8) throw new Error(`Ticker must be 1–8 bytes: ${args.ticker}`)
  const data = bytes(11, (view, out) => {
    view.setUint8(0, 1)
    view.setUint8(1, args.tier)
    view.setUint8(2, args.issuerSponsored ? 1 : 0)
    out.set(ticker, 3)
  })
  return {
    programAddress: programId,
    accounts: [signerMeta(admin, true), writable(venue), writable(symbol), readonly(mint), readonly(SYSTEM_PROGRAM)],
    data,
  }
}

function rulebook(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address, data: Uint8Array): Instruction {
  return { programAddress: programId, accounts: [signerMeta(admin, false), readonly(venue), writable(symbol)], data }
}

/** 21: unix time the issuer received the notice. Recorded once, and never in the future. */
export function recordIssuerNoticeInstruction(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address, receivedAt: number): Instruction {
  return rulebook(programId, admin, venue, symbol, bytes(9, (view) => {
    view.setUint8(0, 21)
    view.setBigInt64(1, BigInt(receivedAt), true)
  }))
}

/** 22: a notice of issuer objection. The symbol cannot stay available. */
export function recordObjectionInstruction(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address): Instruction {
  return rulebook(programId, admin, venue, symbol, Uint8Array.of(22))
}

/** 23: make the symbol available. Third-party tokens wait out the 30-day notice window. */
export function activatePoolInstruction(programId: Address, admin: TransactionSigner, venue: Address, symbol: Address): Instruction {
  return rulebook(programId, admin, venue, symbol, Uint8Array.of(23))
}


/**
 * Deploy a prebuilt .so through the BPF upgradeable loader, the way `solana program deploy` does:
 * create and initialize a buffer, write the ELF in chunks, then DeployWithMaxDataLen. The loader
 * itself creates the ProgramData account and records the upgrade authority, so a resolver reading
 * it afterwards reads real loader state, not a hand-written account.
 */
import { AccountRole, address, type Address, type Instruction, type TransactionSigner } from "@solana/kit"
import { getCreateAccountInstruction } from "@solana-program/system"
import type { Chain } from "../../../scripts/assets/tx.js"
import { UPGRADEABLE_LOADER, programDataPda } from "../layout.js"

const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111")
const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111")
const SYSTEM_PROGRAM = address("11111111111111111111111111111111")
const BUFFER_HEADER = 37 // tag u32 + Option<Pubkey>
const PROGRAM_ACCOUNT_LEN = 36 // tag u32 + ProgramData address
/** Fits a v0 transaction with one signer and three account keys under the 1232-byte limit. */
const CHUNK = 950

const signerMeta = (signer: TransactionSigner, writable: boolean) =>
  ({ address: signer.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer })

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, true)
  return out
}

function initializeBuffer(buffer: Address, authority: Address): Instruction {
  return { programAddress: UPGRADEABLE_LOADER, accounts: [{ address: buffer, role: AccountRole.WRITABLE }, { address: authority, role: AccountRole.READONLY }], data: u32(0) }
}

function write(buffer: Address, authority: TransactionSigner, offset: number, chunk: Uint8Array): Instruction {
  const data = new Uint8Array(16 + chunk.length)
  const view = new DataView(data.buffer)
  view.setUint32(0, 1, true)
  view.setUint32(4, offset, true)
  view.setBigUint64(8, BigInt(chunk.length), true)
  data.set(chunk, 16)
  return {
    programAddress: UPGRADEABLE_LOADER,
    accounts: [{ address: buffer, role: AccountRole.WRITABLE }, signerMeta(authority, false)],
    data,
  }
}

function deployWithMaxDataLen(a: { payer: TransactionSigner; programData: Address; program: Address; buffer: Address; authority: TransactionSigner; maxDataLen: number }): Instruction {
  const data = new Uint8Array(12)
  const view = new DataView(data.buffer)
  view.setUint32(0, 2, true)
  view.setBigUint64(4, BigInt(a.maxDataLen), true)
  return {
    programAddress: UPGRADEABLE_LOADER,
    accounts: [
      signerMeta(a.payer, true),
      { address: a.programData, role: AccountRole.WRITABLE },
      { address: a.program, role: AccountRole.WRITABLE },
      { address: a.buffer, role: AccountRole.WRITABLE },
      { address: RENT_SYSVAR, role: AccountRole.READONLY },
      { address: CLOCK_SYSVAR, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      signerMeta(a.authority, false),
    ],
    data,
  }
}

export interface DeployResult { programId: Address; programData: Address; buffer: Address; writes: number; signature: string }

export async function deployUpgradeable(chain: Chain, input: {
  payer: TransactionSigner; program: TransactionSigner; buffer: TransactionSigner; upgradeAuthority: TransactionSigner; elf: Uint8Array; parallel?: number
}): Promise<DeployResult> {
  const { payer, program, buffer, upgradeAuthority, elf } = input
  const rent = async (size: number) => (await chain.rpc.getMinimumBalanceForRentExemption(BigInt(size)).send())

  await chain.send([
    getCreateAccountInstruction({ payer, newAccount: buffer, lamports: await rent(BUFFER_HEADER + elf.length), space: BUFFER_HEADER + elf.length, programAddress: UPGRADEABLE_LOADER }),
    initializeBuffer(buffer.address, upgradeAuthority.address),
  ], payer)

  const offsets: number[] = []
  for (let offset = 0; offset < elf.length; offset += CHUNK) offsets.push(offset)
  const parallel = input.parallel ?? 8
  for (let i = 0; i < offsets.length; i += parallel) {
    await Promise.all(offsets.slice(i, i + parallel).map((offset) =>
      chain.send([write(buffer.address, upgradeAuthority, offset, elf.subarray(offset, offset + CHUNK))], upgradeAuthority)))
  }

  const programData = await programDataPda(program.address)
  const signature = await chain.send([
    getCreateAccountInstruction({ payer, newAccount: program, lamports: await rent(PROGRAM_ACCOUNT_LEN), space: PROGRAM_ACCOUNT_LEN, programAddress: UPGRADEABLE_LOADER }),
    deployWithMaxDataLen({ payer, programData, program: program.address, buffer: buffer.address, authority: upgradeAuthority, maxDataLen: elf.length }),
  ], payer)
  return { programId: program.address, programData, buffer: buffer.address, writes: offsets.length, signature }
}

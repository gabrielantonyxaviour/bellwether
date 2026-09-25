/**
 * Minimal client for the venue program, as the caps job needs it (layouts: docs/program-contract.md,
 * source of truth programs/venue/src/state.rs): PDAs, set_cap, the two setup instructions the
 * check uses, VenueConfig/SymbolRecord decoding, symbol discovery and the stock mint's units.
 */
import {
  AccountRole, getAddressDecoder, getAddressEncoder, getBase58Decoder, getBase64Encoder, getProgramDerivedAddress,
  type Address, type Base58EncodedBytes, type Instruction, type TransactionSigner,
} from "@solana/kit"
import { fetchMint } from "@solana-program/token-2022"
import type { CapsRpc } from "./chain.js"

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address
const enc = getAddressEncoder()
const dec = getAddressDecoder()
const text = new TextEncoder()

export const SYMBOL_DISC = 2
export const SYMBOL_LEN = 168
export const VENUE_DISC = 1
export const VENUE_LEN = 248

export async function venuePda(programId: Address, admin: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: programId, seeds: [text.encode("venue"), enc.encode(admin)] }))[0]
}
export async function symbolPda(programId: Address, venue: Address, mint: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: programId, seeds: [text.encode("symbol"), enc.encode(venue), enc.encode(mint)] }))[0]
}

const signerMeta = (s: TransactionSigner, writable: boolean) => ({ address: s.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer: s })
const ro = (a: Address) => ({ address: a, role: AccountRole.READONLY })
const rw = (a: Address) => ({ address: a, role: AccountRole.WRITABLE })

function bytes(size: number, fill: (v: DataView, b: Uint8Array) => void): Uint8Array {
  const b = new Uint8Array(size)
  fill(new DataView(b.buffer), b)
  return b
}

/** 16 set_cap (data authority): cap u64 | adv u64 | multiplier num u32 | den u32. Accounts [authority (s), venue, symbol (w)]. */
export function setCapIx(a: { programId: Address; authority: TransactionSigner; venue: Address; symbol: Address; capUnits: bigint; advUnits: bigint; num: number; den: number }): Instruction {
  const data = bytes(25, (v) => {
    v.setUint8(0, 16)
    v.setBigUint64(1, a.capUnits, true)
    v.setBigUint64(9, a.advUnits, true)
    v.setUint32(17, a.num, true)
    v.setUint32(21, a.den, true)
  })
  return { programAddress: a.programId, accounts: [signerMeta(a.authority, false), ro(a.venue), rw(a.symbol)], data }
}

/** 0 init_venue: gate u8 | heartbeat_max_age i64 | cutoff i64 | relay | data authority | issuer | SAS credential | SAS schema | affiliate group. */
export function initVenueIx(a: {
  programId: Address; admin: TransactionSigner; venue: Address; gate: number; heartbeatMaxAge: bigint; cutoffSeconds: bigint
  relay: Address; dataAuthority: Address; credentialIssuer: Address; sasCredential: Address; sasSchema: Address; affiliateGroup: Address
}): Instruction {
  const keys = [a.relay, a.dataAuthority, a.credentialIssuer, a.sasCredential, a.sasSchema, a.affiliateGroup]
  const data = bytes(18 + 32 * keys.length, (v, b) => {
    v.setUint8(0, 0)
    v.setUint8(1, a.gate)
    v.setBigInt64(2, a.heartbeatMaxAge, true)
    v.setBigInt64(10, a.cutoffSeconds, true)
    keys.forEach((k, i) => b.set(enc.encode(k), 18 + 32 * i))
  })
  return { programAddress: a.programId, accounts: [signerMeta(a.admin, true), rw(a.venue), ro(SYSTEM_PROGRAM)], data }
}

export function tickerBytes(ticker: string): Uint8Array {
  const t = text.encode(ticker)
  if (t.length === 0 || t.length > 8) throw new Error(`ticker ${JSON.stringify(ticker)} must be 1–8 bytes`)
  const out = new Uint8Array(8)
  out.set(t)
  return out
}

/** 1 register_symbol: tier u8 | sponsored u8 | ticker[8]. Accounts [admin (s,w), venue (w), symbol (w), stock mint, system]. */
export async function registerSymbolIx(a: { programId: Address; admin: TransactionSigner; venue: Address; mint: Address; tier: 1 | 2; sponsored: boolean; ticker: string }): Promise<Instruction> {
  const data = bytes(11, (v, b) => {
    v.setUint8(0, 1)
    v.setUint8(1, a.tier)
    v.setUint8(2, a.sponsored ? 1 : 0)
    b.set(tickerBytes(a.ticker), 3)
  })
  const symbol = await symbolPda(a.programId, a.venue, a.mint)
  return { programAddress: a.programId, accounts: [signerMeta(a.admin, true), rw(a.venue), rw(symbol), ro(a.mint), ro(SYSTEM_PROGRAM)], data }
}

export interface VenueConfig { admin: Address; relay: Address; dataAuthority: Address; cutoffSeconds: number }
export interface SymbolRecord {
  address: Address; tier: number; ticker: string; venue: Address; mint: Address
  advUnits: bigint; capUnits: bigint; multNum: number; multDen: number; active: boolean; halted: boolean
}

export function decodeVenue(d: Uint8Array): VenueConfig {
  if (d.length < VENUE_LEN || d[0] !== VENUE_DISC) throw new Error("not a VenueConfig account")
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  return { cutoffSeconds: Number(v.getBigInt64(16, true)), admin: dec.decode(d.subarray(24, 56)), relay: dec.decode(d.subarray(56, 88)), dataAuthority: dec.decode(d.subarray(88, 120)) }
}

export function decodeSymbol(address: Address, d: Uint8Array): SymbolRecord {
  if (d.length < SYMBOL_LEN || d[0] !== SYMBOL_DISC) throw new Error(`${address} is not a SymbolRecord`)
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  return {
    address, tier: d[2], active: d[4] === 1, halted: d[5] === 1,
    ticker: new TextDecoder().decode(d.subarray(8, 16)).replace(/\0+$/, ""),
    venue: dec.decode(d.subarray(24, 56)), mint: dec.decode(d.subarray(56, 88)),
    advUnits: v.getBigUint64(88, true), capUnits: v.getBigUint64(96, true), multNum: v.getUint32(104, true), multDen: v.getUint32(108, true),
  }
}

const b64 = getBase64Encoder()

async function accountBytes(rpc: CapsRpc, a: Address, owner?: Address): Promise<Uint8Array> {
  const { value } = await rpc.getAccountInfo(a, { encoding: "base64", commitment: "confirmed" }).send()
  if (!value) throw new Error(`account ${a} not found`)
  if (owner && value.owner !== owner) throw new Error(`account ${a} is owned by ${value.owner}, not ${owner}`)
  return Uint8Array.from(b64.encode(value.data[0]))
}

export async function readVenue(rpc: CapsRpc, programId: Address, venue: Address): Promise<VenueConfig> {
  return decodeVenue(await accountBytes(rpc, venue, programId))
}
export async function readSymbolRecord(rpc: CapsRpc, symbol: Address, programId?: Address): Promise<SymbolRecord> {
  return decodeSymbol(symbol, await accountBytes(rpc, symbol, programId))
}

/** Every SymbolRecord of this venue: program accounts of the symbol size, discriminator 2, venue at byte 24. */
export async function listSymbols(rpc: CapsRpc, programId: Address, venue: Address): Promise<SymbolRecord[]> {
  const found = await rpc.getProgramAccounts(programId, {
    encoding: "base64", commitment: "confirmed",
    filters: [
      { dataSize: BigInt(SYMBOL_LEN) },
      { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(Uint8Array.of(SYMBOL_DISC)) as Base58EncodedBytes, encoding: "base58" } },
      { memcmp: { offset: 24n, bytes: venue as string as Base58EncodedBytes, encoding: "base58" } },
    ],
  }).send()
  return found.map((f) => decodeSymbol(f.pubkey, Uint8Array.from(b64.encode(f.account.data[0])))).sort((a, b) => a.ticker.localeCompare(b.ticker))
}

/** The stock mint's decimals and effective ScaledUiAmount multiplier (1 when the extension is absent). */
export async function readMintUnits(rpc: CapsRpc, mint: Address, now: Date): Promise<{ decimals: number; multiplier: number; scaledUi: boolean; tokenProgram: Address }> {
  const account = await fetchMint(rpc, mint)
  const exts = account.data.extensions.__option === "Some" ? account.data.extensions.value : []
  const su = exts.find((e) => e.__kind === "ScaledUiAmountConfig")
  let multiplier = 1
  if (su && su.__kind === "ScaledUiAmountConfig") {
    // Token-2022's rule: new_multiplier applies from its effective timestamp on.
    multiplier = now.getTime() / 1000 >= Number(su.newMultiplierEffectiveTimestamp) ? su.newMultiplier : su.multiplier
  }
  return { decimals: account.data.decimals, multiplier, scaledUi: !!su, tokenProgram: account.programAddress }
}

/**
 * Byte layouts the notice resolvers read: the venue program's accounts (docs/program-contract.md,
 * programs/venue/src/state.rs) and the BPF upgradeable loader's Program / ProgramData accounts.
 */
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit"

export const UPGRADEABLE_LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111")
export const VENUE_LEN = 248
export const SYMBOL_LEN = 168
export const POOL_LEN = 192

const addrDecoder = getAddressDecoder()
const addrEncoder = getAddressEncoder()

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
const key = (d: Uint8Array, o: number): string => addrDecoder.decode(d.subarray(o, o + 32))
const i64 = (d: Uint8Array, o: number): number => Number(view(d).getBigInt64(o, true))
const u64 = (d: Uint8Array, o: number): string => view(d).getBigUint64(o, true).toString()
const u16 = (d: Uint8Array, o: number): number => view(d).getUint16(o, true)
const u32 = (d: Uint8Array, o: number): number => view(d).getUint32(o, true)
const ascii = (d: Uint8Array, o: number, n: number): string =>
  new TextDecoder().decode(d.subarray(o, o + n)).replace(/\0+$/, "")

function expect(d: Uint8Array, discriminator: number, len: number, what: string): void {
  if (d.length < len) throw new Error(`${what}: ${d.length} bytes, expected ${len}`)
  if (d[0] !== discriminator) throw new Error(`${what}: discriminator ${d[0]}, expected ${discriminator}`)
}

export interface VenueAccount {
  admin: string; relay: string; dataAuthority: string; credentialIssuer: string
  sasCredential: string; sasSchema: string; affiliateGroup: string
  gate: { sas: boolean; membership: boolean }
  tier1Count: number; tier2Count: number
  heartbeatMaxAgeS: number; tradeDateCutoffS: number; tradeDateCutoffUtc: string
}

export function decodeVenue(d: Uint8Array): VenueAccount {
  expect(d, 1, VENUE_LEN, "VenueConfig")
  const cutoff = i64(d, 16)
  const hh = String(Math.floor(cutoff / 3600)).padStart(2, "0")
  const mm = String(Math.floor((cutoff % 3600) / 60)).padStart(2, "0")
  return {
    gate: { sas: (d[2] & 1) !== 0, membership: (d[2] & 2) !== 0 },
    tier1Count: u16(d, 4), tier2Count: u16(d, 6),
    heartbeatMaxAgeS: i64(d, 8), tradeDateCutoffS: cutoff, tradeDateCutoffUtc: `${hh}:${mm} UTC`,
    admin: key(d, 24), relay: key(d, 56), dataAuthority: key(d, 88), credentialIssuer: key(d, 120),
    sasCredential: key(d, 152), sasSchema: key(d, 184), affiliateGroup: key(d, 216),
  }
}

export interface SymbolAccount {
  ticker: string; mint: string; venue: string; tier: number; issuerSponsored: boolean; active: boolean
  halted: boolean; haltReason: string; objected: boolean; breachCount: number
  advShares: string; capShares: string; multiplier: { num: number; den: number }
  pausedUntil: number; lastHeartbeat: number; noticeReceivedAt: number
}

export function decodeSymbol(d: Uint8Array): SymbolAccount {
  expect(d, 2, SYMBOL_LEN, "SymbolRecord")
  return {
    tier: d[2], issuerSponsored: d[3] !== 0, active: d[4] !== 0, halted: d[5] !== 0, objected: d[6] !== 0, breachCount: d[7],
    ticker: ascii(d, 8, 8), haltReason: ascii(d, 16, 8), venue: key(d, 24), mint: key(d, 56),
    advShares: u64(d, 88), capShares: u64(d, 96), multiplier: { num: u32(d, 104), den: u32(d, 108) },
    pausedUntil: i64(d, 128), lastHeartbeat: i64(d, 136), noticeReceivedAt: i64(d, 152),
  }
}

export interface PoolAccount {
  feeBps: number; stockDecimals: number; usdcDecimals: number; symbol: string
  stockMint: string; usdcMint: string; stockVault: string; usdcVault: string
  reserveStock: string; reserveUsdc: string; lpTotal: string
}

export function decodePool(d: Uint8Array): PoolAccount {
  expect(d, 3, POOL_LEN, "Pool")
  return {
    stockDecimals: d[2], usdcDecimals: d[3], feeBps: u16(d, 4), symbol: key(d, 8),
    stockMint: key(d, 40), usdcMint: key(d, 72), stockVault: key(d, 104), usdcVault: key(d, 136),
    reserveStock: u64(d, 168), reserveUsdc: u64(d, 176), lpTotal: u64(d, 184),
  }
}

/** UpgradeableLoaderState::Program — tag 2, then the ProgramData address. */
export function decodeProgramAccount(d: Uint8Array): { programData: string } {
  if (d.length < 36 || u32(d, 0) !== 2) throw new Error("not an upgradeable-loader Program account")
  return { programData: key(d, 4) }
}

/** UpgradeableLoaderState::ProgramData — tag 3, slot u64, Option<Pubkey> authority, then the ELF. */
export function decodeProgramData(d: Uint8Array): { deploySlot: number; upgradeAuthority: string | null; programLength: number } {
  if (d.length < 45 || u32(d, 0) !== 3) throw new Error("not an upgradeable-loader ProgramData account")
  return {
    deploySlot: Number(view(d).getBigUint64(4, true)),
    upgradeAuthority: d[12] === 1 ? key(d, 13) : null,
    programLength: d.length - 45,
  }
}

const seed = (value: string) => addrEncoder.encode(address(value))

export async function venuePda(programId: string, admin: string): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: address(programId), seeds: ["venue", seed(admin)] }))[0]
}
export async function symbolPda(programId: string, venue: string, mint: string): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: address(programId), seeds: ["symbol", seed(venue), seed(mint)] }))[0]
}
export async function poolPda(programId: string, symbol: string): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: address(programId), seeds: ["pool", seed(symbol)] }))[0]
}
export async function programDataPda(programId: string): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: UPGRADEABLE_LOADER, seeds: [seed(programId)] }))[0]
}

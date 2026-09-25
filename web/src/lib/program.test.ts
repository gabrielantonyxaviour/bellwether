/**
 * Decoders and encoders checked against byte layouts written straight from
 * docs/program-contract.md (offsets below are the contract's, not the decoder's).
 */
import { AccountRole, generateKeyPairSigner, getAddressEncoder, SolanaError, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, type Address } from "@solana/kit"
import { describe, expect, it } from "vitest"
import {
  AccountDecodeError,
  addLiquidityInstruction,
  customErrorCode,
  decodeLpPosition,
  decodeMember,
  decodePool,
  decodeSymbolRecord,
  decodeVenueConfig,
  describeError,
  lpPda,
  quoteSwap,
  removeLiquidityInstruction,
  swapInstruction,
  SWAP_SELL,
  toVenueError,
  VENUE_ERRORS,
  withSlippage,
  type MarketAccounts,
} from "@/lib/program"
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "@/lib/cluster"

const enc = getAddressEncoder()
// Distinct, valid base58 addresses.
const KEYS: Address[] = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG",
  "SysvarC1ock11111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
] as Address[]

class Layout {
  readonly bytes: Uint8Array
  private readonly v: DataView
  constructor(len: number, disc: number, bump = 254) {
    this.bytes = new Uint8Array(len)
    this.v = new DataView(this.bytes.buffer)
    this.bytes[0] = disc
    this.bytes[1] = bump
  }
  u8(o: number, x: number) { this.bytes[o] = x; return this }
  u16(o: number, x: number) { this.v.setUint16(o, x, true); return this }
  u32(o: number, x: number) { this.v.setUint32(o, x, true); return this }
  u64(o: number, x: bigint) { this.v.setBigUint64(o, x, true); return this }
  i64(o: number, x: bigint) { this.v.setBigInt64(o, x, true); return this }
  key(o: number, a: Address) { this.bytes.set(enc.encode(a), o); return this }
  text(o: number, s: string) { this.bytes.set(new TextEncoder().encode(s), o); return this }
}

describe("account decoders", () => {
  it("VenueConfig (248 B)", () => {
    const b = new Layout(248, 1).u8(2, 3).u16(4, 2).u16(6, 5).i64(8, 180n).i64(16, 8n * 3600n)
    ;[24, 56, 88, 120, 152, 184, 216].forEach((o, i) => b.key(o, KEYS[i]))
    expect(decodeVenueConfig(b.bytes)).toEqual({
      bump: 254, gate: 3, tier1Count: 2, tier2Count: 5, heartbeatMaxAge: 180n, tradeDateCutoff: 28_800n,
      admin: KEYS[0], relay: KEYS[1], dataAuthority: KEYS[2], credentialIssuer: KEYS[3],
      sasCredential: KEYS[4], sasSchema: KEYS[5], affiliateGroup: KEYS[6],
    })
  })

  it("SymbolRecord (168 B)", () => {
    const b = new Layout(168, 2)
      .u8(2, 2).u8(3, 1).u8(4, 1).u8(5, 1).u8(6, 0).u8(7, 1).text(8, "FWDI").text(16, "LUDP")
      .key(24, KEYS[0]).key(56, KEYS[1]).u64(88, 1_234_000_000n).u64(96, 12_340_000n).u32(104, 1).u32(108, 1)
      .i64(112, 20_356n).u64(120, 5_000_000n).i64(128, 0n).i64(136, 1_790_000_000n).u64(144, 42n)
      .i64(152, 1_788_000_000n).i64(160, 1_790_000_100n)
    expect(decodeSymbolRecord(b.bytes)).toEqual({
      bump: 254, tier: 2, issuerSponsored: true, active: true, halted: true, objected: false, breachCount: 1,
      ticker: "FWDI", haltReason: "LUDP", venue: KEYS[0], mint: KEYS[1], advShares: 1_234_000_000n, capShares: 12_340_000n,
      multiplierNum: 1, multiplierDen: 1, tradeDate: 20_356n, sharesTradedToday: 5_000_000n, pausedUntil: 0n,
      lastHeartbeat: 1_790_000_000n, relaySeq: 42n, noticeReceivedAt: 1_788_000_000n, haltedAt: 1_790_000_100n,
    })
  })

  it("Pool (192 B)", () => {
    const b = new Layout(192, 3).u8(2, 6).u8(3, 6).u16(4, 30)
    ;[8, 40, 72, 104, 136].forEach((o, i) => b.key(o, KEYS[i]))
    b.u64(168, 10_000_000n).u64(176, 5_000_000n).u64(184, 7_070_067n)
    expect(decodePool(b.bytes)).toEqual({
      bump: 254, stockDecimals: 6, usdcDecimals: 6, feeBps: 30, symbol: KEYS[0], stockMint: KEYS[1], usdcMint: KEYS[2],
      stockVault: KEYS[3], usdcVault: KEYS[4], reserveStock: 10_000_000n, reserveUsdc: 5_000_000n, lpTotal: 7_070_067n,
    })
  })

  it("LpPosition and Member (80 B)", () => {
    const lp = new Layout(80, 4).key(8, KEYS[7]).key(40, KEYS[8]).u64(72, 999n)
    expect(decodeLpPosition(lp.bytes)).toEqual({ bump: 254, pool: KEYS[7], owner: KEYS[8], shares: 999n })
    const m = new Layout(80, 5).key(8, KEYS[0]).key(40, KEYS[9]).i64(72, 1_800_000_000n)
    expect(decodeMember(m.bytes)).toEqual({ bump: 254, venue: KEYS[0], wallet: KEYS[9], expiresAt: 1_800_000_000n })
  })

  it("refuses the wrong discriminator or a short account", () => {
    expect(() => decodePool(new Layout(192, 2).bytes)).toThrow(AccountDecodeError)
    expect(() => decodeSymbolRecord(new Uint8Array(100).fill(2))).toThrow(AccountDecodeError)
  })

  it("decodes from an offset view (RPC buffers are often slices)", () => {
    const b = new Layout(80, 4).key(8, KEYS[1]).key(40, KEYS[2]).u64(72, 7n)
    const padded = new Uint8Array(96)
    padded.set(b.bytes, 16)
    expect(decodeLpPosition(padded.subarray(16)).shares).toBe(7n)
  })
})

describe("instruction encoders", () => {
  const market: MarketAccounts = {
    programId: KEYS[9], venue: KEYS[0], symbol: KEYS[1], pool: KEYS[2], stockMint: KEYS[3], usdcMint: KEYS[4],
    stockVault: KEYS[5], usdcVault: KEYS[6], credential: KEYS[7],
  }

  it("swap: [5, dir, amount_in u64, min_out u64] and 13 accounts in program order", async () => {
    const owner = await generateKeyPairSigner()
    const ix = swapInstruction(market, { owner, ownerStock: KEYS[8], ownerUsdc: SYSTEM_PROGRAM }, { direction: SWAP_SELL, amountIn: 1_500_000n, minOut: 700_000n })
    expect(Array.from(ix.data!)).toEqual([5, 1, 0x60, 0xe3, 0x16, 0, 0, 0, 0, 0, 0x60, 0xae, 0x0a, 0, 0, 0, 0, 0])
    expect(ix.accounts!.map((a) => a.address)).toEqual([
      owner.address, KEYS[0], KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[8], SYSTEM_PROGRAM, KEYS[7], TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
    ])
    expect(ix.accounts!.map((a) => a.role)).toEqual([
      AccountRole.READONLY_SIGNER, AccountRole.READONLY, AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.READONLY, AccountRole.READONLY,
      AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.READONLY, AccountRole.READONLY, AccountRole.READONLY,
    ])
  })

  it("add_liquidity: [3, stock_max, usdc_max, min_lp], 15 accounts ending in system", async () => {
    const owner = await generateKeyPairSigner()
    const lp = await lpPda(market.programId, market.pool, owner.address)
    const ix = addLiquidityInstruction(market, { owner, ownerStock: KEYS[8], ownerUsdc: KEYS[9] }, { stockMax: 1n, usdcMax: 2n, minLp: 3n, lp })
    expect(ix.data!.length).toBe(25)
    expect(Array.from(ix.data!.subarray(0, 2))).toEqual([3, 1])
    expect(new DataView(ix.data!.buffer).getBigUint64(9, true)).toBe(2n)
    expect(new DataView(ix.data!.buffer).getBigUint64(17, true)).toBe(3n)
    expect(ix.accounts!.length).toBe(15)
    expect(ix.accounts![0].role).toBe(AccountRole.WRITABLE_SIGNER)
    expect(ix.accounts![2].role).toBe(AccountRole.READONLY) // symbol is read-only on deposit
    expect(ix.accounts![4]).toMatchObject({ address: lp, role: AccountRole.WRITABLE })
    expect(ix.accounts![14].address).toBe(SYSTEM_PROGRAM)
  })

  it("remove_liquidity: [4, lp, min_stock, min_usdc], same accounts minus system", async () => {
    const owner = await generateKeyPairSigner()
    const ix = removeLiquidityInstruction(market, { owner, ownerStock: KEYS[8], ownerUsdc: KEYS[9] }, { lpShares: 500n, minStock: 0n, minUsdc: 0n, lp: KEYS[3] })
    expect(ix.data![0]).toBe(4)
    expect(new DataView(ix.data!.buffer).getBigUint64(1, true)).toBe(500n)
    expect(ix.accounts!.length).toBe(14)
    expect(ix.accounts!.at(-1)!.address).toBe(TOKEN_PROGRAM)
  })

  it("rejects amounts outside u64", async () => {
    const owner = await generateKeyPairSigner()
    expect(() => swapInstruction(market, { owner, ownerStock: KEYS[8], ownerUsdc: KEYS[9] }, { direction: 0, amountIn: 1n << 64n, minOut: 0n })).toThrow(RangeError)
  })

  it("quoteSwap mirrors the program: fee rounded up, output rounded down", () => {
    expect(quoteSwap(1_000_000n, 10_000_000n, 5_000_000n, 30)).toEqual({ fee: 3_000n, out: 453_305n })
    expect(quoteSwap(250_000n, 3_000_000n, 7_000_000n, 25)).toEqual({ fee: 625n, out: 537_218n })
    expect(quoteSwap(0n, 1n, 1n, 30).out).toBe(0n)
    expect(withSlippage(453_305n, 50)).toBe(451_038n)
  })

  it("PDAs are deterministic and owner-specific", async () => {
    const [a, b] = await Promise.all([lpPda(KEYS[9], KEYS[2], KEYS[0]), lpPda(KEYS[9], KEYS[2], KEYS[1])])
    expect(await lpPda(KEYS[9], KEYS[2], KEYS[0])).toBe(a)
    expect(a).not.toBe(b)
  })
})

describe("error codes", () => {
  it("covers 6000–6016 in program order", () => {
    expect(Object.keys(VENUE_ERRORS).map(Number)).toEqual(Array.from({ length: 17 }, (_, i) => 6000 + i))
    expect(VENUE_ERRORS[6000].name).toBe("NotAdmitted")
    expect(VENUE_ERRORS[6016].name).toBe("InvalidArgument")
  })

  it("maps the participant states to plain messages", () => {
    expect(toVenueError({ InstructionError: [0, { Custom: 6000 }] })).toMatchObject({ name: "NotAdmitted", message: "Not admitted · Get admitted →", action: "/app/onboard" })
    expect(toVenueError({ InstructionError: [2, { Custom: 6001 }] })?.message).toBe("Halted by Nasdaq")
    expect(toVenueError(new Error("Simulation failed: custom program error: 0x1772"))?.message).toBe("Halt data stale · trading paused")
    expect(toVenueError("custom program error: 0x1775")?.message).toBe("Daily cap reached · resets 04:00 ET")
    expect(toVenueError(new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code: 6004, index: 0 }))?.message).toBe("Paused 3 months after a second breach")
  })

  it("finds codes nested in wallet error causes, and ignores foreign errors", () => {
    expect(customErrorCode({ cause: { data: { err: { InstructionError: [0, { Custom: 6005 }] } } } })).toBe(6005)
    expect(customErrorCode({ InstructionError: [0n, { Custom: 6013n }] })).toBe(6013)
    expect(toVenueError({ InstructionError: [0, { Custom: 1 }] })).toBeNull()
    expect(describeError(new Error("User rejected the request."))).toBe("Signature request declined")
  })
})

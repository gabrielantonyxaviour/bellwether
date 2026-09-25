import { address, generateKeyPairSigner } from "@solana/kit"
import { describe, expect, it } from "vitest"
import { activatePoolInstruction, recordIssuerNoticeInstruction, recordObjectionInstruction, registerSymbolInstruction } from "./instructions"

const program = address("11111111111111111111111111111111")

describe("operator instruction bytes", () => {
  it("encodes register, notice, objection and activate as the program reads them", async () => {
    const admin = await generateKeyPairSigner()
    const venue = admin.address
    const symbol = admin.address
    const mint = admin.address
    const registered = registerSymbolInstruction(program, admin, venue, symbol, mint, { tier: 2, issuerSponsored: false, ticker: "DEMO" })
    expect(Array.from(registered.data!)).toEqual([1, 2, 0, 68, 69, 77, 79, 0, 0, 0, 0])
    expect(registered.accounts).toHaveLength(5)
    const notice = recordIssuerNoticeInstruction(program, admin, venue, symbol, 1_700_000_000)
    expect(notice.data![0]).toBe(21)
    expect(new DataView(notice.data!.buffer).getBigInt64(1, true)).toBe(1_700_000_000n)
    expect(recordObjectionInstruction(program, admin, venue, symbol).data).toEqual(Uint8Array.of(22))
    expect(activatePoolInstruction(program, admin, venue, symbol).data).toEqual(Uint8Array.of(23))
  })
})

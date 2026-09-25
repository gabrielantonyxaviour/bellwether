import { afterEach, describe, expect, it, vi } from "vitest"
import { api, ApiError } from "@/lib/api"

vi.mock("@/lib/cluster", () => ({ clusterConfig: () => ({ credentialApiUrl: "https://credential.example.org" }) }))

const wallet = "Vote111111111111111111111111111111111111111"
const message = `Bellwether test admission\nWallet: ${wallet}\nNonce: test\nExpires: 2026-09-25T15:00:00.000Z`
const challenge = { wallet, message, expiresAt: "2026-09-25T15:00:00.000Z", expiresAtUnix: 1790348400 }
const admitted = {
  label: "test admission, not KYC", wallet, status: "admitted", alreadyAdmitted: false,
  expiresAt: "2026-09-26T15:00:00.000Z", expiresAtUnix: 1790434800,
  credential: { kind: "sas", address: wallet }, stockAccount: { address: wallet, state: "thawed" }, signature: "tx",
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

afterEach(() => vi.unstubAllGlobals())

describe("signed admission", () => {
  it("signs exact challenge bytes and posts a base64 Ed25519 signature", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(challenge)).mockResolvedValueOnce(json(admitted))
    vi.stubGlobal("fetch", fetch)
    const signature = Uint8Array.from({ length: 64 }, (_, i) => i)
    const signMessage = vi.fn().mockResolvedValue(signature)

    await expect(api.admit(wallet, signMessage)).resolves.toMatchObject({ status: "admitted", wallet })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe(`https://credential.example.org/admit/challenge?wallet=${wallet}`)
    expect(signMessage).toHaveBeenCalledWith(new TextEncoder().encode(message))
    expect(fetch.mock.calls[1][0]).toBe("https://credential.example.org/admit")
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ wallet, message, signature: btoa(String.fromCharCode(...signature)) })
  })

  it("rejects a challenge for another wallet before asking for a signature", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ...challenge, wallet: "OtherWallet" }))
    vi.stubGlobal("fetch", fetch)
    const signMessage = vi.fn()
    await expect(api.admit(wallet, signMessage)).rejects.toMatchObject({ code: "bad_response" } satisfies Partial<ApiError>)
    expect(signMessage).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("does not submit a malformed wallet signature", async () => {
    const fetch = vi.fn().mockResolvedValue(json(challenge))
    vi.stubGlobal("fetch", fetch)
    await expect(api.admit(wallet, async () => new Uint8Array(63))).rejects.toMatchObject({ code: "invalid_signature" } satisfies Partial<ApiError>)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

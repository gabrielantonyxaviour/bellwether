import { describe, expect, it } from "vitest"
import { envLayer, explorerUrl, MAINNET_USDC_MINT, resolveClusterConfig, walletChain, wsUrlFor } from "@/lib/cluster"

const PROGRAM = "Vote111111111111111111111111111111111111111"
const DEVNET_USDC = "Stake11111111111111111111111111111111111111"

describe("cluster config", () => {
  it("defaults to devnet with public RPC and no mints", () => {
    const c = resolveClusterConfig({})
    expect(c).toMatchObject({ cluster: "devnet", rpcUrl: "https://api.devnet.solana.com", wsUrl: "wss://api.devnet.solana.com/", usdcMint: null, programId: null, defaultSymbol: "BWRS" })
    expect(c).toMatchObject({ apiBaseUrl: "http://localhost:8787", credentialApiUrl: "http://localhost:8790" })
  })

  it("fork: local RPC, ws on port+1, mainnet USDC, FWDI", () => {
    const c = resolveClusterConfig(envLayer({ VITE_CLUSTER: "fork" }))
    expect(c).toMatchObject({ rpcUrl: "http://127.0.0.1:8899", wsUrl: "ws://127.0.0.1:8900/", usdcMint: MAINNET_USDC_MINT, defaultSymbol: "FWDI", local: true })
  })

  it("reads VITE_* values and trims trailing slashes from service URLs", () => {
    const c = resolveClusterConfig(envLayer({
      VITE_CLUSTER: "devnet", VITE_PROGRAM_ID: PROGRAM, VITE_USDC_MINT: DEVNET_USDC,
      VITE_API_BASE_URL: "https://api.example.org/", VITE_CREDENTIAL_API_URL: "https://cred.example.org//", VITE_RPC_URL: "",
    }))
    expect(c).toMatchObject({ programId: PROGRAM, usdcMint: DEVNET_USDC, apiBaseUrl: "https://api.example.org", credentialApiUrl: "https://cred.example.org", rpcUrl: "https://api.devnet.solana.com" })
  })

  it("/config.json overrides env on the same cluster", () => {
    const env = envLayer({ VITE_CLUSTER: "devnet", VITE_PROGRAM_ID: PROGRAM, VITE_RPC_URL: "https://rpc-a.example.org" })
    const c = resolveClusterConfig(env, { rpcUrl: "https://rpc-b.example.org" })
    expect(c).toMatchObject({ rpcUrl: "https://rpc-b.example.org", programId: PROGRAM })
  })

  it("/config.json switching cluster drops the build's VITE_* values", () => {
    const env = envLayer({ VITE_CLUSTER: "devnet", VITE_PROGRAM_ID: PROGRAM, VITE_USDC_MINT: DEVNET_USDC })
    const c = resolveClusterConfig(env, { cluster: "mainnet" })
    expect(c).toMatchObject({ cluster: "mainnet", rpcUrl: "https://api.mainnet-beta.solana.com", programId: null, usdcMint: MAINNET_USDC_MINT })
  })

  it("rejects malformed values", () => {
    expect(() => envLayer({ VITE_CLUSTER: "testnet" })).toThrow()
    expect(() => envLayer({ VITE_PROGRAM_ID: "not-an-address" })).toThrow()
    expect(() => envLayer({ VITE_RPC_URL: "localhost:8899" })).toThrow()
  })

  it("explorer links: Solscan per cluster", () => {
    const sig = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
    expect(explorerUrl("tx", sig, resolveClusterConfig({ cluster: "mainnet" }))).toBe(`https://solscan.io/tx/${sig}`)
    expect(explorerUrl("account", PROGRAM, resolveClusterConfig({ cluster: "devnet" }))).toBe(`https://solscan.io/account/${PROGRAM}?cluster=devnet`)
    expect(explorerUrl("tx", sig, resolveClusterConfig({ cluster: "fork" }))).toBe(
      `https://solscan.io/tx/${sig}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`,
    )
  })

  it("wallet chain and ws derivation", () => {
    expect(walletChain(resolveClusterConfig({ cluster: "fork" }))).toBe("solana:mainnet")
    expect(walletChain(resolveClusterConfig({ cluster: "devnet" }))).toBe("solana:devnet")
    expect(wsUrlFor("https://mainnet.helius-rpc.com/?api-key=x", false)).toBe("wss://mainnet.helius-rpc.com/?api-key=x")
  })
})

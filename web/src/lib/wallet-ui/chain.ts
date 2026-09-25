import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit"
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { clusterConfig, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "@/lib/cluster"
import { decodeLpPosition, decodePool, decodeSymbolRecord, decodeVenueConfig, lpPda, poolPda, symbolPda } from "@/lib/program"
import type { Pair } from "@/lib/api"

const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address
const rpcResult = z.object({ result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() })
const accountResult = z.object({ value: z.object({ data: z.tuple([z.string(), z.literal("base64")]) }).nullable() })
const accountsResult = z.object({ value: z.array(accountResult.shape.value) })
const encoder = getAddressEncoder()
const decoder = getAddressDecoder()

function mintAuthorities(raw: Uint8Array) {
  if (raw.length < 82) throw new Error("Stock mint account is incomplete")
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const option = (offset: number): Address | null => view.getUint32(offset, true) === 0 ? null :
    decoder.decode(raw.subarray(offset + 4, offset + 36))
  return { mintAuthority: option(0), freezeAuthority: option(46) }
}

async function rpc(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(clusterConfig().rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      if ((response.status !== 429 && response.status < 500) || attempt >= 3) throw new Error(`Chain RPC returned HTTP ${response.status}`)
    } else {
      const parsed = rpcResult.parse(await response.json())
      if (!parsed.error) return parsed.result
      if (!/rate limit|too many requests|\b429\b|temporarily unavailable/i.test(parsed.error.message) || attempt >= 3) throw new Error(parsed.error.message)
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
    if (signal?.aborted) throw signal.reason
  }
}

function bytes(value: z.infer<typeof accountResult>["value"]): Uint8Array | null {
  if (!value) return null
  const binary = atob(value.data[0])
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export async function readAccount(address: Address, signal?: AbortSignal): Promise<Uint8Array | null> {
  const parsed = accountResult.parse(await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }], signal))
  return bytes(parsed.value)
}

async function readAccounts(addresses: Address[], signal?: AbortSignal): Promise<(Uint8Array | null)[]> {
  const parsed = accountsResult.parse(await rpc("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }], signal))
  if (parsed.value.length !== addresses.length) throw new Error("Chain RPC returned an incomplete account batch")
  return parsed.value.map(bytes)
}

function tokenAmount(raw: Uint8Array | null, mint: Address, owner: Address): bigint {
  if (!raw) return 0n
  if (raw.length < 72 || decoder.decode(raw.subarray(0, 32)) !== mint || decoder.decode(raw.subarray(32, 64)) !== owner) {
    throw new Error("Wallet token account data does not match the expected mint and owner")
  }
  return new DataView(raw.buffer, raw.byteOffset).getBigUint64(64, true)
}

export async function associatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [found] = await getProgramDerivedAddress({ programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(owner), encoder.encode(tokenProgram), encoder.encode(mint)] })
  return found
}

export async function marketAccounts(pair: Pair, wallet: Address | null, signal?: AbortSignal) {
  const config = clusterConfig()
  if (!config.venue || !config.programId) throw new Error("Venue program is not configured on this cluster")
  const stockMint = pair.stock_mint as Address
  const symbolAddress = await symbolPda(config.programId, config.venue, stockMint)
  const poolAddress = await poolPda(config.programId, symbolAddress)
  const [venueRaw, symbolRaw, poolRaw, clockRaw, mintRaw] = await readAccounts(
    [config.venue, symbolAddress, poolAddress, CLOCK_SYSVAR, stockMint], signal)
  if (!venueRaw || !symbolRaw || !poolRaw || !clockRaw || clockRaw.length < 40 || !mintRaw) throw new Error("Venue market, mint, or clock accounts are not on this cluster")
  const chainTime = Number(new DataView(clockRaw.buffer, clockRaw.byteOffset).getBigInt64(32, true))
  const venue = decodeVenueConfig(venueRaw)
  const symbol = decodeSymbolRecord(symbolRaw)
  const pool = decodePool(poolRaw)
  const authorities = mintAuthorities(mintRaw)
  if (symbol.mint !== stockMint || pool.symbol !== symbolAddress || pair.pool !== poolAddress) throw new Error("Indexer and chain market addresses disagree")
  const ownerStock = wallet ? await associatedTokenAddress(wallet, pool.stockMint, TOKEN_2022_PROGRAM) : null
  const ownerUsdc = wallet ? await associatedTokenAddress(wallet, pool.usdcMint, TOKEN_PROGRAM) : null
  const lpAddress = wallet ? await lpPda(config.programId, poolAddress, wallet) : null
  const [stockRaw, usdcRaw, lpRaw] = wallet && ownerStock && ownerUsdc && lpAddress
    ? await readAccounts([ownerStock, ownerUsdc, lpAddress], signal) : [null, null, null]
  const stockBalance = wallet ? tokenAmount(stockRaw, pool.stockMint, wallet) : null
  const usdcBalance = wallet ? tokenAmount(usdcRaw, pool.usdcMint, wallet) : null
  return {
    addresses: { programId: config.programId, venue: config.venue, symbol: symbolAddress, pool: poolAddress,
      stockMint: pool.stockMint, usdcMint: pool.usdcMint, stockVault: pool.stockVault, usdcVault: pool.usdcVault },
    venue, symbol, pool, authorities, chainTime, ownerStock, ownerUsdc, stockBalance, usdcBalance, lpAddress,
    lp: lpRaw ? decodeLpPosition(lpRaw) : null,
  }
}

export function useMarketAccounts(pair: Pair | null, wallet: Address | null) {
  return useQuery({
    queryKey: ["market-accounts", pair?.pool ?? null, wallet],
    queryFn: ({ signal }) => marketAccounts(pair!, wallet, signal),
    enabled: !!pair,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  })
}

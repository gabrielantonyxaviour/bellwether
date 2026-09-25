import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { request } from "@/lib/api"
import { clusterConfig } from "@/lib/cluster"

const address = z.string().min(32)
const TokenSchema = z.looseObject({
  address,
  decimals: z.number().int(),
  freezeAuthority: address.nullable(),
  mintAuthority: address.nullable(),
  permanentDelegate: address.nullable(),
  pausable: z.looseObject({ authority: address.nullable(), paused: z.boolean() }).nullable(),
})
const SymbolSchema = z.looseObject({
  ticker: z.string(),
  address,
  mint: address,
  capShares: z.string(),
  pausedUntil: z.number().nullable(),
  pool: z.looseObject({ address, feeBps: z.number().int() }).nullable(),
  token: TokenSchema.nullable(),
})

/** The chain slice of GET /notice/draft. The web placeholder schema is looser than this. */
export const NoticeChainSchema = z.looseObject({
  generatedAt: z.string(),
  orderCite: z.string().optional(),
  chain: z.looseObject({
    program: z
      .looseObject({
        id: address,
        upgradeable: z.boolean(),
        programData: address.nullable(),
        upgradeAuthority: address.nullable(),
      })
      .nullable(),
    venue: z
      .looseObject({
        address,
        admin: address,
        relay: address,
        dataAuthority: address,
        credentialIssuer: address,
        heartbeatMaxAgeS: z.number().int(),
      })
      .nullable(),
    symbols: z.array(SymbolSchema),
    errors: z.array(z.string()).optional(),
  }),
})
export type NoticeChain = z.infer<typeof NoticeChainSchema>

export function useNoticeChain() {
  return useQuery({
    queryKey: ["notice", "public-chain"],
    queryFn: ({ signal }) => request(clusterConfig().apiBaseUrl, "/notice/draft", NoticeChainSchema, { signal }),
    refetchInterval: 60_000,
  })
}

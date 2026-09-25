import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { z } from "zod"
import { readOperatorBook } from "@/components/operator/book"
import { HaltRowSchema, OperatorNoticeSchema, OperatorRehearsalSchema, RelayHealthSchema } from "@/components/operator/schemas"
import { AdmitResponseSchema, api, request, useSymbols, useVenue } from "@/lib/api"
import { clusterConfig } from "@/lib/cluster"

const TOKEN_KEY = "bellwether.operator.token"

const HaltsViewSchema = z.looseObject({
  generated_at: z.string(),
  source: z.string().nullable(),
  skipped: z.number(),
  relay: RelayHealthSchema,
  halts: z.array(HaltRowSchema),
})

export function useOperatorBook() {
  const symbols = useSymbols()
  const venue = useVenue()
  const chain = useQuery({
    queryKey: ["operator-book"],
    queryFn: ({ signal }) => readOperatorBook(signal),
    refetchInterval: 15_000,
  })
  return { symbols, venue, chain }
}

export function useOperatorHalts() {
  return useQuery({
    queryKey: ["operator-halts"],
    queryFn: ({ signal }) => request(clusterConfig().apiBaseUrl, "/halts", HaltsViewSchema, { signal }),
    refetchInterval: 15_000,
  })
}

export function useOperatorNotice() {
  return useQuery({
    queryKey: ["operator-notice"],
    queryFn: ({ signal }) => request(clusterConfig().apiBaseUrl, "/notice/draft", OperatorNoticeSchema, { signal }),
  })
}

export function useOperatorRehearsal() {
  return useQuery({
    queryKey: ["operator-rehearsal"],
    queryFn: ({ signal }) => request(clusterConfig().apiBaseUrl, "/rehearsal/fwdi", OperatorRehearsalSchema, { signal }),
  })
}

export function useOperatorToken() {
  const [token, setToken] = useState("")
  useEffect(() => {
    try { setToken(sessionStorage.getItem(TOKEN_KEY) ?? "") } catch { /* private mode */ }
  }, [])
  const save = (next: string) => {
    setToken(next)
    try {
      if (next) sessionStorage.setItem(TOKEN_KEY, next)
      else sessionStorage.removeItem(TOKEN_KEY)
    } catch { /* private mode */ }
  }
  return { token, save }
}

export function useScreeningLog(token: string) {
  return useQuery({
    queryKey: ["screening-log", token],
    queryFn: () => api.screeningLog(token, { limit: 50 }),
    enabled: token.length > 0,
  })
}

export function useOperatorAdmit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ wallet, token }: { wallet: string; token: string }) =>
      request(clusterConfig().credentialApiUrl, "/admit", AdmitResponseSchema, { method: "POST", body: { wallet }, token }),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ["screening-log", vars.token] }),
  })
}

export function useOperatorRevoke() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ wallet, token }: { wallet: string; token: string }) => api.revoke(wallet, token),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["screening-log", vars.token] })
      qc.invalidateQueries({ queryKey: ["credential", vars.wallet] })
    },
  })
}


/**
 * Typed, zod-validated fetchers for Bellwether's services, plus react-query keys and hooks.
 *
 *   Venue API (clusterConfig().apiBaseUrl):          GET /tape /symbols /venue /halts
 *   Credential issuer (clusterConfig().credentialApiUrl): POST /admit /revoke, GET /credential/:wallet /screening-log
 *   Placeholders (no service route yet):             GET /notice/draft, GET /rehearsal/fwdi
 *
 * Every service error is { error, code? }; fetchers throw ApiError carrying both.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { z } from "zod"
import { clusterConfig } from "@/lib/cluster"
import {
  AdmitResponseSchema,
  ApiErrorBodySchema,
  CredentialStatusSchema,
  HaltsResponseSchema,
  NoticeDraftSchema,
  RehearsalReportSchema,
  RevokeResponseSchema,
  ScreeningLogSchema,
  SymbolsResponseSchema,
  TapeResponseSchema,
  VenueResponseSchema,
} from "@/lib/api-schemas"

export * from "@/lib/api-schemas"

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

interface RequestOptions {
  method?: "GET" | "POST"
  body?: unknown
  /** Operator bearer token (revoke, screening log). */
  token?: string
  signal?: AbortSignal
}

export async function request<S extends z.ZodType>(base: string, path: string, schema: S, opts: RequestOptions = {}): Promise<z.infer<S>> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error
    throw new ApiError(`Cannot reach ${new URL(base).host}`, 0, "network")
  }
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const body = ApiErrorBodySchema.safeParse(json)
    throw new ApiError(body.success ? body.data.error : `HTTP ${res.status}`, res.status, body.success ? body.data.code : undefined)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ApiError(`Unexpected response from ${path}: ${issue?.path.join(".")} ${issue?.message}`, res.status, "bad_response")
  }
  return parsed.data
}

const venueApi = () => clusterConfig().apiBaseUrl
const credentialApi = () => clusterConfig().credentialApiUrl
const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString()
  return s ? `?${s}` : ""
}

export interface TapeQuery {
  /** UTC date YYYY-MM-DD; the API defaults to today. */
  date?: string
  symbol?: string
  side?: "buy" | "sell"
}

export const api = {
  tape: (q: TapeQuery = {}, signal?: AbortSignal) => request(venueApi(), `/tape${qs({ ...q })}`, TapeResponseSchema, { signal }),
  symbols: (signal?: AbortSignal) => request(venueApi(), "/symbols", SymbolsResponseSchema, { signal }),
  venue: (signal?: AbortSignal) => request(venueApi(), "/venue", VenueResponseSchema, { signal }),
  halts: (symbol?: string, signal?: AbortSignal) => request(venueApi(), `/halts${qs({ symbol })}`, HaltsResponseSchema, { signal }),
  /** Public tape JSON link for the "machine-readable" affordance. */
  tapeUrl: (q: TapeQuery = {}) => `${venueApi()}/tape${qs({ ...q })}`,

  admit: (wallet: string) => request(credentialApi(), "/admit", AdmitResponseSchema, { method: "POST", body: { wallet } }),
  revoke: (wallet: string, token: string) =>
    request(credentialApi(), "/revoke", RevokeResponseSchema, { method: "POST", body: { wallet }, token }),
  credential: (wallet: string, signal?: AbortSignal) =>
    request(credentialApi(), `/credential/${encodeURIComponent(wallet)}`, CredentialStatusSchema, { signal }),
  screeningLog: (token: string, opts: { limit?: number; wallet?: string } = {}) =>
    request(credentialApi(), `/screening-log${qs({ limit: opts.limit?.toString(), wallet: opts.wallet })}`, ScreeningLogSchema, { token }),

  /** Placeholder: services/notice has no HTTP route yet; the path is the agreed target. */
  noticeDraft: (signal?: AbortSignal) => request(venueApi(), "/notice/draft", NoticeDraftSchema, { signal }),
  /** Placeholder: services/rehearsal writes latest-report.json; the path is the agreed target. */
  rehearsalReport: (signal?: AbortSignal) => request(venueApi(), "/rehearsal/fwdi", RehearsalReportSchema, { signal }),
}

export const queryKeys = {
  tape: (q: TapeQuery = {}) => ["tape", q] as const,
  symbols: () => ["symbols"] as const,
  venue: () => ["venue"] as const,
  halts: (symbol?: string) => ["halts", symbol ?? null] as const,
  credential: (wallet: string | null) => ["credential", wallet] as const,
  noticeDraft: () => ["notice", "draft"] as const,
  rehearsal: () => ["rehearsal", "fwdi"] as const,
}

/** The tape refreshes every 5 s (the API caches 5 s); state endpoints every 15 s. */
export const useTape = (q: TapeQuery = {}) =>
  useQuery({ queryKey: queryKeys.tape(q), queryFn: ({ signal }) => api.tape(q, signal), refetchInterval: 5_000 })
export const useSymbols = () => useQuery({ queryKey: queryKeys.symbols(), queryFn: ({ signal }) => api.symbols(signal), refetchInterval: 15_000 })
export const useVenue = () => useQuery({ queryKey: queryKeys.venue(), queryFn: ({ signal }) => api.venue(signal), refetchInterval: 15_000 })
export const useHalts = (symbol?: string) =>
  useQuery({ queryKey: queryKeys.halts(symbol), queryFn: ({ signal }) => api.halts(symbol, signal), refetchInterval: 15_000 })
export const useCredential = (wallet: string | null) =>
  useQuery({
    queryKey: queryKeys.credential(wallet),
    queryFn: ({ signal }) => api.credential(wallet!, signal),
    enabled: !!wallet,
    refetchInterval: 60_000,
  })
export const useNoticeDraft = () => useQuery({ queryKey: queryKeys.noticeDraft(), queryFn: ({ signal }) => api.noticeDraft(signal) })
export const useRehearsalReport = () => useQuery({ queryKey: queryKeys.rehearsal(), queryFn: ({ signal }) => api.rehearsalReport(signal) })

export function useAdmit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (wallet: string) => api.admit(wallet),
    onSuccess: (_data, wallet) => qc.invalidateQueries({ queryKey: queryKeys.credential(wallet) }),
  })
}

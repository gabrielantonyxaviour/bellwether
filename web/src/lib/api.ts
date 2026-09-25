/**
 * Typed, zod-validated fetchers for Bellwether's services, plus react-query keys and hooks.
 *
 *   Venue API (clusterConfig().apiBaseUrl):          GET /tape /symbols /venue /halts
 *   Credential issuer (clusterConfig().credentialApiUrl): GET /admit/challenge, POST /admit /revoke,
 *     GET /credential/:wallet /screening-log
 *   Venue API: GET /notice/draft /rehearsal/fwdi
 *
 * Every service error is { error, code? }; fetchers throw ApiError carrying both.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { clusterConfig } from "@/lib/cluster"
import {
  AdmitResponseSchema,
  ApiErrorBodySchema,
  CredentialStatusSchema,
  CredentialHealthSchema,
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

const AdmitChallengeSchema = z.looseObject({
  wallet: z.string(),
  message: z.string().min(1),
  expiresAt: z.iso.datetime(),
  expiresAtUnix: z.number().int(),
})

export type SignAdmissionMessage = (message: Uint8Array) => Promise<Uint8Array>

function signatureBase64(signature: Uint8Array): string {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new ApiError("Wallet returned an invalid admission signature", 0, "invalid_signature")
  }
  let binary = ""
  for (const byte of signature) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const api = {
  tape: (q: TapeQuery = {}, signal?: AbortSignal) => request(venueApi(), `/tape${qs({ ...q })}`, TapeResponseSchema, { signal }),
  symbols: (signal?: AbortSignal) => request(venueApi(), "/symbols", SymbolsResponseSchema, { signal }),
  venue: (signal?: AbortSignal) => request(venueApi(), "/venue", VenueResponseSchema, { signal }),
  halts: (symbol?: string, signal?: AbortSignal) => request(venueApi(), `/halts${qs({ symbol })}`, HaltsResponseSchema, { signal }),
  /** Public tape JSON link for the "machine-readable" affordance. */
  tapeUrl: (q: TapeQuery = {}) => `${venueApi()}/tape${qs({ ...q })}`,

  admitChallenge: (wallet: string) =>
    request(credentialApi(), `/admit/challenge?wallet=${encodeURIComponent(wallet)}`, AdmitChallengeSchema),
  admit: async (wallet: string, signMessage: SignAdmissionMessage) => {
    const challenge = await api.admitChallenge(wallet)
    if (challenge.wallet !== wallet) throw new ApiError("Admission challenge belongs to a different wallet", 0, "bad_response")
    const signature = signatureBase64(await signMessage(new TextEncoder().encode(challenge.message)))
    return request(credentialApi(), "/admit", AdmitResponseSchema, {
      method: "POST", body: { wallet, message: challenge.message, signature },
    })
  },
  revoke: (wallet: string, token: string) =>
    request(credentialApi(), "/revoke", RevokeResponseSchema, { method: "POST", body: { wallet }, token }),
  credential: (wallet: string, signal?: AbortSignal) =>
    request(credentialApi(), `/credential/${encodeURIComponent(wallet)}`, CredentialStatusSchema, { signal }),
  credentialHealth: (signal?: AbortSignal) => request(credentialApi(), "/health", CredentialHealthSchema, { signal }),
  screeningLog: (token: string, opts: { limit?: number; wallet?: string } = {}) =>
    request(credentialApi(), `/screening-log${qs({ limit: opts.limit?.toString(), wallet: opts.wallet })}`, ScreeningLogSchema, { token }),

  noticeDraft: (signal?: AbortSignal) => request(venueApi(), "/notice/draft", NoticeDraftSchema, { signal }),
  rehearsalReport: (signal?: AbortSignal) => request(venueApi(), "/rehearsal/fwdi", RehearsalReportSchema, { signal }),
}

export const queryKeys = {
  tape: (q: TapeQuery = {}) => ["tape", q] as const,
  symbols: () => ["symbols"] as const,
  venue: () => ["venue"] as const,
  halts: (symbol?: string) => ["halts", symbol ?? null] as const,
  credential: (wallet: string | null) => ["credential", wallet] as const,
  credentialHealth: () => ["credential", "health"] as const,
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
export const useCredentialHealth = (enabled: boolean) =>
  useQuery({ queryKey: queryKeys.credentialHealth(), queryFn: ({ signal }) => api.credentialHealth(signal), enabled, staleTime: 60_000 })
export const useNoticeDraft = () => useQuery({ queryKey: queryKeys.noticeDraft(), queryFn: ({ signal }) => api.noticeDraft(signal) })
export const useRehearsalReport = () => useQuery({ queryKey: queryKeys.rehearsal(), queryFn: ({ signal }) => api.rehearsalReport(signal) })

export function useAdmit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ wallet, signMessage }: { wallet: string; signMessage: SignAdmissionMessage }) => api.admit(wallet, signMessage),
    onSuccess: (_data, { wallet }) => qc.invalidateQueries({ queryKey: queryKeys.credential(wallet) }),
  })
}

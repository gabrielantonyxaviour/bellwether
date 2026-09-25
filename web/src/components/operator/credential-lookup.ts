export type CredentialLookupPhase = "empty" | "loading" | "error" | "result"

/**
 * What the participant lookup card shows.
 * A disabled credential query stays pending forever and must not be read as loading.
 * Pass `isLoading` (pending and fetching), never `isPending` alone.
 */
export function credentialLookupPhase(
  wallet: string | null,
  query: { isLoading: boolean; isError: boolean; hasData: boolean },
): CredentialLookupPhase {
  if (!wallet) return "empty"
  if (query.isLoading) return "loading"
  if (query.isError) return "error"
  if (query.hasData) return "result"
  return "empty"
}

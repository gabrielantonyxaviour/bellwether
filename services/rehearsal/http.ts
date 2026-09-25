/** Keyless public-web fetches (Nasdaq, Yahoo, Jupiter, Nasdaq Trader) with a browser UA and retries. */
import { BROWSER_UA } from "./constants.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface Fetched<T> {
  body: T
  url: string
  fetchedAt: string
}

async function fetchWithRetry(url: string, accept: string, fetchImpl: typeof fetch, retries: number): Promise<{ response: Response; fetchedAt: string }> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": BROWSER_UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(30_000),
      })
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`)
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { fatal: true })
      return { response, fetchedAt: new Date().toISOString() }
    } catch (error) {
      lastError = error
      if ((error as { fatal?: boolean }).fatal || attempt === retries) break
      await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 300))
    }
  }
  throw new Error(`${new URL(url).host}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

export async function getJson<T>(url: string, fetchImpl: typeof fetch = fetch, retries = 3): Promise<Fetched<T>> {
  const { response, fetchedAt } = await fetchWithRetry(url, "application/json", fetchImpl, retries)
  return { body: (await response.json()) as T, url, fetchedAt }
}

export async function getText(url: string, fetchImpl: typeof fetch = fetch, retries = 3): Promise<Fetched<string>> {
  const { response, fetchedAt } = await fetchWithRetry(url, "application/rss+xml, application/xml, text/xml, */*", fetchImpl, retries)
  return { body: await response.text(), url, fetchedAt }
}

/**
 * The live screening source: the official SDN list (cached, refreshed when older than the max
 * age) merged with the rehearsal fixture. One load at a time; screening fails closed when
 * no official list has ever been obtained.
 */
import { Screener, countByCurrency, loadOfficialList, type LoadedList, type SdnEntry } from "./sdn.js"

export interface ListInfo {
  source: string
  publishDate: string | null
  fetchedAt: string
  stale: boolean
  officialAddresses: number
  fixtureAddresses: number
  byCurrency: Record<string, number>
}

export interface ScreenResult {
  match: SdnEntry | null
  list: ListInfo
}

export interface Screening {
  screen(address: string): Promise<ScreenResult>
  info(): ListInfo | null
}

export function createScreening(opts: {
  cachePath: string
  url: string
  maxAgeMs: number
  fixture: SdnEntry[]
  fetchImpl?: typeof fetch
}): Screening {
  let current: { loaded: LoadedList; screener: Screener; checkedAt: number; info: ListInfo } | null = null
  let inflight: Promise<void> | null = null

  async function load(): Promise<void> {
    const loaded = await loadOfficialList({ cachePath: opts.cachePath, url: opts.url, maxAgeMs: opts.maxAgeMs, fetchImpl: opts.fetchImpl })
    const { list } = loaded
    current = {
      loaded,
      screener: new Screener(list.entries, opts.fixture),
      checkedAt: Date.now(),
      info: {
        source: list.source, publishDate: list.publishDate, fetchedAt: list.fetchedAt, stale: loaded.stale,
        officialAddresses: list.entries.length, fixtureAddresses: opts.fixture.length, byCurrency: countByCurrency(list.entries),
      },
    }
  }

  async function ensure(): Promise<NonNullable<typeof current>> {
    const due = !current || Date.now() - current.checkedAt >= (current.loaded.stale ? 10 * 60_000 : opts.maxAgeMs)
    if (due) {
      inflight ??= load().finally(() => { inflight = null })
      try {
        await inflight
      } catch (error) {
        if (!current) throw error
      }
    }
    return current!
  }

  return {
    async screen(address) {
      const c = await ensure()
      return { match: c.screener.match(address), list: c.info }
    },
    info: () => current?.info ?? null,
  }
}

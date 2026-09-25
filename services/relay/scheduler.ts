/**
 * Polling discipline. Nasdaq asks clients not to query the halt feed more than once a minute,
 * so every poll attempt — successful or not — passes through a PollGate that refuses a second
 * attempt within 60 s. The clock is injectable so checks can simulate hours in milliseconds.
 */

export const MIN_POLL_INTERVAL_MS = 60_000

export interface Clock {
  /** Unix milliseconds. */
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

export interface SimulatedClock extends Clock {
  advance(ms: number): void
  set(ms: number): void
}

export function simulatedClock(startMs: number): SimulatedClock {
  let t = startMs
  return {
    now: () => t,
    advance(ms) { if (ms < 0) throw new Error("a simulated clock only moves forward"); t += ms },
    set(ms) { if (ms < t) throw new Error("a simulated clock only moves forward"); t = ms },
  }
}

export class PollTooSoon extends Error {
  constructor(readonly sinceLastMs: number, readonly minIntervalMs: number) {
    super(`poll refused: ${sinceLastMs} ms since the last poll, minimum ${minIntervalMs} ms`)
    this.name = "PollTooSoon"
  }
}

export class PollGate {
  private last: number | null
  /** Every accepted attempt, oldest first (the last 1,000). */
  readonly history: number[] = []

  constructor(readonly minIntervalMs = MIN_POLL_INTERVAL_MS, lastPollAt: number | null = null) {
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < MIN_POLL_INTERVAL_MS) {
      throw new Error(`poll interval must be at least ${MIN_POLL_INTERVAL_MS} ms (Nasdaq: at most once a minute), got ${minIntervalMs}`)
    }
    this.last = lastPollAt
  }

  get lastPollAt(): number | null {
    return this.last
  }

  /** Milliseconds until the next poll is allowed (0 = now). */
  waitMs(now: number): number {
    return this.last === null ? 0 : Math.max(0, this.last + this.minIntervalMs - now)
  }

  /** Claims a poll slot at `now`, or throws PollTooSoon. */
  acquire(now: number): void {
    if (this.last !== null && now - this.last < this.minIntervalMs) throw new PollTooSoon(now - this.last, this.minIntervalMs)
    this.last = now
    this.history.push(now)
    if (this.history.length > 1_000) this.history.shift()
  }
}

/**
 * Runs `cycle` forever, one attempt per interval, until `signal` aborts. A cycle that throws is
 * reported and the loop continues; the gate still spaces the next attempt.
 */
export async function runLoop(options: {
  cycle: () => Promise<unknown>
  gate: PollGate
  clock?: Clock
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
  onError?: (error: unknown) => void
}): Promise<void> {
  const clock = options.clock ?? systemClock
  const interval = Math.max(options.intervalMs ?? MIN_POLL_INTERVAL_MS, options.gate.minIntervalMs)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
  }))
  while (!options.signal?.aborted) {
    await sleep(options.gate.waitMs(clock.now()))
    if (options.signal?.aborted) break
    const started = clock.now()
    try {
      await options.cycle()
    } catch (error) {
      options.onError?.(error)
    }
    await sleep(Math.max(0, started + interval - clock.now()))
  }
}

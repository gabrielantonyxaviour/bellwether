/**
 * Bounded retries for transient RPC failures that happen before a transaction executes: rate
 * limits, dropped connections, and a fork failing to lazily fetch an account from its
 * upstream ("Failed to fetch accounts from remote"). Kit surfaces an RPC rejection that carries
 * no simulation data as "Cannot destructure property 'err' of 'data'"; that is retried too.
 * An executed-and-failed transaction or a confirmation timeout is never retried.
 */
import { errorText, type Chain } from "../../scripts/assets/tx.js"

const TRANSIENT =
  /Failed to fetch accounts from remote|error sending request|Too Many Requests|\b429\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up|Cannot destructure property 'err'/i

export const isTransient = (error: unknown) => TRANSIENT.test(errorText(error))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseMs = 800): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i >= attempts || !isTransient(error)) throw error
      await sleep(baseMs * 2 ** (i - 1))
    }
  }
}

export function resilientChain(chain: Chain): Chain {
  return {
    ...chain,
    send: (instructions, feePayer) => withRetry(() => chain.send(instructions, feePayer)),
    fundSol: (target, lamports) => withRetry(() => chain.fundSol(target, lamports)),
  }
}

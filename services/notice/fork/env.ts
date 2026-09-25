/**
 * The notice check's own Surfpool mainnet fork (127.0.0.1 only, never tunnelled): it refuses to
 * reuse whatever already answers on its port, so its clock and state are its own, and it is stopped
 * by pid through scripts/assets/surfpool.ts. Plus the two cheatcodes the check needs: the clock
 * read and surfnet_timeTravel (absolute unix milliseconds).
 */
import { probeRpc, startOrReuseSurfpool, type ForkHandle } from "../../../scripts/assets/surfpool.js"

export const NOTICE_FORK_PORT = 8950

export async function startOwnFork(port = NOTICE_FORK_PORT): Promise<ForkHandle> {
  const rpcUrl = `http://127.0.0.1:${port}`
  const probe = await probeRpc(rpcUrl)
  if (probe.kind !== "down") {
    throw new Error(`port ${port} is already answered (${probe.kind === "surfpool" ? `Surfpool ${probe.version}` : probe.detail}); ` +
      "this check starts its own fork there and will not reuse another process's state. Stop that process (by its pid) or wait for the other run to finish.")
  }
  // Surfpool's --network mainnet default resolves to api.mainnet-beta.solana.com. Its lazy
  // account fetches intermittently fail while verifying fresh SAS admissions. Use the same
  // mainnet genesis endpoint as the operator fork, while allowing an explicit override.
  const fork = await startOrReuseSurfpool({ rpcUrl, readyTimeoutMs: 90_000,
    datasourceRpcUrl: process.env.SURFPOOL_DATASOURCE_RPC_URL ?? "https://api.mainnet.solana.com" })
  if (fork.reused || fork.pid === null) throw new Error(`surfpool on ${rpcUrl} was not started by this check`)
  return fork
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method} failed on ${rpcUrl}: ${body.error.message}`)
  return body.result as T
}

/** The fork's Clock sysvar unix_timestamp (seconds): what the program's now() sees. */
export async function chainNow(rpcUrl: string): Promise<number> {
  const result = await rpc<{ value: { data: { parsed: { info: { unixTimestamp: number } } } } }>(rpcUrl, "getAccountInfo", [
    "SysvarC1ock11111111111111111111111111111111", { encoding: "jsonParsed", commitment: "confirmed" },
  ])
  return result.value.data.parsed.info.unixTimestamp
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Jump the fork's clock to `unixSeconds` (surfnet_timeTravel takes milliseconds) and wait until the Clock sysvar shows it. */
export async function timeTravelTo(rpcUrl: string, unixSeconds: number): Promise<number> {
  await rpc(rpcUrl, "surfnet_timeTravel", [{ absoluteTimestamp: unixSeconds * 1000 }])
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const now = await chainNow(rpcUrl)
    if (now >= unixSeconds) return now
    await sleep(200)
  }
  throw new Error(`surfnet_timeTravel to ${unixSeconds} did not reach the Clock sysvar within 15 s`)
}

/** Wait for the next slot, so a program deployed in this slot becomes invocable. */
export async function nextSlots(rpcUrl: string, count = 2): Promise<void> {
  const start = await rpc<number>(rpcUrl, "getSlot", [{ commitment: "confirmed" }])
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if ((await rpc<number>(rpcUrl, "getSlot", [{ commitment: "confirmed" }])) >= start + count) return
    await sleep(150)
  }
  throw new Error("the fork did not advance slots within 15 s")
}

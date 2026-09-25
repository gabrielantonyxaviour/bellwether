/**
 * Wires a CredentialConfig into a running service: chain, credential backend (SAS or
 * membership), SDN screening, the log, and the HTTP server.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { createAdmissions, type Admissions } from "./admission.js"
import { createApp } from "./app.js"
import { createDevnetFunder } from "./funding.js"
import type { CredentialBackend } from "./backend.js"
import type { CredentialConfig } from "./config.js"
import { LABEL } from "./labels.js"
import { membershipBackend } from "./membership.js"
import { createCredentialChain } from "./retry.js"
import { sasBackend, sasIdentity } from "./sas.js"
import { ScreeningLog } from "./screening-log.js"
import { createScreening } from "./screening.js"
import { loadFixture } from "./sdn.js"

export async function createService(config: CredentialConfig): Promise<Admissions> {
  const chain = createCredentialChain(config.rpcUrl)
  let backend: CredentialBackend
  if (config.gate.kind === "sas") {
    const identity = await sasIdentity(config.issuer.address)
    backend = sasBackend({
      chain, issuer: config.issuer, payer: config.payer, identity,
      onSetup: ({ credential, schema, signature }) => {
        // Per-cluster record of the issuer's SAS addresses (runtime, gitignored).
        const file = join(config.dataDir, `issuer-${config.cluster}.json`)
        if (!signature && existsSync(file)) return
        mkdirSync(config.dataDir, { recursive: true })
        writeFileSync(file, JSON.stringify({
          label: LABEL, cluster: config.cluster, issuer: identity.issuer, credential, schema,
          setupSignature: signature, recordedAt: new Date().toISOString(),
        }, null, 2) + "\n")
      },
    })
  } else {
    backend = membershipBackend({ chain, issuer: config.issuer, programId: config.gate.programId, venue: config.gate.venue })
  }
  const screening = createScreening({
    cachePath: config.sdnCachePath, url: config.sdnUrl, maxAgeMs: config.sdnMaxAgeMs,
    fixture: config.fixturePath ? loadFixture(config.fixturePath) : [],
  })
  const log = new ScreeningLog(config.logPath)
  return createAdmissions({
    cluster: config.cluster, chain, payer: config.payer, freezeAuthority: config.freezeAuthority, stockMint: config.stockMint,
    backend, screening, log, ttlSeconds: config.ttlSeconds, dailyCap: config.dailyCap,
    funder: config.funding ? createDevnetFunder({ chain, payer: config.payer, log, ...config.funding }) : undefined,
  })
}

export interface RunningService {
  url: string
  admissions: Admissions
  close(): Promise<void>
}

export async function startServer(config: CredentialConfig): Promise<RunningService> {
  const admissions = await createService(config)
  const app = createApp(admissions, { operatorToken: config.operatorToken, corsOrigin: config.corsOrigin })
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info: AddressInfo) => resolve({ server, port: info.port }))
    server.once("error", reject)
  })
  return {
    url: `http://${config.host}:${port}`,
    admissions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

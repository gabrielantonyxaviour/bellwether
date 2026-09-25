/**
 * Credential issuer — test admission, not KYC.
 *   CREDENTIAL_ISSUER_KEYPAIR=… CREDENTIAL_FREEZE_AUTHORITY_KEYPAIR=… npx tsx services/credential/server.ts
 * Environment contract: services/credential/config.ts.
 */
import { errorText } from "../../scripts/assets/tx.js"
import { loadConfig } from "./config.js"
import { LABEL } from "./labels.js"
import { startServer } from "./service.js"

async function main() {
  const config = await loadConfig()
  const running = await startServer(config)
  const info = running.admissions.info()
  process.stdout.write(`credential issuer (${LABEL}) on ${running.url} — ${config.cluster}, gate ${info.gate}, ${JSON.stringify(info.credential)}\n`)
  running.admissions.ready().then(
    () => process.stdout.write(`ready: SDN list ${JSON.stringify(running.admissions.info().sdn)}\n`),
    (error) => process.stderr.write(`not ready yet (admission will retry on demand): ${errorText(error)}\n`),
  )
  const stop = () => { void running.close().finally(() => process.exit(0)) }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

main().catch((error) => {
  process.stderr.write(`credential issuer failed to start: ${errorText(error)}\n`)
  process.exit(1)
})

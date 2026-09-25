/** Generate and load persistent user LaunchAgents for devnet services and the tunnel. */
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
const home = homedir()
const logs = join(home, "Library/Logs/bellwether")
const agents = join(home, "Library/LaunchAgents")
const tunnelId = "769abdb9-4142-41bf-88dc-984429694e9f"
const tunnelConfig = join(home, ".config/bellwether/tunnel.yml")
const uid = process.getuid?.()
if (uid === undefined) throw new Error("user LaunchAgents require macOS user uid")
mkdirSync(logs, { recursive: true, mode: 0o700 })
mkdirSync(agents, { recursive: true })
mkdirSync(join(home, ".config/bellwether"), { recursive: true, mode: 0o700 })

writeFileSync(tunnelConfig, `tunnel: ${tunnelId}\ncredentials-file: ${home}/.cloudflared/${tunnelId}.json\ningress:\n  - hostname: bellwether-api.larinova.com\n    path: ^/(health|admit(?:/.*)?|credential(?:/.*)?)$\n    service: http://127.0.0.1:8790\n  - hostname: bellwether-api.larinova.com\n    service: http://127.0.0.1:8787\n  - service: http_status:404\n`, { mode: 0o600 })
chmodSync(tunnelConfig, 0o600)
execFileSync("/opt/homebrew/bin/cloudflared", ["--config", tunnelConfig, "tunnel", "ingress", "validate"], { stdio: "inherit" })

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
async function plist(label: string, args: string[]) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escape(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${escape(root)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${logs}/${label}.out.log</string>\n<key>StandardErrorPath</key><string>${logs}/${label}.err.log</string>\n</dict></plist>\n`
  const file = join(agents, `${label}.plist`)
  writeFileSync(file, xml, { mode: 0o600 })
  const service = `gui/${uid}/${label}`
  try { execFileSync("launchctl", ["bootout", service], { stdio: "ignore" }) } catch { /* absent */ }
  let loaded = false
  for (const delay of [0, 300, 1_000, 2_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, file], { stdio: "ignore" })
      loaded = true
      break
    } catch { /* launchd may still be removing the prior job */ }
  }
  if (!loaded) throw new Error(`launchctl could not bootstrap ${label} from ${file}`)
  execFileSync("launchctl", ["enable", service], { stdio: "inherit" })
  process.stdout.write(`${label}: ${file}\n`)
}

await plist("com.bellwether.devnet", [process.execPath, resolve(root, "scripts/deploy/run-devnet.mjs")])
await plist("com.bellwether.tunnel", ["/opt/homebrew/bin/cloudflared", "--config", tunnelConfig, "tunnel", "run", "bellwether-devnet"])

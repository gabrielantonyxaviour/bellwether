#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node - <<'NODE'
const fs = require('node:fs')
const source = JSON.parse(fs.readFileSync('scripts/deploy/deployments/devnet.web.json', 'utf8'))
source.apiBaseUrl = 'https://bellwether-api.larinova.com'
source.credentialApiUrl = source.apiBaseUrl
source.rpcUrl = 'https://api.devnet.solana.com'
source.wsUrl = 'wss://api.devnet.solana.com'
fs.writeFileSync('web/public/config.json', JSON.stringify(source, null, 2) + '\n')
NODE
printf '/* /index.html 200\n' > web/public/_redirects
pnpm -C web build
wrangler pages deploy web/dist --project-name bellwether --branch v1.0.0

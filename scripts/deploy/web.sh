#!/usr/bin/env bash
set -euo pipefail
source_repo="$(cd "$(dirname "$0")/../.." && pwd)"
revision="$(git -C "$source_repo" rev-parse HEAD)"
checkout="$(mktemp -d "${TMPDIR:-/tmp}/bellwether-pages.XXXXXX")"
cleanup() { git -C "$source_repo" worktree remove --force "$checkout" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$source_repo" worktree add --detach "$checkout" "$revision"
cd "$checkout"
node - <<'NODE'
const fs = require('node:fs')
const source = JSON.parse(fs.readFileSync('scripts/deploy/deployments/devnet.web.json', 'utf8'))
source.apiBaseUrl = 'https://bellwether-api.larinova.com'
source.credentialApiUrl = source.apiBaseUrl
source.rpcUrl = 'https://bellwether-api.larinova.com/rpc'
source.wsUrl = 'wss://api.devnet.solana.com'
fs.writeFileSync('web/public/config.json', JSON.stringify(source, null, 2) + '\n')
NODE
printf '/* /index.html 200\n' > web/public/_redirects
pnpm -C web install --frozen-lockfile
pnpm -C web build
wrangler pages deploy web/dist --project-name bellwether --branch v1.0.0 --commit-hash "$revision"

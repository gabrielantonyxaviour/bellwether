# Bellwether deployment and local services

## Current target: devnet

The public devnet program, mints, venue, pool and transaction signatures are recorded in
[`deployments/devnet.json`](deployments/devnet.json). The browser's public cluster layer is
[`deployments/devnet.web.json`](deployments/devnet.web.json). The service environment is generated at
`services/.env.devnet` with mode 0600 and includes private key paths and a private operator token;
it is gitignored. Do not copy that file into the web app.

From the repository root:

```bash
solana balance CXMB67kJoMrYNKLyQNHc1nXMWW6DbubmxxSQZ7UfsgZq -u devnet
npx tsx scripts/deploy/go-live.ts --cluster devnet
npx tsx scripts/deploy/start-services.ts --cluster devnet
# In another terminal, after the services report ready:
npx tsx scripts/deploy/smoke.ts --cluster devnet
```

`go-live` checks the devnet genesis hash, requires at least 1 SOL before the initial run, and
resumes completed steps from the journal. It generates role keypairs under
`~/.config/solana/bellwether/devnet/` with mode 0600. `smoke` calls the credential HTTP API to
admit its trader, swaps on chain, and waits for that signature on `GET /tape`. A repeated smoke
reads the saved signature from the API rather than making another trade. The tested services are
the relay, caps job, indexer, API and credential issuer. The relay polls Nasdaq Trader no faster
than once per minute; its explicit NYSE current-halts fallback is enabled when Nasdaq returns a
bot challenge. `GET /halts` reports which live source supplied the latest heartbeat.

To point a local web build at this venue, copy `deployments/devnet.web.json` to
`web/public/config.json`, then serve the web app. The JSON contains only public addresses and
local API URLs. It does not publish the app or the services.

## Public devnet for judging

- Web: <https://bellwether.larinova.com> (Cloudflare Pages project `bellwether`).
- The web's human-readable public tape is at
  <https://bellwether.larinova.com/explorer?date=2026-09-25>; environment proof is at
  <https://bellwether.larinova.com/about>. The dated link contains the finalized fresh-wallet swap.
- API and admission: <https://bellwether-api.larinova.com>. `/health` and `/admit/*` reach the
  credential service; `/tape`, `/venue`, `/halts` and other public reads reach the venue API.
- Browser devnet RPC: <https://bellwether-api.larinova.com/rpc>, a bounded gateway to the
  devnet RPC with retry and short read coalescing. Browser chain reads poll over HTTP; no
  WebSocket connection is required. The browser's public configuration is
  [`web/public/config.json`](../../web/public/config.json). No private key or operator token is
  included in the Pages build.

The requested `api.bellwether.larinova.com` hostname needs a certificate for a two-level
subdomain. Cloudflare's existing certificate covers `*.larinova.com`, and its certificate API
returned code 1450 when asked to issue an advanced certificate. The covered
`bellwether-api.larinova.com` hostname is the verified HTTPS endpoint.

On the hosting Mac, from the repository root, install the two user LaunchAgents:

```bash
node node_modules/tsx/dist/cli.mjs scripts/deploy/install-launchagents.ts
launchctl print gui/$(id -u)/com.bellwether.devnet
launchctl print gui/$(id -u)/com.bellwether.tunnel
cat ~/Library/Logs/bellwether/devnet-pids.json
```

`com.bellwether.devnet` starts a direct Node supervisor; each service runs with the real
`node node_modules/tsx/dist/cli.mjs` entry, and caps runs daily at 07:30 UTC. The supervisor
records its own PID and child PIDs in `devnet-pids.json`; launchd keeps it alive. It also holds
an AC-power sleep assertion for its own lifetime. Keep the Mac plugged in, awake and online with
its lid open. `com.bellwether.tunnel` keeps the named `bellwether-devnet` Cloudflare tunnel
connected. Their stdout and stderr are in `~/Library/Logs/bellwether/`; the tunnel credentials
and private service env stay outside the web build. Stop or restart a job by its exact launchd
label with `launchctl bootout` / `bootstrap` or `kickstart`, never by a process-name pattern.
The relay key `B4AdoASP9LrHH9A9HRuF6tUhWqDwNAojhn74rXZtZ5gU` had 0.14967 devnet SOL
after the finalized [`relayRunwayTopUp`](deployments/devnet.json) transfer on 25 September 2026;
check its balance and `/halts` each day while judging is open. The Mac and internet connection
must remain available for the tunnel and signing services to serve traffic.

To redeploy the current web after screen commits, run:

```bash
bash scripts/deploy/web.sh
```

The script writes public devnet `config.json`, the SPA fallback `_redirects`, builds `web/`, and
deploys its output to the `bellwether` Pages production branch. The deployment does not change
the local signing services.

Devnet signed admission issues an SAS credential, thaws the test stock account, and funds a new
wallet up to 0.01 devnet SOL and 1 test USDC. The service caps funding at 20 wallets per UTC day
and records funded wallets durably; repeat admission does not refill a wallet. This test funding
is available only on devnet. To repeat the public proof using the saved private smoke wallet:

```bash
node node_modules/tsx/dist/cli.mjs scripts/deploy/public-smoke.ts
curl -fsS 'https://bellwether-api.larinova.com/tape?date=2026-09-25'
```

The public smoke uses a signed admission challenge, confirms funding balances, signs a real
devnet swap and waits for its print on the public tape. Its admission, funding and swap
signatures are in [`devnet.json`](deployments/devnet.json); the fresh-wallet swap is
`4fuqTEufSL9pWn5ohaShKyVCvMTt5eieDdXNwo3yjnd3tv1WtxeN8aJfP6Hw9vkzDXx6Ub6C1EKdEmyiJb6eiUBW`
and finalized on devnet. The smoke wallet key remains under `~/.config/solana/bellwether/devnet/`.

## Local mainnet fork

```bash
npx tsx checks/fork-scenario.ts
npx tsx scripts/fork/start.ts --port 8899 --services
# For an isolated screen test, choose free RPC and WebSocket ports:
npx tsx scripts/fork/start.ts --port 8980 --services
BELLWETHER_FORK_PORT=8980 BELLWETHER_FORK_RPC_URL=http://127.0.0.1:8980 npx tsx scripts/deploy/smoke.ts --cluster fork
```

The start command owns and stops only its Surfpool process. It refuses an occupied port. On
custom port 8980, the API and credential API use 8982 and 8983; the browser config is
`deployments/fork-8980.web.json`. Fork RPC is bound to 127.0.0.1 because Surfpool cheatcodes
have no authentication. The scenario uses the real FWDI mainnet mint and labels its fork-only
transfer-agent thaw stand-in in the signature record at `scripts/fork/out/fork-scenario.json`.

## Mainnet pitch path

No mainnet transaction has been sent. When Gabriel names mainnet as the target, first run the
read-only plan:

```bash
npx tsx scripts/deploy/go-live.ts --cluster mainnet --confirm-mainnet
```

The script requires `--execute` as a separate flag before any mainnet transaction. Review the
program, venue, mint, quote asset, account rent, temporary role funding, available SOL, and real
USDC seed before using it. Current mainnet rent reads for the 31,173-byte ProgramData allocation
and 36-byte Program account are 159,009,080 and 833,120 lamports respectively; the 641-byte
rehearsal mint is 3,906,520 lamports. The CLI deployment also needs a temporary buffer account,
whose rent is recovered after deployment. These are account rents and temporary funding, not
transaction fees. The full mainnet peak and smoke remain unmeasured until the mainnet target is
authorized; do not treat the devnet receipt as mainnet proof.

The mainnet plan prints a conservative working-balance floor: two program-data rents (one is
the temporary buffer), Program account and stock-mint rent, 180,000,000 lamports moved to role
accounts, and a 50,000,000-lamport reserve for the remaining accounts and fees. It refuses
`--execute` below that floor. The exact eventual burn and reclaimable balances require a
mainnet execution and closeout, so they are not quoted from a fork.

On a fresh 8985 mainnet fork, the full go-live setup took **63.146 seconds** from the start of
the program step through liquidity. Measured step intervals included program deploy 12.624 s,
four role top-ups 16.268 s total, mint 1.217 s, SAS 0.452 s, venue/symbol/vault/pool/activation
11.657 s, LP admission 8.194 s, heartbeat 4.010 s, live cap 4.724 s, USDC funding 0.085 s,
stock minting 3.288 s, and liquidity 0.627 s. The raw intervals are retained in the local
`deployments/fork-8985.json` journal.

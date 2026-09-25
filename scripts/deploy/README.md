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

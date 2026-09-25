# Bellwether

Bellwether is a Solana venue-program prototype and operator workbench for the SEC's [Tokenized Securities Venue Innovation Exemption (Release 34-106402)](https://www.sec.gov/files/rules/exorders/2026/34-106402.pdf). It demonstrates permissioned rehearsal-stock swaps, exchange-halt and stale-feed stops, share budgets, listing clocks, and a public trade tape.

**Public source:** <https://github.com/gabrielantonyxaviour/bellwether> (`main`, filtered to exclude `docs/film/` and third-party media).

**Status:** Cloudflare Pages serves the devnet app at <https://bellwether.larinova.com>; the API and test-admission service use <https://bellwether-api.larinova.com>. A browser wallet signed admission, received devnet fee SOL and test USDC, swapped BWRS, and saw its finalized print on the [public explorer](https://bellwether.larinova.com/explorer?date=2026-09-25) and [API tape](https://bellwether-api.larinova.com/tape?date=2026-09-25). Browser checks also confirmed LP deposit and full withdrawal. Abel's harness marks 12/12 screens and 5/5 systems proven; the six cross-screen journeys have no Abel scenario verdict yet. A local Surfpool mainnet fork exercised the program against the real FWDI mint. Mainnet trading has not been deployed. Bellwether is not an operating securities venue.

## Quick start

To inspect the public devnet build, open the [home page](https://bellwether.larinova.com), [dated trade explorer](https://bellwether.larinova.com/explorer?date=2026-09-25), [environment details](https://bellwether.larinova.com/about), or [API health](https://bellwether-api.larinova.com/health). The app includes three public, three participant, and six operator screens. The demo film still needs a public upload.

From a clone with Node.js ≥22, pnpm, Rust/Solana SBF tools and Surfpool installed:

```bash
npm install
pnpm -C web install
npm run typecheck
npx tsx checks/fork-scenario.ts
```

The fork scenario binds Surfpool to localhost, forks mainnet state, tests FWDI and time-dependent rules, and writes local proof to `scripts/fork/out/fork-scenario.json`. It needs a working mainnet RPC and may require locally configured Solana tooling. See [deployment and local services](scripts/deploy/README.md) for the full fork, devnet and service commands. Do not run the mainnet execution command as part of this quick start.

## How it works

```mermaid
flowchart LR
  Participant[Participant wallet] --> Web[React participant app]
  Operator[Operator wallet] --> Workbench[Operator workbench]
  Web --> Program[Solana venue program]
  Workbench --> Program
  Credential[Credential issuer / SAS] --> Program
  Halt[Nasdaq halt feed → relay] --> Program
  Caps[Volume and tier job] --> Program
  Program --> Events[Trade events]
  Events --> Indexer[Indexer / API]
  Indexer --> Tape[Public tape and proof pages]
  Workbench --> API[Notice and FWDI readers]
  API --> Indexer
```

The program's swap path checks credential → halt and heartbeat freshness → activation and pause → share budget → price and slippage → transfers → event. It rejects direct program calls that fail those checks. The halt relay records its source and latency; a stale heartbeat blocks swaps. LP positions are non-transferable, and proportional withdrawal remains possible during a halt. See the [program contract](docs/program-contract.md) for accounts, instructions and error codes.

## Environments and proof

| Environment | Asset and proof | Limit |
| --- | --- | --- |
| Devnet | BWRS rehearsal token and **test USDC**. Program `88chqe41hw9uhqrUK6KfytQ7aZgEGJzcqszXGKJFWfuB`; [finalized fresh-wallet swap](https://solscan.io/tx/4fuqTEufSL9pWn5ohaShKyVCvMTt5eieDdXNwo3yjnd3tv1WtxeN8aJfP6Hw9vkzDXx6Ub6C1EKdEmyiJb6eiUBW?cluster=devnet) appeared on the [public explorer](https://bellwether.larinova.com/explorer?date=2026-09-25). Full signatures: [`devnet.json`](scripts/deploy/deployments/devnet.json). | Test assets and test admission. |
| Local mainnet fork | Real FWDI mint; local fork scenario checked an FWDI swap, issuer-notice window and second-breach pause. | Fork-only cheatcodes thawed and funded FWDI accounts; local signatures are not public mainnet proof. |
| Mainnet | **[PROGRAM ID AND VERIFIED TRANSACTIONS AFTER DEPLOYMENT]** | No mainnet execution is claimed here. |

FWDI is used for read-only issuer and authority rehearsal. The fork's account thaw stands in for action by FWDI's transfer agent. BWRS does not represent FWDI equity. Admission is a test credential and does not complete KYC or legal participant eligibility checks.

The admission issuer screens the connected wallet against the OFAC SDN digital-currency address list and issues a Solana Attestation Service credential after a signed challenge. The onboarding evidence panel shows the SDN source and freshness, credential and schema, wallet attestation, admission transaction, stock-account thaw, and expiry. Those are inspectable test controls; a real venue needs its own eligibility process and ongoing obligations.

## Run the local app against devnet

First complete the devnet setup in the [deployment guide](scripts/deploy/README.md), including its generated public `devnet.web.json` and local service environment. Then start the services and web app:

```bash
npx tsx scripts/deploy/start-services.ts --cluster devnet
pnpm -C web dev
```

Copy `scripts/deploy/deployments/devnet.web.json` to `web/public/config.json` before opening the app locally. That file contains public addresses and local API URLs; it does not start the services. See [web configuration](web/README.md) for cluster overrides and wallet behavior. The hosted build uses the public API domain and devnet RPC; complete the browser journey before recording it as product proof.

## Source layout

| Path | Purpose |
| --- | --- |
| `programs/venue` | Rust/Pinocchio pool program |
| `services/relay`, `services/caps` | Halt and share-budget inputs |
| `services/credential` | Test admission and credential issuance |
| `services/indexer`, `services/api` | Public tape and venue data |
| `services/notice`, `services/rehearsal` | Notice draft and FWDI authority rehearsal |
| `scripts/fork`, `scripts/deploy`, `checks` | Fork, deployment, smoke and acceptance checks |
| `web` | Participant, operator and public web surfaces |

## Legal and operational limits

The [SEC order](https://www.sec.gov/files/rules/exorders/2026/34-106402.pdf) places obligations on the actual US venue operator, including public and issuer notices, participant controls, records, and limits across affiliated venues. This software cannot make its developer or user a qualifying TSV, supply legal rights to a token, or replace counsel's review. The share cap in this prototype is a conservative per-trade-date stop; the order's comparison is based on average daily share volume. The relay polls about once a minute, so a halt is not guaranteed to be simultaneous with the listing exchange.

## License

The [published repository](https://github.com/gabrielantonyxaviour/bellwether) includes a root [MIT License](https://github.com/gabrielantonyxaviour/bellwether/blob/main/LICENSE). Third-party dependencies retain their own licenses.

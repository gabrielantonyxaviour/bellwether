# Stocklana portal answers — draft, not submitted

Use the text between the `BEGIN` and `END` markers for each character-limited field. Counts are for the enclosed text, including Markdown punctuation and line breaks, excluding the markers. Recount after any edit.

## Step 1 — project details

**Project Name:** Bellwether

**Short Description** — count: **234** / 280 characters

<!-- SHORT BEGIN -->
Bellwether is a Solana pool program and operator workbench for permissioned tokenized-stock trading. Its swap path checks admission, exchange halts, data freshness, share caps, and listing status; a public tape makes trades auditable.
<!-- SHORT END -->

**Full Description** — count: **3,929** / 5,000 characters

<!-- FULL BEGIN -->
## The problem

The SEC's [Tokenized Securities Venue Innovation Exemption](https://www.sec.gov/files/rules/exorders/2026/34-106402.pdf) creates a conditional path for a US operator to run permissioned pools for tokenized US-listed stocks. The operator must control access, stop trading when the primary listing exchange stops, manage share-volume and symbol limits, publish transaction data, and make advance public disclosures. A wallet gate in a web app cannot enforce a pool's rules against direct program calls.

## What Bellwether does

Bellwether pairs a Solana AMM program with an operator workbench, a participant trading app, and a public tape. The program holds the trading rules in its own swap path. An operator can inspect symbol budgets, halt-feed health, issuer-notice timing, contract authorities, and a rehearsal of the real Forward Industries (FWDI) token. The tape records trades from program events. Abel's harness marks all 12 screens and all 5 systems proven; its six cross-screen journeys still await formal scenario verdicts.

## How a swap is checked

The program checks the wallet's credential, the symbol's halt state and relay heartbeat, listing activation or pause, and the remaining share budget before pricing and transferring assets. A rejected swap returns a program error such as `NotAdmitted`, `TradingHalted`, `HaltDataStale`, `NoticeWindowOpen`, or `CapReached`. Successful swaps update the on-chain counter and emit a tape event. The share budget is a conservative per-trade-date hard stop; the order's legal comparison uses average daily share volume. A relay polls the primary-market halt source about once a minute and publishes its measured delay. A stale heartbeat fails closed.

## Why Solana

The venue needs a public, auditable program with atomic checks at settlement. Solana's Token-2022 frozen-account controls and Solana Attestation Service support the rehearsal asset and wallet credentials. A Surfpool mainnet fork lets us test the same program against the real FWDI mint and time-travel through a 30-day issuer window and later breach pause.

## Where it runs and what is real

**Public devnet:** the web app runs at [bellwether.larinova.com](https://bellwether.larinova.com), with public, participant and operator screens; the API and test-admission service are at [bellwether-api.larinova.com](https://bellwether-api.larinova.com). A browser wallet signed admission, received devnet fee SOL and test USDC, swapped the labelled Bellwether rehearsal stock (BWRS), and the finalized transaction appeared on the [public explorer](https://bellwether.larinova.com/explorer?date=2026-09-25) and [API tape](https://bellwether-api.larinova.com/tape?date=2026-09-25). Browser checks also confirmed LP deposit and withdrawal. Admission checks the wallet against the OFAC SDN digital-currency address list and issues a Solana Attestation Service (SAS) credential; the app shows list freshness, the attestation, admission transaction and token-account thaw. This is test admission, not KYC. **Local mainnet fork:** the program passed tests against the real FWDI mint; fork cheatcodes stood in for its transfer agent's thaw and token funding. These are devnet and local-fork proofs, not mainnet trading.

**Mainnet pitch proof — [ADD ONLY AFTER DEPLOYMENT]:** program ID, BWRS/USDC pool, transaction signatures, public tape URL, and measured halt latency. Remove this paragraph if mainnet is not deployed and verified.

Bellwether is a prototype, **not an operating or registered securities venue**. BWRS is a rehearsal token, not a claim on FWDI shares. Test admission screens a wallet and issues a credential; it is **not KYC** or an operator's full eligibility process. The halt path is minute-scale and cannot promise instantaneous synchronization. A real US operator must independently satisfy the order's legal, issuer, notice, records and participant obligations before operating.
<!-- FULL END -->

## Steps 2–5 — confirm labels and limits in portal

Only Step 1's fields have been observed. Map these values to the actual fields before submission; do not infer that the portal accepted them.

| Likely field | Draft answer / required check |
| --- | --- |
| Track | Stocklana **main track only**. No sponsor tracks. Confirm portal selector. |
| Tech stack | Rust + Pinocchio venue program; Token-2022 and Solana Attestation Service; TypeScript relay, caps job, credential issuer, indexer and API; React + Vite web app; Surfpool mainnet fork. The web is deployed on Cloudflare Pages; signing services run on a Mac through a named Cloudflare tunnel. |
| GitHub | <https://github.com/gabrielantonyxaviour/bellwether> — approved target; verify public access and secrets audit before adding. |
| Live app | <https://bellwether.larinova.com> — public, participant and operator routes on devnet. API and admission: <https://bellwether-api.larinova.com>. [Dated explorer](https://bellwether.larinova.com/explorer?date=2026-09-25) and [API tape](https://bellwether-api.larinova.com/tape?date=2026-09-25) show finalized swaps. |
| Demo video | **[ADD PUBLIC VIDEO URL AFTER UPLOAD]**; ≤3:00, Gabriel's voice. |
| Team | Gabriel Antony Xaviour; confirm account name and any invited teammates in the portal. |
| Sponsor tracks | None. |
| Program and proof | Devnet program `88chqe41hw9uhqrUK6KfytQ7aZgEGJzcqszXGKJFWfuB`; fresh-wallet signed admission, funding and finalized swap `4fuqTEufSL9pWn5ohaShKyVCvMTt5eieDdXNwo3yjnd3tv1WtxeN8aJfP6Hw9vkzDXx6Ub6C1EKdEmyiJb6eiUBW` on the [public explorer](https://bellwether.larinova.com/explorer?date=2026-09-25) and [API tape](https://bellwether-api.larinova.com/tape?date=2026-09-25). Full signatures in [`devnet.json`](../../scripts/deploy/deployments/devnet.json). |

The [official Stocklana page](https://hackathons.solana.com/hackathons/stocklana) says at least one GitHub, live-demo or video link is required and edits are allowed until close. Check the live portal before relying on its deadline or field layout.

# Stocklana portal answers — draft, not submitted

Use the text between the `BEGIN` and `END` markers for each character-limited field. Counts are for the enclosed text, including Markdown punctuation and line breaks, excluding the markers. Recount after any edit.

## Step 1 — project details

**Project Name:** Bellwether

**Short Description** — count: **234** / 280 characters

<!-- SHORT BEGIN -->
Bellwether is a Solana pool program and operator workbench for permissioned tokenized-stock trading. Its swap path checks admission, exchange halts, data freshness, share caps, and listing status; a public tape makes trades auditable.
<!-- SHORT END -->

**Full Description** — count: **3,125** / 5,000 characters

<!-- FULL BEGIN -->
## The problem

The SEC's [Tokenized Securities Venue Innovation Exemption](https://www.sec.gov/files/rules/exorders/2026/34-106402.pdf) creates a conditional path for a US operator to run permissioned pools for tokenized US-listed stocks. The operator must control access, stop trading when the primary listing exchange stops, manage share-volume and symbol limits, publish transaction data, and make advance public disclosures. A wallet gate in a web app cannot enforce a pool's rules against direct program calls.

## What Bellwether does

Bellwether pairs a Solana AMM program with an operator workbench, a participant trading app, and a public tape. The program holds the trading rules in its own swap path. An operator can inspect symbol budgets, halt-feed health, issuer-notice timing, contract authorities, and a rehearsal of the real Forward Industries (FWDI) token. The tape records trades from program events.

## How a swap is checked

The program checks the wallet's credential, the symbol's halt state and relay heartbeat, listing activation or pause, and the remaining share budget before pricing and transferring assets. A rejected swap returns a program error such as `NotAdmitted`, `TradingHalted`, `HaltDataStale`, `NoticeWindowOpen`, or `CapReached`. Successful swaps update the on-chain counter and emit a tape event. The share budget is a conservative per-trade-date hard stop; the order's legal comparison uses average daily share volume. A relay polls the primary-market halt source about once a minute and publishes its measured delay. A stale heartbeat fails closed.

## Why Solana

The venue needs a public, auditable program with atomic checks at settlement. Solana's Token-2022 frozen-account controls and Solana Attestation Service support the rehearsal asset and wallet credentials. A Surfpool mainnet fork lets us test the same program against the real FWDI mint and time-travel through a 30-day issuer window and later breach pause.

## Where it runs and what is real

**Devnet:** the program, a clearly labelled Bellwether rehearsal stock (BWRS), test USDC, credential issuer, relay, API, indexer and tape completed an end-to-end admitted swap. The transaction finalized and appeared in the API tape. **Local mainnet fork:** the program passed tests against the real FWDI mint; fork cheatcodes stood in for its transfer agent's thaw and token funding. These are local and devnet proofs, not mainnet trading.

**Mainnet pitch proof — [ADD ONLY AFTER DEPLOYMENT]:** program ID, BWRS/USDC pool, transaction signatures, public tape URL, and measured halt latency. Remove this paragraph if mainnet is not deployed and verified.

Bellwether is a prototype, **not an operating or registered securities venue**. BWRS is a rehearsal token, not a claim on FWDI shares. Test admission screens a wallet and issues a credential; it is **not KYC** or an operator's full eligibility process. The halt path is minute-scale and cannot promise instantaneous synchronization. A real US operator must independently satisfy the order's legal, issuer, notice, records and participant obligations before operating.
<!-- FULL END -->

## Steps 2–5 — confirm labels and limits in portal

Only Step 1's fields have been observed. Map these values to the actual fields before submission; do not infer that the portal accepted them.

| Likely field | Draft answer / required check |
| --- | --- |
| Track | Stocklana **main track only**. No sponsor tracks. Confirm portal selector. |
| Tech stack | Rust + Pinocchio venue program; Token-2022 and Solana Attestation Service; TypeScript relay, caps job, credential issuer, indexer and API; React + Vite web app; Surfpool mainnet fork. Cloudflare Pages/Workers is the approved hosting target, not a verified deployment. |
| GitHub | <https://github.com/gabrielantonyxaviour/bellwether> — approved target; verify public access and secrets audit before adding. |
| Live app | <https://bellwether.larinova.com> — approved target; verify working public routes and chain/API connection before adding. |
| Demo video | **[ADD PUBLIC VIDEO URL AFTER UPLOAD]**; ≤3:00, Gabriel's voice. |
| Team | Gabriel Antony Xaviour; confirm account name and any invited teammates in the portal. |
| Sponsor tracks | None. |
| Program and proof | Devnet program `88chqe41hw9uhqrUK6KfytQ7aZgEGJzcqszXGKJFWfuB`; devnet swap `3opPyjqKMpd5ubVimz33BX2xH87gWUcXdW6X6wpsSb3NCopRiu7oU5UNkkocoZVmnmqyupPSwpVZ3yTtvYUtCC7P`. Add links only where the portal asks, after verifying they resolve. |

The [official Stocklana page](https://hackathons.solana.com/hackathons/stocklana) says at least one GitHub, live-demo or video link is required and edits are allowed until close. Check the live portal before relying on its deadline or field layout.

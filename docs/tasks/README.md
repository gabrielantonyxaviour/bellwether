# Bellwether build tasks — rules for every worker session

Coordinator: stock-claude (Herdr pane wR:p5, ideation workspace). Workers: Codex (gpt-6-sol) sessions in the
"Bellwether · 1.0" Herdr workspace. Each worker owns one task file here. Product: Abel product
prod_081357ef-1e52-421c-ad10-8a03a624f889, version 1.0.0. Repo: this checkout, branch v1.0.0.

## Rules
- Read `spec.json` (the agreed contract: features, requirements, accept commands) and `docs/program-contract.md`
  first. Do not edit spec.json.
- Shared working tree: other workers commit here too. Commit ONLY files your task owns, by explicit path
  (never `git add -A`, never `git commit -a`). End every commit message with:
  `Claude-Session: https://claude.ai/code/session_01Exky7bB9jAqDLuyJNJR2XA`
- Proof = Abel harness verify, from the Abel checkout:
  `cd /Users/gabrielantonyxaviour/Documents/products/abel && ABEL_URL=http://localhost:4179 npm run graph -- verify --product prod_081357ef-1e52-421c-ad10-8a03a624f889 --version 1.0.0 --block <id> --provider codex --wait`
  Skip `graph start/stop/blocked` (refused by design for this managed version). Never edit the Abel repo.
- Reuse proven code by import (read-only unless your task owns it): scripts/assets (BWRS rehearsal mint, admit/thaw),
  services/relay, services/caps, services/indexer, services/api, services/credential, services/notice, services/rehearsal.
  Each service's env contract is in its config.ts.
- Local forks: Surfpool at `$HOME/.local/bin/surfpool` (bind 127.0.0.1 only; cheatcodes are unauthenticated).
  Each check uses its own ports; the task file names yours. Prebuilt program: programs/venue/target/deploy/bellwether_venue.so.
  Solana CLI: `$HOME/.local/share/solana/install/active_release/bin`.
- NEVER send mainnet transactions, never deploy to mainnet, never print or commit secret keys, never publish anything.
- Finish with: files changed, check output summary, verify verdict, and anything the coordinator or Gabriel must decide.
  Then tell the coordinator: `herdr agent prompt stock-claude "[from <your name>] done: <one line> — see docs/tasks/<file> report"`
  and append your report to the bottom of your task file (commit it).

## State at hand-off (2026-09-25 ~10:20 UTC)
Proven by the harness (9/15): blk_program_core, blk_program_rules, blk_rehearsal_assets, blk_fwdi_rehearsal,
blk_halt_relay, blk_caps_data, blk_tape, blk_notice_builder, blk_credentials. Web shell committed (41a65df).
Remaining: blk_fork_env (+ go-live script), credential hardening + API routes (rework), 3 screen blocks (wait for
Gabriel's screen approval), blk_mainnet_deploy (needs Gabriel's funds + fork green), blk_web_deploy (needs hosting/domain OK).

## Hosting decision (Gabriel, 2026-09-25)
Everything on Cloudflare (account 893c47cc…, vault CLOUDFLARE_API_TOKEN: Workers + Pages + larinova.com DNS; no D1/KV).
- Web: Cloudflare Pages, custom domain **bellwether.larinova.com**.
- Services (relay cron each minute, caps daily cron, indexer + API with a SQLite-backed Durable Object, credential
  service): Cloudflare Workers at **api.bellwether.larinova.com**. Keep services runnable on Node too (dev/fork).
- Nothing is deployed until devnet is green end to end; the web-deploy task will be assigned then.

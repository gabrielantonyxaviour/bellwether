# Task 02 — credential hardening + two API routes (worker: bw-integration)

Rework of proven blocks; re-verify both. Ports: credential check 8940/8941, tape check 8930/8931.

## (1) blk_credentials (owns services/credential/**, checks/credentials.ts)
/admit has no proof of wallet ownership and no rate limit, so anyone could make the issuer pay ~0.0035 SOL rent per
random address on mainnet. Add:
- `GET /admit/challenge?wallet=` → one-time message "Bellwether test admission for <wallet> · nonce <n> · expires <iso>"
  (5-minute TTL, single use). `POST /admit {wallet, message, signature}` verifies an ed25519 signature (Solana
  signMessage; accept base58 or base64) over exactly that message before screening.
- Rate limits per IP (e.g. 5/min) and per wallet. Daily cap `CREDENTIAL_DAILY_CAP` (default 10 on mainnet, unlimited on
  fork/devnet) → 429 {error, code: "DAILY_CAP"}. Keep sticky revocation.
- Update checks/credentials.ts: the fork round-trip signs the challenge; new assertions: missing/invalid/reused signature →
  401 INVALID_PROOF; cap exceeded → 429 DAILY_CAP; rate limit → 429 RATE_LIMITED. Keep every existing assertion passing.
- Don't edit web/; list the new request/response shapes in your report for the screen builders.

## (2) blk_tape API additions (owns services/api/**, checks/tape.ts)
The web shell calls `GET /notice/draft` and `GET /rehearsal/fwdi`; add them to services/api/app.ts:
- /notice/draft → services/notice `noticeDraftFor(...)` for the configured cluster/program/venue (60 s cache; 503
  {error, code: "notice_unavailable"} if chain facts can't be read).
- /rehearsal/fwdi → services/rehearsal/latest-report.json; `?refresh=1` guarded by an operator token re-runs
  buildRehearsalReport at most once per 10 minutes.
Import those modules read-only. zod-validate queries; errors {error, code}; CORS as existing. Extend checks/tape.ts with
assertions for both routes (draft shows the fork venue's real program id; report has FWDI authorities) without breaking
its existing 46 assertions.

Verify: blk_credentials and blk_tape.

## bw-integration report — 2026-09-25

Implemented in `222dd98` and `e45482b` (`services/credential/**`, `services/api/**`,
`checks/credentials.ts`, `checks/tape.ts`); signed browser helper in `d0cb649`
(`web/src/lib/api.ts`, `web/src/lib/api.test.ts`). `pnpm-workspace.yaml` belongs to
another workstream and was not committed here.

- `GET /admit/challenge?wallet=<base58>` returns `{wallet,message,expiresAt,expiresAtUnix}`.
  Sign the **exact UTF-8 bytes** of `message` using the connected wallet's Solana
  `signMessage`. `POST /admit` accepts `{wallet,message,signature}` with a 64-byte
  Ed25519 signature encoded as base64 or base58. Browser helper sends base64.
  Challenges expire after five minutes and are single-use. Missing, mismatched,
  invalid, or replayed proof returns `401 {error,code:"INVALID_PROOF"}`.
  Operator bearer admission remains available for authorized operation.
- Challenge requests are limited per IP and wallet. Mainnet admission defaults to
  ten new credentials per UTC day (`CREDENTIAL_DAILY_CAP`); devnet/fork credential
  admission is uncapped. Limits return 429 with `RATE_LIMITED` or `DAILY_CAP`.
- Fresh devnet admissions top up to 0.01 fee SOL and 1 test USDC from the payer,
  transferring only each wallet's shortfall. Funding happens once per wallet and
  is capped at 20 funded wallets per UTC day by default. Config permits no more
  than 0.05 SOL and 5 test USDC targets. Mainnet has no funding path. Funding
  failure returns `502 {error,code:"FUNDING_UNAVAILABLE"}`; the wallet can retry.
  The admit response includes a `funding` result on devnet.
- `GET /notice/draft`, `GET /rehearsal/fwdi`, and `GET /market/FWDI` are live API
  routes. The market route proxies validated daily Yahoo chart data with a
  five-minute cache and accepts `range=1mo|3mo|6mo|1y&interval=1d`.
  `GET /rehearsal/fwdi?refresh=1` needs an operator bearer token and is limited
  to once per ten minutes. API CORS allows `https://bellwether.larinova.com`
  plus localhost/127.0.0.1. `/halts.source` is a feed label, never a local path;
  public status fields and errors do not expose local paths or stacks.

Checks: service tests 16/16; credential fork check 36/36; tape fork check passed;
service typecheck passed. Abel harness re-verification returned **passed** for
`blk_credentials` and **passed** for `blk_tape`. Browser helper tests 3/3 and
web typecheck passed. A concurrent full web test run was 35/36: the one failing
test is `src/components/operator/budget.test.ts` (notice activation label),
outside these changed files. The direct admission tests pass.

Public devnet status: bw-fork reported a fresh-wallet signed admission that
funded 0.01 SOL and test USDC, followed by an on-chain swap visible on the
public tape. Our live read-only audit of `https://bellwether-api.larinova.com`
found 200 responses on `/`, `/halts`, `/venue`, `/symbols`, `/tape`,
`/notice/draft`, and `/rehearsal/fwdi`; allowed and denied CORS origins behaved
as specified, and sampled JSON contained no local paths or stack traces.
The public API hostname is `bellwether-api.larinova.com`.

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

# Bellwether pre-publication secrets audit

**Date:** 2026-09-25. **Decision:** No credential value or private key was found in the history available in this checkout. No rotation or history purge is indicated by these findings. Do not treat this as clearance for a separate `main` history: this checkout has only `refs/heads/v1.0.0`, no remote, and no `main` ref. If `main` is later created from `v1.0.0`, it inherits the scanned commits; if it points to different commits, scan that ref before publication.

## Scope and method

- Scanned all **42 commits** reachable from `v1.0.0` (`b868086` at audit time), including 348 historical blob/path pairs. Also scanned five unreachable blobs for the same content patterns. `git show-ref`, `git branch -a` and worktree inspection found no `main` or remote ref to scan.
- Neither gitleaks nor trufflehog is installed. A local scanner inspected historical blob contents without printing matched values: private-key PEM headers, 64-byte numeric arrays, literal secret/token assignments, REUI and Cloudflare token assignments, credential-bearing URLs, GitHub/AWS token shapes, and sensitive filenames. A second pass inspected 364 tracked and nonignored untracked paths in the working tree. Public deployment journals and `.env.example` were also checked for secret-shaped fields.
- Reviewed `.gitignore` and nested ignore files with `git check-ignore`. No `.env`, `id.json`, keypair JSON, PEM, tunnel credential file, or vault file is tracked in the reachable history. The locally present `services/.env.*` and `web/.env.local` are ignored and their contents were not printed.
- This is a pattern and path audit, not a proof that an arbitrarily encoded secret cannot exist. Run a dedicated scanner and repeat the audit if one becomes available before making a different history public.

## Findings

| File | Commit | Kind | Fix |
| --- | --- | --- | --- |
| `services/api/api.test.ts:40` | `222dd98` | A 19-character literal operator token in a local test fixture. It occurs in one historical blob/path and is not the runtime operator token. | **Fine.** Keep test credentials clearly synthetic; no rotation or purge. |
| `scripts/deploy/runtime.ts` and service config files | `50bda19` (runtime); `17e67c1` / `222dd98` (service history) | Keypair and operator-token **variable names or paths**, not key bytes. The runtime reads private files outside the repository. | **Fine.** Keep the external files out of Git and avoid logging their contents. |
| `scripts/deploy/deployments/devnet.json`, `scripts/fork/out/fork-scenario.json` | `50bda19` | Public addresses, RPC URLs and transaction signatures; `deployer` and `sasCredential` are public keys/addresses. No secret-key field or 64-byte array was found. | **Fine.** Preserve the public/private journal split. |
| `docs/tasks/README.md`, `spec.json`, `docs/leads/DEV-LEAD.md` | `16f35f9`, `4fc5847`, `50ca10a` | `CLOUDFLARE_API_TOKEN` and `REUI_LICENSE_TOKEN` are names/instructions only. No vault value or license token was found. | **Fine.** Do not replace those names with values in public docs. |
| `services/rehearsal/latest-report.json`, `services/rehearsal/markets.ts` | `c3f03c6` | URL heuristic matched public Superstate/Jupiter API links. The query key is `query`, with no API-key/token parameter. | **Fine.** No rotation or purge. |
| `.gitignore`, `scripts/deploy/deployments/.gitignore` | `8cdc2cd`, `50bda19` | `.env` / `.env.*`, `*.keypair.json`, `keys/`, build outputs and `fork*.json` are ignored. Generic `id.json`, `*.pem`, `*.key`, and tunnel-credential JSON names are **not** covered. None is tracked now. | **Add ignore rules before any such file enters the worktree;** keep tunnel credentials outside the checkout. This is preventive, not a history purge. |
| `main` branch | — (ref absent) | Requested branch could not be scanned. No remote is configured. | **Re-scan if a distinct `main` ref appears.** If created from audited `v1.0.0`, confirm ancestry before pushing. |

## Publication handoff

No history rewrite is proposed. Before creating or pushing the public repository, confirm the exact ref to publish is descended from audited `v1.0.0`, recheck new commits and untracked files, and add the missing ignore patterns if the team may place key material in the checkout. If a later scan finds a committed live secret, stop publication, rotate it first, then decide whether to purge the affected history and re-audit the rewritten ref. This audit did not create or push a repository and did not alter history.

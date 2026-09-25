# Stocklana submission checklist

Draft checklist. A checked box needs a saved URL, command output, or on-screen confirmation; a plan or local pass does not satisfy a public gate. The official page says the deadline is **2026-09-25 20:00 UTC** in the saved research; confirm the live portal's current deadline before submission. Gabriel makes the final Submit click.

## Product proof

- [x] Devnet venue program, BWRS and test USDC seeded; admitted swap finalized and appeared on `/tape`. See [`devnet.json`](../../scripts/deploy/deployments/devnet.json) and [example transaction](https://solscan.io/tx/3opPyjqKMpd5ubVimz33BX2xH87gWUcXdW6X6wpsSb3NCopRiu7oU5UNkkocoZVmnmqyupPSwpVZ3yTtvYUtCC7P?cluster=devnet).
- [x] Local mainnet-fork scenario checked real FWDI mint, 30-day issuer window and second-breach pause. Fork-only thaw/funding are labelled as stand-ins.
- [x] Public devnet service proof: a fresh wallet signed admission, received fee SOL and test USDC, swapped in a finalized transaction, and the same signature appeared on the [HTTPS API tape](https://bellwether-api.larinova.com/tape?date=2026-09-25). See [`devnet.json`](../../scripts/deploy/deployments/devnet.json). The [web explorer](https://bellwether.larinova.com/explorer?date=2026-09-25) is checked separately below.
- [x] Devnet browser evidence: wallet signed challenge, OFAC SDN screen and SAS credential, funded admission, signed buy, finalized print on the public tape, LP deposit and full withdrawal. The onboarding panel links list freshness, attestation, admission transaction and thaw. See [`docs/tasks/03-participant-screens.md`](../tasks/03-participant-screens.md) and [`docs/tasks/08-journeys.md`](../tasks/08-journeys.md). Admission is a test control, not KYC.
- [x] Abel Circuit shows **12/12 screens and 5/5 systems proven**, plus the public web block. The six cross-screen journeys remain **0/6 proven** by its scenario harness; see the [journey report](../tasks/08-journeys.md) for observed partial checks.
- [x] Screen blocks checked at 375, 768 and 1440 px; participant live fixes and public route checks are recorded in the task reports.
- [ ] Record the final demo takes from the live devnet and labelled local fork; verify visible signatures, error codes, audio and timing.

## Publication gates

- [ ] Complete the final secrets audit on the exact HEAD intended for GitHub, including all history and nonignored worktree paths. The prior [audit](../tasks/07-secrets-audit.md) and publication-prep rescan found no live secret; repeat the scan if commits or media change before pushing.
- [ ] Add a root MIT `LICENSE` if that is the intended license; verify the public README reflects the actual terms.
- [ ] Make <https://github.com/gabrielantonyxaviour/bellwether> public after the audit; open it without a signed-in session and check source, README and relevant proof links.
- [x] Deploy Cloudflare Pages at <https://bellwether.larinova.com> and the named tunnel at <https://bellwether-api.larinova.com>; verify HTTPS, public devnet `config.json`, [API health](https://bellwether-api.larinova.com/health) and `/tape` read-back. The deployed web serves `/`, `/explorer`, `/about` and `/app/*` on devnet; the dated explorer shows the finalized fresh-wallet swap. See `checks/public-url.ts` and commit `007800a`.
- [x] Verify the deployed browser wallet's admission, swap, tape, LP deposit and withdrawal against public devnet services; operator screen block passed its isolated fork harness. The six formal Circuit journeys remain pending.
- [ ] Upload the ≤3:00 video with Gabriel's voice. Open the public video URL anonymously; check audio, labels and end card.

## Mainnet pitch gate

- [ ] Only after every app and demo flow is validated end to end on devnet, review the mainnet cost plan, funding, quote asset and target with Gabriel. Mainnet execution is separate authorization.
- [ ] If mainnet is deployed, verify program ID, BWRS/real-USDC pool, transaction and tape read-back on public mainnet, then replace every **mainnet placeholder** in the pack. If it is not deployed, keep all copy and film labelled devnet/fork and remove mainnet trading claims.

## Portal review — confirm Steps 2–5 live

- [ ] Confirm Step 1 character limits and paste the counted fields from [`portal-answers.md`](portal-answers.md); recount in the portal.
- [ ] Select **Stocklana main track only**; no sponsor tracks. Confirm the portal's actual track controls.
- [ ] Add only resolved GitHub, live app and video links; confirm the portal requires at least one and verify every one as a judge would see it.
- [ ] Confirm team name and invite choices with Gabriel; do not infer teammates from source files.
- [ ] Check actual Steps 2–5 for extra required fields, rights/eligibility attestations and final preview. Correct the draft rather than guessing.
- [ ] Check deadline and editing rules on the live portal; save a local copy of the final entered answers.
- [ ] Gabriel reviews the preview and performs the final **Submit** click. Save the portal receipt/URL and verify the submission is visible afterward.

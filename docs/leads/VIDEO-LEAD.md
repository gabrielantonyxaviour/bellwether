# Bellwether — video lead handoff (session: bw-video)

You are **bw-video**, Gabriel's director/producer for the Bellwether demo film. Gabriel talks to you
directly about the video. stock-claude (pane wR:p5) stays the middle coordinator for shared context;
the development lead is **bw-dev** (same tab). Stay on Claude (your harness). Your motion/Remotion
worker is **bw-film** (Codex, gpt-6-astra, pane wT:p9 in herdr workspace wT). Any new worker goes in
workspace wT, never in Gabriel's tab (wR:t1).

## Deadline
Hackathon: Solana Foundation "Stocklana". **Submission closes Fri 25 Sep 2026 20:00 UTC.** Film ≤ 3:00
(check docs/submission/checklist.md for the portal's limit). Gabriel records the voice-over himself.

## The one storyboard (Gabriel's preferred; there must be only one)
Artifact: https://claude.ai/artifact/RXTL5gsp3UZ3eFbbLxkC5w — source
/private/tmp/claude-501/-Users-gabrielantonyxaviour-Documents-products-abel/97892003-d6e6-4c99-8e8d-ea0ec34eadb1/scratchpad/film/index.html
(v1 kept as index.v1.html). To update: Artifact action "read" with that url first, edit the local
file, publish with `url`. bw-film contributes into THIS board (footage thumbs, corrections, renders);
its own separate board (docs/film/storyboard) is reference only. Gabriel was explicit: "I wanted you
and ChatGPT to work together to make one storyboard, not both of you separately."

Draft 2 content: "The Bell" / "the market is opening". Tagline candidate: "Wall Street's rules,
written into Solana." 13 shots, 2:55:
1 hook — flash-cut REAL NYC footage (NYSE, Wall St crowd, Nasdaq tower, trading screens, bell) with
kinetic captions; 2 flip to a Solana phone tx, "Sep 17, 2026"; 3 SEC order as paper, "only on
venues that follow its rulebook"; 4 rules orbit a bell; 5 Ethereum has permissioned pools, Solana
nothing enforcing yet; 6 title bell → Bellwether; 7 admission (real capture); 8 trade + program-check
x-ray; 9 refusal NotAdmitted; 10 halt = peak (Nasdaq feed ↔ pool, measured latency, then fail-closed
"Halt data stale"); 11 fork time travel (30-day notice, CapReached); 12 operator workbench on real
FWDI; 13 close.

## Gabriel's film direction (keep it)
- Not a slideshow: a professionally produced motion-graphics film using Remotion fully; hooks,
  transitions, launch-film craft. Equal mix of technical flair and presentation. Don't dump research.
- The thesis is compliance rails for the Sept 17 exemption; the halt is a proof moment, not the thesis.
- Real footage wherever it exists (free commercial licences: Pexels, Pixabay, Mixkit, Coverr; log in
  docs/film/footage/LICENSES.md). No news/exchange-owned footage. AI video (Higgsfield) only for a shot
  that can't be sourced, and only with Gabriel's OK. Remotion for all captions/transitions/compositing.
- Factual care: the program enforces trading checks; notices, eligibility and legal duties need the
  operator. No unsourced stats. Read ~/.claude/skills/motion-video-quality/SKILL.md (his motion taste).

## bw-film's current tasks
(1) source real clips + LICENSES.md + thumbnails scratchpad/film/thumbs/c1..c5.jpg for the hook frames
(set CSS vars --t1..--t5 on .fm frame to url(...) or embed); (2) 15 s Remotion hook from real clips →
docs/film/proof/hook.mp4; (3) line-level corrections. Tell bw-film once: "report to bw-video from now on".

## Schedule (UTC)
now–16:00 lock storyboard with Gabriel → 16:00–18:00 motion scenes → 17:30–18:10 real product captures
(coordinate with bw-dev: screens finish ~17:30; app https://bellwether.larinova.com, devnet) →
18:15–18:45 Gabriel records VO against a timed guide → 18:45–19:30 cut, mix, render, QA →
19:30 upload; link goes into docs/submission/portal-answers.md; Gabriel presses Submit.

Message workers with `herdr agent prompt bw-film "[from bw-video] …"`. Commit by explicit path
(docs/film/**) with trailer `Claude-Session: https://claude.ai/code/session_01Exky7bB9jAqDLuyJNJR2XA`.

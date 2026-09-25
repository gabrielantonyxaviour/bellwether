<!-- abel-development:start -->
## Abel product development

This product is built through Abel on its Circuit: one board per version of screens, the wires
each screen calls, systems, the foundation, and the journeys across them. Before product work,
read .abel/project.json and run `bash .abel/graph check-project`.

The flow: /abel:idea or /abel:adopt, then /abel:spec, /abel:preflight and /abel:plan, which writes
the Circuit with its UX board, build graph and scenarios. /abel:run is the one build loop. It builds
the foundation and systems at once, approved screens with their wires once Gabriel says go, and
proves each journey before a test card reaches his inbox. It never waits on a card.
/abel:revise then /abel:sync change the idea and spec. /abel:revise-ux, /abel:revise-graph and
/abel:revise-scenarios correct the plan while ids stay put. A change to something already built is
rework, recorded with circuit decide.

Read the board and the inbox with `bash .abel/graph circuit show|inbox <productId> <version>`.
Record what Gabriel says with `bash .abel/graph circuit decide <productId> <version> <file>`, his
exact words as source.message, and print the read-back. Only his own words or clicks mark
anything done. He directs taste: scope, the look, screen directions and how the flow feels. You own
architecture, stack, blocks, wiring and tests; never put those questions in his inbox.

Screens are built with ReUI components for working, clean UX and no look. Look, landing and film
are separate tracks; the look reaches product screens only through /abel:apply-look, on his
handoff.

Track the actual session on a block with `bash .abel/graph start --block <id> --provider
<claude|codex|grok> --env <environmentId>` (with known --model and --effort), `blocked --block
<id> --why <reason>` for a wall, and `stop --block <id>` after the work. Proven is the harness's
word: ask for it with `bash .abel/graph verify --product <id> --version <v> --block <id> --provider
<harness> --wait`. Never invent proof, spend or approval. Do not use `bash .abel/graph spec --file
<specPath>` to plan: it registers live checks before /abel:plan.

Adopting existing code: rediscover intent through questions, inventory what exists as evidence
apart from the intended product, and account for every page: retain, revise, merge, split or
retire. Preserve working code, data, tests and history; a retirement never deletes a route on its
own.

At handoff, report the block, the changed scope, what the harness proved and the Circuit link.
<!-- abel-development:end -->

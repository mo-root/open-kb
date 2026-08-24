# Overnight hardening backlog — night 3 (2026-08-22)

Working branch: `hardening/overnight-2026-08-21` (unchanged — nights 1 and 2 are
already on it, plus two commits from the evening session of 2026-08-22).
Base: `main` @ a7bbc57. Current head at hand-off: `d740379`.

Nights 1 and 2 closed 8 fixed items and 9 self-discovered ones. This list comes
from the 2026-08-22 evening analysis of where a REAL USER's time and quality
actually go — the owner's stated priority is now "the actual pipeline when the
users try it themselves", NOT the demo gallery.

## Rules for every iteration

Unchanged from nights 1 and 2 — they are in the routine prompt verbatim. The
short form: one item per fire, top of the list first, read fully before
changing, `pnpm check && pnpm test` must both pass, commit on this branch only,
never `main`, never force-push, **no live or paid runs ever** (the cloud
environment holds no Bright Data or OpenRouter credentials and must not try to
acquire any), and every commit message ends `Backlog item: <id>`.

---

## The finding that sets tonight's order

Measured on `runs/sweep-cursor-com-20260821105321.json` (28.5 min, $0.71):

| phase | wall time | share |
|---|---|---|
| search + widening | 7.5 min | 26% |
| classify | 7.2 min | 25% |
| second-look + drop-confirm | 1.5 min | 5% |
| **link + orphan** | **12.3 min** | **43%** |

And separately: **every stage built on nights 1-2 is off by default**, in both
the CLI and the web route. A user who clones the repo and runs
`pnpm sweep their.com` gets none of triage, second-look, drop-confirm or
listicle-harvest. The web route does not pass a single one of them either.

---

## P0 — the user's first run

- [ ] **P0-1. Flip the three proven stages on by default, CLI and web.**
  The codebase's own doctrine (see `SweepOptions.triage`, `.secondLook`,
  `.listicleHarvest` doc comments) is "a flag, not a migration — the case has to
  survive an A/B on the same anchor before this defaults on." Those A/Bs are now
  run and recorded:
    - **listicle-harvest** — found Windsurf on cursor.com (a rival with zero
      direct SERP hits across 66 queries) and 18 real pump vendors on
      grundfos.com. One model call, ~4s, ~$0.0003. Clear win.
    - **second-look** — rescued 12 of 23 and 13 of 22 unplaced hosts across two
      runs, ~$0.005.
    - **triage** — skipped 123 of 926 hosts on the cursor run, saving those
      fetches and classify calls; roughly time-neutral, saves ~$0.02.
    - **drop-confirm** — rescued 0 of 12, 0 of 27, and 5 of 29 across three
      runs. **Leave this one opt-in**; it rarely changes anything.
  Change the DEFAULT to on for the three, keeping each flag able to turn it OFF
  (`OPENKB_TRIAGE=0` must still work, so read the env as "0"/"false" disables
  rather than "1" enables). Then make `packages/web/app/api/map/route.ts` pass
  the same three, so the hosted "Try the beta" path and a local clone are the
  same product. Update `.env.example` and the README's stage table to say which
  are on by default. Tests: assert the default-on behaviour and that the
  disable-flag still works, in the existing fixture suite.

- [ ] **P0-2. Link phase: chunked dispatch → continuous pool.** The single
  biggest time win available. `packages/sweep/src/sweep.ts` dispatches BOTH the
  pair batches (~line 5174) and the orphan batches (~line 5305) as
  `for (i += LINK_CONC) { await Promise.all(slice) }` — a barrier per group, so
  each group costs its slowest member and finished workers idle. This is the
  exact anti-pattern the SEARCH phase already fixed and documented in this same
  file (search for "A pool instead. Each worker takes the next query the moment
  it frees up" around line 2806 — read that comment and its measured numbers
  before you start). Convert both link sites to the same continuous-pool shape.
  Do not change concurrency, batch size, or what is asked — only the dispatch.
  Verify with the existing link tests; add one that proves a slow batch does not
  block the others if you can do it deterministically with the fixture.

- [ ] **P0-3. `LINK_CONC` → env var, default 16.** It is a hardcoded `const
  LINK_CONC = 8` (~line 5060), unlike `RANK_CONC` which reads
  `OPENKB_RANK_CONCURRENCY`. Give it `OPENKB_LINK_CONCURRENCY` with the same
  guard shape as its sibling, and raise the default to 16. Comment it with the
  measured phase share (43% of wall time) as the reason.

- [ ] **P0-4. A shorter deadline for link and orphan calls.** `CALL_TIMEOUT_MS`
  is a global 120s (~line 407). On the measured run TWO timed-out link batches
  cost about 4 minutes of a 12.3-minute phase. The link and orphan calls are
  batched, uniform and retried once already, so they can carry a tighter
  deadline than a one-off classify. Add an override (a constant, or an
  `opts.maxOutputTokens`-style per-call parameter on `call()` — read how the
  existing per-call deadline is composed in `withDeadline` first) of ~45-60s for
  the `link` agent only, leaving every other agent on 120s. Keep the existing
  single retry.

## P1 — quality gaps measured the same evening

- [ ] **P1-5. Edge `why` is still discovery, not mechanism, on 53% of edges.**
  Night 1's P0-2 only half-landed: 1,593 of 2,983 edges on the cursor run still
  read "a page on X names Y", which proves the two were mentioned together and
  says nothing about how they relate. Read `prompts/agents/link.md`, the free
  measured pass and the paid inferred pass end to end, establish precisely which
  path still emits the discovery sentence, and give that path a real one-line
  mechanism where the page supports one — staying honest (a naming-only page
  genuinely supports nothing more, and must keep saying so rather than inventing
  a mechanism). Measure the before/after share of discovery-shaped `why` over a
  stored run and put both numbers in the commit message.

- [ ] **P1-6. The `reasoning` field fires on only 26% of entities** (202 of 776
  on the cursor run). It is `.optional()` in the classify schema — deliberately,
  because every pre-existing fixture answers without it and a required field
  would fail their zod parse before the engine saw a response (the reason is
  written at the schema). Find a way to raise the fill rate without breaking
  those fixtures: strengthening the prompt's ask is the safe first move; a
  required field with fixtures updated is the thorough one. Report the fill rate
  you achieve against a fixture run.

- [ ] **P1-7. A fast first-run mode.** A user's first experience is currently a
  ~28-minute wait before they see anything. Add a `--quick` flag to
  `scripts/sweep.ts` (argv, not an env var — it is a human-facing convenience)
  that composes the existing options into a bounded run: a smaller
  `maxHosts`, `skipModelLinking: true`, and whatever else the existing option
  surface already supports. Invent NO new engine capability — this is purely a
  preset over `SweepOptions` that already exist. Print one line at start saying
  what it traded away and how to run the full thing. Document it in the README's
  command block.

- [x] **P1-8. Free-settle is effectively off: 2 hosts of 926 settled by
  predicate.** `KERNEL_THRESHOLD = opts.aggregatorThreshold ?? null` (~line
  3877) ships null because `scripts/calibrate-kernel.ts` found no separation
  between vendor and directory front pages on the sample it had. Every other
  host pays a model call. Re-run that calibration reasoning over the runs now on
  disk (there are 17 sweeps, several far larger than when it was last tried) and
  report honestly whether a defensible threshold now exists. If it does, propose
  it with the measurement; **if it does not, say so and mark this BLOCKED** —
  **BLOCKED (2026-08-22 overnight fire).** Neither precondition this item names
  holds in the container a scheduled fire actually runs in: `runs/` is
  gitignored and this is a fresh clone from `origin/hardening/overnight-2026-08-21`
  with no `runs/*.json` on disk at all (checked — the directory doesn't exist),
  so "the 17 sweeps... on disk" from the evening analysis are not reachable
  from here and never will be, since nothing in this branch's history writes
  real sweep output back into git. Separately, `calibrate-kernel.ts` fetches
  every candidate host's live front page directly (`fetch(https://${host}/)`)
  to measure outbound-link counts — that's a live network call to arbitrary
  third-party sites, which is exactly the class of thing this loop is
  forbidden from doing ("no live or paid runs, ever... offline fixture tests
  only"), even though it costs no API credits. Both blockers are structural to
  this environment, not fixable by picking a different run or writing a
  fixture: a fixture front-page HTML sample would not be "the runs now on
  disk" the item asks for, and synthesizing one would be exactly the
  "arithmetic dressed as evidence" this item itself warns against shipping.
  Leaving `KERNEL_THRESHOLD` at `null` (unchanged) until someone runs
  `calibrate-kernel.ts` with real `runs/` data outside this sandboxed loop.
  shipping a guessed threshold would be arithmetic dressed as evidence, which is
  precisely what the current `null` is avoiding.

## Self-discovered work

Only once every item above is done or BLOCKED. Same rules as night 2: pick ONE
area not yet touched, find ONE concrete safe improvement, verify it, commit it
tagged `Backlog item: SELF-<n>` continuing the existing numbering. Night 2's
nine self-discovered commits are the model for scope — small, real, tested.

**Explicitly NOT in scope:** the demo gallery (the owner has deprioritised it);
retiring the swarm package; streaming classify (invasive, spec-only, and the
spec item from night 1 was never reached); anything touching `main`; any live or
paid API call.

---

# Night 4 additions (2026-08-23) — web and GitHub polish

The owner's ask: "find and make all the changes in the web and the github as
well… make this ready and polished" for sharing tomorrow. Engine items A1-A8
above stay first; these follow.

## B. Web app — the judgements are invisible

- [x] **B1. `reasoning` is surfaced NOWHERE in the UI.** It is the one-sentence
  "why this call was made" on every classified entity, and 26% of entities
  carry one. Surface it on the entity detail card
  (`packages/web/components/kb/NoteView.tsx` and/or the GraphCanvas detail
  panel) — read how `what`/`why`/`spans` already render and follow that shape.
  Optional on the type, so absent renders as nothing, never an empty row.

- [x] **B2. `relationSpan` and `relationGrounded` are surfaced NOWHERE.**
  `relationSpan` is the verbatim quote backing the RELATION, as `spans` backs
  the description; `relationGrounded` records whether it verified as a literal
  substring (85% present, 83% of those verified on the cursor run). Surface the
  quote as a receipt on the relation and mark ungrounded ones honestly rather
  than hiding them — receipts-on-everything is the whole pitch.

- [x] **B3. Confirm `adjacent` is handled everywhere the UI enumerates
  relations** — colours, legend, glyphs, filters, sort orders, group labels. It
  has a blurb (`viewTypes.ts:39`) and a weight (`kb-from-run.ts:98`) but may be
  missing elsewhere. On a modern map it is the largest single relation, so an
  unhandled case is very visible.
  DONE (2026-08-23 overnight fire). Audited every spot the web app enumerates
  relations. The graph canvas's own legend/colour system (`GraphLegend`,
  `TYPE_CSS`) is keyed on `NodeType`, not `relation`, so it was never in
  scope — confirmed by reading `GraphCanvas.tsx` end to end. Two real gaps
  found and fixed, both in `KbOverview.tsx`'s "Who's in this market" panel and
  `ProductsTab.tsx`'s ecosystem grouping:
    - `RELATION_ORDER` / `RELATION_COLOR` (`KbOverview.tsx`) had no entry for
      `adjacent`. It still rendered (the `seen` catch-all after `RELATION_ORDER`
      and the `?? "var(--type-core, #9DB2D6)"` fallback both apply), but as the
      largest relation on a modern map it landed last in `ordered` — never one
      of the `ordered.slice(0, 3)` bars the panel glosses in words — wearing the
      generic muted fallback rather than a distinct hue. Added `adjacent` to
      `RELATION_ORDER` right after `substitute` (matching its rank in
      `RELATION_WEIGHT`: competitor 95, substitute 85, adjacent 78) and gave it
      `#B98CF2`, a lavender between the rival pink and the partner blue.
    - `ProductsTab.tsx`'s "The surrounding market" group blurb named
      "Dependencies, integrations, shapers, buyers and targets" — every relation
      that lands in that bucket (`!IS_RIVAL && relation !== "none"`) EXCEPT
      `adjacent`, its largest member. Reworded to lead with "Adjacent players".
  Also corrected a doc-comment in `FindingsPanel.tsx` (`EntityData.relation`)
  that listed the same relations minus `adjacent`.
  `pnpm check && pnpm test` both green, 1819 tests passing (12 gated/live
  skipped, same census as before).

- [x] **B4. Audit error and empty states end to end**: a failed run, a map with
  zero entities, a missing run id, a non-JSON fetch response, a one-node graph.
  Precedent: a prior fire found `KbOverview` swallowing a non-JSON error body
  as "unreachable".
  DONE (2026-08-23 overnight fire). Read `KbOverview.tsx` (non-JSON guard
  already present, every zero-count panel already has copy), `NoteView.tsx`,
  `BuildWorkflow.tsx` (`.json()` calls already `.catch(() => null)`-guarded),
  `lib/kb-lookup.ts`'s `findKb` (missing run id → 404; a failed run → its own
  404 pointing at `/api/run/[id]`) and `app/runs/[id]/page.tsx` (`notFound()`
  for a missing id, a dedicated `FailedReport` for a failed run) — all
  already solid, no gap. One real gap found: `GraphCanvas.tsx`'s `!graph`
  guard only catches a fetch failure. `graphOf` (`kb-from-run.ts:773`) always
  emits the anchor node (plus one per decomposed market) even when a run
  kept zero entities, so a zero-entity run still returns a truthy `graph` and
  fell through into the full force-directed canvas, toolbar and search box
  around a single dot reading "1 nodes · 0 links" — the one concrete
  "one-node graph" case the item names, and the only panel in the app
  without empty-state copy (`KbOverview.tsx`'s `CompositionPanel` /
  `EcosystemPanel` both have it). Added an early return in `GraphCanvas.tsx`
  for `graph.nodes.length <= 1`, same copy and styling as `KbOverview`'s
  "nothing on the map" panel. Backed by a new `kb-from-run.test.ts` fixture
  test measuring `graphOf(run([])).nodes` has length 1 (anchor only, no
  capabilities) — the shape the component now guards against; no
  jsdom/RTL harness exists in this repo to test `GraphCanvas.tsx` itself
  (confirmed — only pure-function/SSR tests), same limitation noted on B1-B3.
  `pnpm check && pnpm test` both green, 1820 tests passing (12 gated/live
  skipped, one more than B3's census for the new fixture test).

## C. GitHub — the repo a stranger lands on

- [ ] **C1. CONTRIBUTING.md** — none exists. Cover the pnpm workspace layout,
  `pnpm check && pnpm test` as the gate, prompts-as-markdown-without-rebuild,
  the core-purity rule enforced by `scripts/check-core-purity.mjs`, and that
  runs cost real money so tests are offline by design.

- [ ] **C2. SECURITY.md plus issue and PR templates** under `.github/`. The
  project takes API keys and fetches arbitrary web pages: say how to report a
  vulnerability and that keys live only in `.env`. Bug template should ask for
  the run artifact and anchor domain. Keep them short.

- [x] **C3. README badge row and repo metadata.**
  DONE (2026-08-23 overnight fire). No badge existed anywhere in the repo to
  correct or remove (checked with a repo-wide grep for "badge"/"shields.io"
  before starting) — this was a green-field add. `check.yml` has never run on
  GitHub (its own header comment says so, unchanged from when this item was
  written), so a CI status badge was left out entirely: shields.io would
  render it "unknown" at best, and the item's own instruction is "do NOT
  claim CI is green." Added two badges instead, both statically true and
  independent of any CI run: a License badge reading MIT (matches `LICENSE`
  and `package.json`'s `"license": "MIT"`) and a Node badge reading `>=20`
  (matches `package.json`'s `engines.node` and `check.yml`'s
  `node-version: 20`). Left an HTML comment in the README next to them
  explaining why no CI badge is there, so a future editor doesn't add one
  the day after a red run. For repo metadata, `package.json` had `license`
  and `repository` but no `homepage` or `bugs` — added
  `"homepage": "https://github.com/mo-root/open-kb#readme"` and
  `"bugs": {"url": "https://github.com/mo-root/open-kb/issues"}`, both
  standard npm fields pointing at the repo's actual GitHub location (verified
  against `git remote -v`). Did not touch the `packageManager`/`devEngines`
  gap `check.yml` calls out as "open queue item 12b" — that is a distinct,
  already-named item, not this one. `pnpm check && pnpm test` both green:
  1820 tests passed, 12 skipped (6 live/paid-gated, plus 3 duplicated in the
  skip census — same gated census as before, untouched by a docs/metadata
  change).

- [x] **C4. CHANGELOG.md / release notes** for what this branch changed since
  main. Read `git log a7bbc57..HEAD` for the real list rather than trusting any
  summary. Group by what a user would notice.
  DONE (2026-08-23 overnight fire). Added `CHANGELOG.md` at repo root, built
  from `git log a7bbc57..HEAD --reverse` (34 commits) and the full body of
  each — not from `docs/overnight-backlog.md`'s own summaries, which
  describe the intent behind a change more than its shipped shape. Grouped
  into four sections a user would actually recognize: pipeline defaults and
  performance (P0-1..P0-4, P1-7, the harvest/second-look/pacing/depth
  features), map quality (the placement-ladder feature and P1-5/P1-6),
  web app (B1-B4), and repo/docs (C1-C3). A closing "also in this range"
  paragraph rolls up the SELF-tagged correctness/test commits that have no
  independent user-facing story. Left `package.json`'s version at `0.1.0`
  and the changelog under an `[Unreleased]` heading — nothing in this range
  cut a release or bumped a version number, and it isn't this item's place
  to invent one. `pnpm check && pnpm test` both green: 1820 tests passing,
  12 skipped (gated/live), unchanged by a docs-only change.

## D. Deep architecture work

Only once A, B and C are done or BLOCKED. Areas nobody has swept: `core/src/
ledger.ts` and `spend-cap.ts`; `core/src/export-kb.ts` (the folder users
actually read); `scripts/*.ts` beyond sweep.ts; `web/lib/store/supabase.ts`;
the swarm orchestrator; doctrine contradictions; coverage gaps. Tag
`Backlog item: SELF-<n>`, continuing from wherever git log leaves off.

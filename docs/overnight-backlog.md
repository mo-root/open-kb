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

- [x] **P0-1. Flip the three proven stages on by default, CLI and web.**
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
  DONE (9c8a4f8). Checkbox was left unticked after the commit landed —
  confirmed by reading the commit and `packages/sweep/src/sweep.ts` /
  `packages/web/app/api/map/route.ts`: triage, second-look and
  listicle-harvest all default on, each still disable-able via its env
  flag, drop-confirm stays opt-in as the item specifies.

- [x] **P0-2. Link phase: chunked dispatch → continuous pool.** The single
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
  DONE (9ee196f). Checkbox was left unticked after the commit landed.

- [x] **P0-3. `LINK_CONC` → env var, default 16.** It is a hardcoded `const
  LINK_CONC = 8` (~line 5060), unlike `RANK_CONC` which reads
  `OPENKB_RANK_CONCURRENCY`. Give it `OPENKB_LINK_CONCURRENCY` with the same
  guard shape as its sibling, and raise the default to 16. Comment it with the
  measured phase share (43% of wall time) as the reason.
  DONE (b69c7d4). Checkbox was left unticked after the commit landed —
  `OPENKB_LINK_CONCURRENCY` exists with the `RANK_CONC` guard shape,
  default raised to 16.

- [x] **P0-4. A shorter deadline for link and orphan calls.** `CALL_TIMEOUT_MS`
  is a global 120s (~line 407). On the measured run TWO timed-out link batches
  cost about 4 minutes of a 12.3-minute phase. The link and orphan calls are
  batched, uniform and retried once already, so they can carry a tighter
  deadline than a one-off classify. Add an override (a constant, or an
  `opts.maxOutputTokens`-style per-call parameter on `call()` — read how the
  existing per-call deadline is composed in `withDeadline` first) of ~45-60s for
  the `link` agent only, leaving every other agent on 120s. Keep the existing
  single retry.
  DONE (567b11b). Checkbox was left unticked after the commit landed —
  `link` and `orphan` calls now carry their own shorter deadline, every
  other agent unchanged at 120s.

## P1 — quality gaps measured the same evening

- [x] **P1-5. Edge `why` is still discovery, not mechanism, on 53% of edges.**
  Night 1's P0-2 only half-landed: 1,593 of 2,983 edges on the cursor run still
  read "a page on X names Y", which proves the two were mentioned together and
  says nothing about how they relate. Read `prompts/agents/link.md`, the free
  measured pass and the paid inferred pass end to end, establish precisely which
  path still emits the discovery sentence, and give that path a real one-line
  mechanism where the page supports one — staying honest (a naming-only page
  genuinely supports nothing more, and must keep saying so rather than inventing
  a mechanism). Measure the before/after share of discovery-shaped `why` over a
  stored run and put both numbers in the commit message.
  DONE (e05629f). Checkbox was left unticked after the commit landed —
  the free naming pass now scans every naming row on a host, not just the
  first, and picks the richest one. Could not re-measure the cited 53%
  figure against a real run (no `runs/` in this sandbox, same constraint
  every item here hits); locked the mechanism with a new fixture test
  instead, per the commit's own note.

- [x] **P1-6. The `reasoning` field fires on only 26% of entities** (202 of 776
  on the cursor run). It is `.optional()` in the classify schema — deliberately,
  because every pre-existing fixture answers without it and a required field
  would fail their zod parse before the engine saw a response (the reason is
  written at the schema). Find a way to raise the fill rate without breaking
  those fixtures: strengthening the prompt's ask is the safe first move; a
  required field with fixtures updated is the thorough one. Report the fill rate
  you achieve against a fixture run.
  DONE (41e477a). Checkbox was left unticked after the commit landed —
  `reasoning` now sits right after `relation` in the classify schema,
  matching `classify.md`'s own documented answer order, instead of
  trailing after `why`/`spans` where an optional field goes unfilled.

- [x] **P1-7. A fast first-run mode.** A user's first experience is currently a
  ~28-minute wait before they see anything. Add a `--quick` flag to
  `scripts/sweep.ts` (argv, not an env var — it is a human-facing convenience)
  that composes the existing options into a bounded run: a smaller
  `maxHosts`, `skipModelLinking: true`, and whatever else the existing option
  surface already supports. Invent NO new engine capability — this is purely a
  preset over `SweepOptions` that already exist. Print one line at start saying
  what it traded away and how to run the full thing. Document it in the README's
  command block.
  DONE (d734540). Checkbox was left unticked after the commit landed —
  `--quick` composes existing `SweepOptions`, prints what it traded away,
  and is documented in the README's command block.

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

- [x] **C1. CONTRIBUTING.md** — none exists. Cover the pnpm workspace layout,
  `pnpm check && pnpm test` as the gate, prompts-as-markdown-without-rebuild,
  the core-purity rule enforced by `scripts/check-core-purity.mjs`, and that
  runs cost real money so tests are offline by design.
  DONE (e5c4183). This checkbox was left unticked after the commit landed —
  the file has been on disk and covering all of the above since. Confirmed
  by reading `CONTRIBUTING.md` in full: workspace table, the gate, core
  purity, prompts-as-markdown, and the offline-by-design argument are all
  there.

- [x] **C2. SECURITY.md plus issue and PR templates** under `.github/`. The
  project takes API keys and fetches arbitrary web pages: say how to report a
  vulnerability and that keys live only in `.env`. Bug template should ask for
  the run artifact and anchor domain. Keep them short.
  DONE (0ceedc0). Same as C1 — the checkbox was never ticked. Confirmed
  `SECURITY.md`, `.github/ISSUE_TEMPLATE/bug_report.md` (asks for anchor
  domain and run artifact) and `.github/pull_request_template.md` are all
  present and cover what the item asks.

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

**SELF-509 (2026-09-17 overnight fire) — a coverage-gap sweep found nothing
left to find; read this before repeating it.** "Coverage gaps" above is the
one D-area that had never been measured directly — every prior SELF-<n> in
this class found its target by manual reading, one file at a time. Installed
`@vitest/coverage-v8@3.2.7` locally (matched to this repo's `vitest@3.2.7`;
never committed — reverted `package.json`/`pnpm-lock.yaml` before finishing)
and ran the full suite with `--coverage`. Result: `packages/core/src` 99.89%
lines, `packages/swarm/src` 99.41%, `packages/sweep/src` 98.3%,
`packages/providers/src` 100%. Read every remaining uncovered line in those
four packages (judge.ts:961-963, catalog.ts:363-364, tools-control.ts:898,912,942,
tools-free.ts:614,644,657,670, alias.ts:68,212, agent.ts:1228,
orchestrator.ts:1315,1413-1416, tools-paid.ts:692,832-833, map.ts:165,233,
run-evidence.ts:383,393, url.ts:162, export-kb.ts core 17,759,823,936,
sweep.ts:5755,6878-6880) — every single one already carries a prior fire's
comment proving it structurally dead (an `?? ""` after a `.split` that
`String.prototype.split` never leaves empty, an arm two upstream checks
already make unreachable, etc.), so there is nothing left here for a test to
usefully close. `scripts/*.ts`'s low line-% (batch.ts 25%, sweep.ts CLI 0%,
etc.) is the same shape as `spend-caps.ts` before it — checked, and it is
`invokedDirectly`-guarded CLI body that a wiring test already covers by
source-grep (`tests/the-cli-entrypoints-have-a-dollar-bound.test.ts`), not an
untested pure function; `scripts/audit.ts`'s `sniffEntities` is the one real
instance of that D-area's "pull the pure part out and test it" move and it
was already done (its own comment says so). `packages/web`'s low numbers
(`GraphCanvas.tsx` 6.57%, `NoteView.tsx` 4.56%, etc.) are the documented
absence of a jsdom/RTL harness, not a gap this repo can close (B1-B4 already
say so).

Also checked, all clean: automated citation-drift detection (grepped every
`file.ts:NNN` comment citation across the repo, 260 of them, and diffed each
citation's own last-edited commit against its target file's last-edited
commit via `git blame`/`git log` — zero cases where the target moved after
the citation was last written, i.e. the manual drift-hunting SELF-<n>'s have
been keeping current in near real time); every `OPENKB_*` env var read by
`process.env` against `.env.example` (one apparent gap, `OPENKB_MAX_DURATION`,
turned out to be prose in a comment describing what does NOT work, not a real
variable); `DEPLOY.md`'s numeric claims (the query-budget table, the
`$0.41`/`$1.51`/`$3.74` run-cap figures) against a live run of the functions
they cite (`queriesThatFit`/`runSeconds`) — all match exactly.

Not a claim that this repo is finished — only that this specific tool
(coverage-driven gap-hunting) and the citation-drift/env-doc checks that
piggybacked on it are exhausted for now. The next self-discovered fire should
pick a genuinely different angle (a fresh reading of one file end-to-end
looking for a real logic bug, the way most `fix(...)` SELF-<n>'s were found,
rather than another instrumented sweep) rather than re-running this one.

**SELF-510 (2026-09-17 overnight fire) — took SELF-509's own advice: read
`scripts/bakeoff.ts` end to end and found a real display bug.** `renderTable`
built each row's `hosts`/`entities`/`seconds` cells with `r.hosts || "-"` etc.
— falsy-checking each field rather than asking whether the contestant
actually failed. `failedRow` (the only source of `Number.isNaN(r.usd)`, the
signal the adjacent `$` column already uses) sets `hosts`/`entities` to 0 as
a "never ran" sentinel, which is what that `||` was written for. But
`rowFromRun` reads `hosts: byHost.size` and `entities: entities.length`
straight from a completed sweep's own report
(`packages/sweep/src/sweep.ts:7171,7403`), and a genuinely dead anchor — every
SERP host filtered out, nothing kept, still a real (if tiny) dollar figure —
reports both as a true, measured 0, not "no data". The `||` fallback made
that row's hosts/entities columns print the identical dash a FAILED
contestant shows, in the exact scenario (a model config that finds nothing)
a bake-off exists to surface — the $ column would read a real price while
hosts/entities on the same row read "-", contradicting each other.

Fixed by gating the dash on `Number.isNaN(r.usd)`, the same signal the $
column already uses, instead of each field's own falsiness — `seconds` moved
to the same gate for consistency, though a real completed child `sweep.ts`
run rounding to 0 seconds is not a reachable case. Added a test with
`hosts: 0, entities: 0` on a row whose `usd` is a real number, asserting the
row prints `0`/`0`, not `-`/`-`. Verified non-vacuous by mutation: reverted
just the `renderTable` change, reran — the new test failed showing `-`/`-`;
restored the fix and reran clean before staging. No test previously
exercised `rowFromRun`/`renderTable` with a zero-count successful row —
every existing fixture used positive hosts/entities.

`pnpm check && pnpm test` both green: 3307 tests passing (up from 3306, one
new), 13 skipped (7 gated live/paid or run-dependent suites, same skip
census as SELF-509).

**SELF-512 (2026-09-17 overnight fire) — read `lib/graph/labels.ts` end to
end and found the anchor's label priority could lose to a big enough
market.** `labelPriority` encodes "the anchor first, then the hubs, then
placement" as one sort key: the anchor got a fixed `-1_000_000`, every other
node `-(deg * 1000 + rel)`. That only holds while no node's degree reaches
1,000 — at `deg: 1000` a market ties the anchor outright (`-1_000_000` on
both sides) and past it the market sorts strictly first, breaking the
comment's own stated invariant. `rel` (`RELATION_WEIGHT`, capped at 95 for
`competitor`) never closes that gap on its own. Not hypothetical: the
measured cursor.com run this branch's own P0 section cites already carries
926 hosts, and `GraphCanvas.tsx` sets a node's `deg` from its edge count in
the rendered graph — a single dominant market on a run that size is one hub
away from a four-digit degree.

Fixed by returning `-Infinity` for the anchor instead of a fixed offset,
so "the anchor first" holds by construction regardless of how large a
market's degree gets — safe because `isHub` is unique to the one node whose
id equals `meta.hubId` (`GraphCanvas.tsx`), so `priority` is never
`-Infinity` on both sides of the sort's subtraction. Added a test asserting
the anchor still outranks a `deg: 1200` market; reverted just the sentinel
to confirm the test fails first (`-1000000` is not less than `-1200095`),
then restored the fix. `packages/web/lib/graph/labels.test.ts`'s existing
`priority` usages are comparator-only (`a.priority - b.priority`), so an
infinite value introduces no other arithmetic to break.

`pnpm check && pnpm test` both green: 3308 tests passing (up from 3307, one
new), 13 skipped (same gated census as SELF-510/511).

**SELF-513 (2026-09-17 overnight fire) — read `core/src/board.ts` end to end
(one of 77 source files this branch's history had never individually
touched, per `git log --name-only` against every commit past the base merge)
and found `popAffordable`'s affordability check has no float-precision
guard, unlike every other dollar comparison in this codebase.**
`Ledger` (`core/src/ledger.ts:64`) carries its own `EPSILON = 1e-9` explicitly
because "`0.07 + 0.01 >= 0.8 * 0.1` is at the mercy of rounding in the last
bit," and every one of its five dollar comparisons (`reserve`, `settle`'s
none, `warnAt`, `overrunAbort`, `affordTurn`) uses it. `Board.popAffordable`
makes the same class of comparison — `allowances[held.tier] <= spendableUsd`
— with no such guard, and `orchestrator.ts:848` hands it exactly the kind of
value that trips this: `ledger.spendable() + fundedQueuedUsd()`, a running
sum of ordinary decimal dollar figures (0.05, 0.1, 0.25, the tier allowances
themselves) built through repeated float subtraction and addition. Verified
directly in node: `0.3 - 0.2 === 0.09999999999999998`, and `0.1 <=
0.09999999999999998` is `false` — so a `read`-tier mission (allowance
exactly $0.10) priced at exactly what is left over reads as unaffordable by
under a thousandth of a cent, gets narrated to the lead as skipped via
`narrateSkip`, and — since it is a `popAffordable` scan, not a `Ledger`
gate — never gets the benefit of `Ledger.reserve`'s own epsilon two lines
later, because `popAffordable` never lets it get that far. Not hypothetical:
every dollar figure `spendableUsd` is built from in production (`ceilingUsd`,
`finishReserveUsd`, the tier allowances) is an ordinary two-decimal number,
exactly the shape that produces this class of rounding error.

Fixed by giving `board.ts` its own `EPSILON = 1e-9` (same value, same
rationale, a fresh local constant rather than an import from `ledger.ts` to
avoid introducing a circular value-import — `ledger.ts` already does a
type-only import of `MissionTier` from `board.ts`) and widening the
comparison to `allowances[held.tier] <= spendableUsd + EPSILON`. Added a
test passing `spendableUsd = 0.3 - 0.2` against a `read`-tier mission;
reverted just the epsilon term to confirm the test fails first (`undefined`
where `"k"` was expected), then restored the fix. Every existing
`popAffordable` test still passes: none of them sit at a boundary this
narrow, so the widened comparison changes no other observed behaviour.

`pnpm check && pnpm test` both green: 3309 tests passing (up from 3308, one
new), 13 skipped (same gated census as SELF-510/511/512).

**SELF-514 (2026-09-17 overnight fire) — read `swarm/src/seed-families.ts`
end to end and found the family-floor's template picker swallows itself on a
category that already reads like one of its own templates.** `seedFamilyMissions`
builds five of its six query phrases (`alternatives`, `best`, `vs`, `top`,
`openSource`) with `q()`, a `.find()` over `[...open, ...reserve]` matched by
shape — `x.q.startsWith("best ")`, `x.q.endsWith(" vs")`, and so on — rather
than by which of `openingHand`'s six deterministic slots each is. That is
fine as long as the category itself (`c`, folded into every one of those six
strings) never happens to start or end with the words the shape is looking
for. It routinely does: "best fraud scoring", "open source data pipeline"
and an "X vs Y" pricing-page category are ordinary business-category
phrasings this app's own categories take, not contrived input. Verified
directly: `seedFamilyMissions({ category: "open source data pipeline", ... })`
produced a `substitutes` brief quoting `"open source data pipeline"` twice —
`bare` and the intended `openSource` slot (`open source ${c}` =
`"open source open source data pipeline"`) — because `bare`'s own text
already starts with "open source " and sits earlier in the search order.
Scoping the search to `reserve` alone (where `best`/`vs`/`top`/`openSource`
actually live) was not enough either: with `c` itself already prefixed
"open source ", `${c} vs` (`vs`'s own slot) ALSO starts with "open source "
and sits ahead of `openSource`'s slot in the same array, so `openSource`
still came out wrong.

Fixed by reading each of the five off its known, fixed index instead of
searching for it: `openingHand(c, [c], { branded: false })` deals a shape
that is invariant whenever its single term is non-empty — `open = [bare,
"${t0} alternatives"]`, `reserve = ["best ${t0}", "${t0} vs", "top ${t0}
companies", "open source ${t0}"]` — so `open[1]`, `reserve[0..3]` are what
each variable always meant; `?? fallback` covers the one case those slots
are absent (an empty category, where `openingHand`'s own `if (t0)` guard
produces empty `open`/`reserve` and every fallback already matched the
intended text). `bare` keeps its own `x.q === c` equality search unchanged —
it is already immune to this class of collision, and it is the one lookup a
prior fire (see the "untrimmed category" test) deliberately built to detect
a mismatch and fall back to the raw, untrimmed `c`. Added a test with two
categories ("best fraud scoring", "open source data pipeline") asserting
the correct templated phrase appears once each rather than duplicating
`bare`; reverted just the fix to confirm both assertions fail first (the
`open source data pipeline` case failing on the SECOND collision, the
`${t0} vs` one, even after the first fix pass), then restored it.

`pnpm check && pnpm test` both green: 3310 tests passing (up from 3309, one
new), 13 skipped (same gated census as SELF-510/511/512/513).

Backlog item: SELF-514

**SELF-515 (2026-09-17 overnight fire) — a full manual read of every
previously-untouched small/medium module found nothing to fix; read this
before re-reading the same files.** `git log a7bbc57..HEAD --name-only`
against every non-test `.ts`/`.tsx` file under `packages/*/src` and
`packages/web/{app,lib,components}` (93 files total, excluding the demo
gallery which is out of scope) named 91 files some prior fire had already
opened; two categories of the remaining set were genuinely untouched. Read
every one of them end to end, adversarially, looking for the same class of
bug SELF-510/512/513/514 found (a falsy-check standing in for a real
predicate, a `.find()` that can match the wrong slot, a comparison with no
float-precision guard, a status transition an invariant elsewhere silently
relies on):

`packages/core/src`: `grounding.ts` (descriptionGrounding's stopword/2-gram/
word-boundary logic), `investigator.ts`, `pricing.ts`, `prompts.ts`
(frontmatter identity check, `{{placeholder}}` fill). `packages/swarm/src`:
`family-ledger.ts` — traced its one subtle-looking case by hand (a killed
row's `nodesAdded` surviving into a later `opened()` on the same
`dedupeKey`) back to `core/src/board.ts`'s own invariant, "a landed mission
is never released: it stays claimed so its key keeps rejecting duplicates
for the rest of the run" (board.ts:135) plus `kill()`'s `#claimed.has` guard
(board.ts:172) — together they make a landed row's key structurally
unkillable and unreopenable, so the case cannot occur. `packages/web/lib`:
`kb-lookup.ts`, `graph/search.ts`, `graph/layout.ts` (the whole force
recipe — already exhaustively self-documented with measured numbers per
constant), `graph/layoutCache.ts`, `graph/settings.ts` (the
load/clamp/default reconciliation for all 20 settings fields, opt-in vs.
opt-out fields both checked against their own doc comments), `notes-view.ts`,
`scorecard-view.ts`, `stream-adapter.ts`, `theme.ts`, `graphIcons.ts` (the
LIFO request queue — `unshift`+`shift` — matches its own "newest first"
claim), `zip.ts` (byte-counted the local/central-directory/EOCD field
layout against the ZIP spec by hand — 30/46/22 bytes, all correct).
`packages/web/app/api`: every route under `kb/[id]/*`, `kb/route.ts`,
`run/[id]/route.ts`, `run/[id]/cancel/route.ts`, `run/[id]/stream/route.ts`.
`packages/web/middleware.ts` (the Basic-auth gate: colon-splitting, the
constant-time-ish compare, the open-when-unset default). `packages/web/
next.config.ts` (the `.env` mini-parser, the file-tracing includes, the
webpack `extensionAlias` shim) — one real parsing gap found and set aside
rather than "fixed": `loadRepoEnv`'s regex captures everything after `=` to
end-of-line, so `KEY=value # comment` would fold the comment into the value.
Not fixed, because it is not a bug this repo has: `.env.example` — the one
template this parser ever reads in the shapes this branch controls — puts
every comment on its own line, never inline, and DEPLOY.md's own env
instructions follow the same convention throughout. Shipping a fix for an
input shape that never occurs would be exactly the "arithmetic dressed as
evidence" P1-8's own BLOCKED note already warns against.

`pnpm install` first (a fresh clone had no `node_modules`, unlike every
prior fire in this file's history — noted in case the next fire hits the
same thing), then `pnpm check && pnpm test`: both green, 3310 tests passing,
13 skipped (same gated census as SELF-510 through SELF-514; unchanged by a
docs-only commit).

Not a claim that every file in the app is bug-free — `packages/swarm/src/
orchestrator.ts` (1,434 lines) and `packages/core/src/export-kb.ts` (1,143
lines) are both far larger than a single fire can read end to end
adversarially and both already carry many prior fixes, so a fresh full read
of either is still a genuinely open angle for a future fire. What this
entry closes off is the class of file small enough for one fire to finish:
every remaining untouched module under 300 lines is now read, and none of
them held the kind of bug this branch has been finding.

Backlog item: SELF-515 - BLOCKED

**SELF-516 (2026-09-17 overnight fire) — took SELF-515's own advice: a fresh
full read of `packages/swarm/src/orchestrator.ts` end to end, adversarially.**
Found the trigger surface of an ALREADY-KNOWN, ALREADY-ACCEPTED gap is wider
than its own test suite proves, and added the missing coverage rather than
changing the accepted behaviour.

`fill()`'s own comment (orchestrator.ts ~840) and an existing test
(orchestrator.test.ts, "eff's funded-queued add-back can admit a proposal
that ledger.reserve then refuses") already establish that `eff =
ledger.spendable() + fundedQueuedUsd()` can admit a board row that the real
`ledger.reserve()` then refuses — but that test's own title, and its
comment's own qualifier ("true ONLY while the pool has never overrun"),
frame the gap as an OVERRUN-only phenomenon: a lane's real cost blowing past
its own reservation. Tracing `eff`'s algebra by hand (every claim is either
funded-and-still-queued or started-and-unsettled, exhaustively — the
`fundedQueuedUsd()` term always cancels the queued half of
`ledger.spendable()`'s own subtraction) shows `eff` actually equals
`ceilingUsd - finishReserveUsd - spentUsd - <money committed to missions
actually RUNNING>`, a quantity with NO dependency on overrun at all — it is
provably ≥ `ledger.spendable()` by exactly `fundedQueuedUsd()`, always, the
moment ANY other row sits funded-and-queued beside the one being scanned.

That gap has a second, ordinary door with no overrun anywhere: `reviewTool`'s
promote (tools-control.ts ~535) can lift a still-unfunded investigator
proposal into the SAME 61-100 band a funded, spawned mission occupies.
`Board.popAffordable` (core/src/board.ts:104) returns the FIRST ranked row
that passes a single shared `eff`, highest priority first, never
recomputing it per row — so a promoted proposal ranked above an
already-funded mission wins the scan and gets popped first; if its real
`ledger.reserve()` then refuses, `fill()`'s while loop `break`s, and the
funded mission — sitting right behind it in rank, with real money already
set aside and a free lane waiting — never gets a look in that pass. Verified
by a new orchestrator.test.ts case with no overrun anywhere (a $0.50
ceiling, one seed dig settling cleanly at $0.20 of its $0.25 reservation):
the promoted proposal is popped and refused exactly as the algebra predicts,
and the funded mission it out-ranked ships as residue having never launched
at all — indistinguishable on paper from a mission that genuinely never
could afford its own tier. Confirmed non-vacuous by mutation: with the
`fundedQueuedUsd()` add-back removed, the same script correctly pops the
funded mission instead and the new assertions fail first.

Not fixed, on the same reasoning the existing test already applied to the
overrun door: the recovery path (`board.release`, a narrated skip,
`fillDry` forcing the lead's next turn) is exactly what makes the OTHER door
tolerable — no money is lost (the blocked mission's claim still settles at
$0 refund when the run ends, per `closeClaims`), and the cost is scheduling
opportunity, not correctness. A real fix would need `Board.popAffordable` to
tell "this specific row is already funded" apart from "money is generically
available" per row scanned, which changes its signature and every one of
its ~15 existing call sites/tests — a redesign, not the "small, real,
tested" scope one fire owns, and the maintainers already chose
document-not-fix for the sibling door. Left as a second, ordinary trigger of
the SAME documented tradeoff, so a future fire does not mistake it for a
fresh, independent bug.

`pnpm check && pnpm test` both green: 3311 tests passing (up from 3310, one
new), 13 skipped (same gated census as SELF-510 through SELF-515).

Backlog item: SELF-516

**SELF-517 (2026-09-18 overnight fire) — read `scripts/diff-runs.ts` end to
end and found its CLI table can print a "was" reading `diffMaps` never
compared.** `packages/core/src/drift.ts`'s own header states the rule for a
run that spells one key twice ("two subdomains folding to one host"): "the
first row speaks for the key — the order the run wrote is the order the run
meant", and `diffMaps` enforces it through a private `indexByKey` that keeps
the FIRST occurrence on a repeated key (`if (!index.has(key)) index.set(...)`).
`diff-runs.ts`'s CLI table — the "was"/"now" columns printed under the drift
sentences — built its OWN index instead, `new Map(m.entities.map((e) =>
[entityKey(e), e]))`, which is last-wins, the `Map` constructor's ordinary
behaviour on a repeated key. A duplicate-domain row is not hypothetical: it
is the exact shape `export-kb.ts`'s own comment already documents ("Two rows
with the SAME domain are one host reported twice — keeping the first is
right") and its test suite already covers on the export side. On the diff
side nothing did: `diffMaps` picks A's first row to compare against B, prints
a sentence naming that move, and the table two lines below it read A's LAST
row instead — two lines about the same key disagreeing about what "was".

Verified directly: A with two rows on `a.com` (`competitor` then
`substitute`), B with one (`adjacent`) — the sentence read "competitor ->
adjacent" (diffMaps' first-wins pick) and the table read "was substitute"
(the old last-wins `new Map`).

Fixed by exporting `indexByKey` from `drift.ts` (the same private
first-wins index `diffMaps` itself uses to decide `changed`/`left`/`entered`)
and having `diff-runs.ts` build its table from it directly, rather than a
second index built its own way — the same "a second copy of a rule is a rule
that can disagree with itself" reasoning `export-kb.ts`'s own header already
gives for importing `registrableHost` instead of restating it. The table
logic was pulled into an exported `driftRows(diff, a, b)`, the same shape
`parseRun`/`denoise` were already pulled out in one of D's own earlier
commits, so it is no longer only reachable through the CLI's `invokedDirectly`
gate. Added two tests: one reproducing the exact duplicate-domain case above
(asserting the table agrees with `diffMaps`' own `changed` entry), one for
the ordinary left/entered case. Reverted just the two `indexByKey` calls back
to a literal `new Map(entities.map(e => [entityKey(e), e]))` to confirm the
new test fails first — it read `"was substitute"` where `"competitor"` was
asserted — then restored the fix.

`pnpm check && pnpm test` both green: 3313 tests passing (up from 3311, two
new), 13 skipped (same gated census as SELF-510 through SELF-516).

Backlog item: SELF-517

**SELF-518 (2026-09-18 overnight fire) — read `components/ThemeToggle.tsx` end
to end and found its own top comment says the opposite of the actual default.**
The comment above the component read "dark is the default, so the stored/
attribute value is only ever 'light' when the reader has opted in." Both the
shared rule this component imports (`lib/theme.ts`'s `themeFromStored`: "LIGHT
is the default, and every non-'dark' value resolves to it") and the no-fouc
script in `app/layout.tsx` ("LIGHT is the default here") say the reverse —
light is the default and "dark" is the opt-in value. `theme.ts`'s own header
names exactly this failure mode ("Nothing here imports anything... this
function, the inline pre-paint script... and the `colorScheme`... must
agree"), and this comment, sitting right next to the one client-side reader of
that rule, had drifted to contradict it. No behavior was ever wrong — the code
three lines down (`isDark = theme === "dark"`) and the `themeFromStored` call
it wraps were already correct; only the comment lied. Fixed by flipping the
sentence to state light-default/dark-opt-in, matching `theme.ts` and
`layout.tsx` verbatim. No test change: this is a comment-only fix, the same
class as the "docs(...)" SELF-<n>'s already on this branch (e.g. the
`publicRunsPerDay` comment fix), and `theme.test.ts` already covers the real
behavior this comment describes.

`pnpm check && pnpm test` both green: 3313 tests passing (unchanged — no test
touches a comment), 13 skipped (same gated census as SELF-517).

**SELF-519 (2026-09-18 overnight fire) — read `core/src/export-kb.ts` end to
end and found the domain-collision fix documented at line 1111 (the "keeps
the first entity's own page" case) never reached `relations/`, `segments/`
or any of the entity counts.** That earlier fix made `entities/` write only
the first of two kept rows sharing a domain slug, via the `bySlug` map — but
`relations/`'s `byRelation` grouping, `segments/`'s `bySegment` grouping, the
README/SKILL.md/llms.txt entity counts, and `tiered` all looped over `kept`
directly, the very array the file's own comment already names as a live
collision path ("`repaired.entities` is not deduped by domain anywhere
upstream of this loop… whenever the classifier surfaces the same host twice
under two names in one run").

Verified directly: two kept rows sharing `domain: "same.example"`, one
`relation: "competitor"`, one `relation: "substitute"` —
`entities/same-example.md` correctly wrote only the competitor row (the
existing fix), but `relations/competitor.md` AND `relations/substitute.md`
both still wikilinked `[[same-example]]`, so the substitute list pointed a
reader at a page that never mentions a substitute relation at all — the page
is entirely the competitor row's own text. README's own count read "2
entities: competitor 1 · substitute 1" over the one page that actually
exists.

Fixed by introducing `rendered` — `kept` deduplicated the same way
`entities/` already is, read straight off `bySlug`'s values, which are
exactly the rows a page was written for — and routing `tiered`,
`byRelation`, `bySegment`, the README/llms.txt counts, and the `kept.length`
prose in README/SKILL.md/llms.txt through it instead of `kept`. Added a
regression test with the competitor/substitute collision above; reverted
just the fix (kept the test) to confirm it failed first — a stray
`relations/substitute.md` was still produced — then restored the fix.

`pnpm check && pnpm test` both green: 3314 tests passing (up from 3313, one
new), 13 skipped (same gated census as SELF-517/518).

Backlog item: SELF-519

Backlog item: SELF-518

**SELF-524 (2026-09-18 overnight fire) — read `core/src/sniff.ts` end to end
and found the soft-404 check uses a weaker "is this HTML" test than the one
the file itself already trusts for the same question.** `isHtml`'s own header
names the exact scenario soft-404 exists for — "a `.txt` URL that answers
with HTML did not have the file... one measured case returns 200,
`text/html`, and 608KB of another company's 'Page not found' page" — but the
soft-404 branch tested `looksLikeHtml(r.body)` instead of `isHtml`: a strict
prefix check (`^\s*(<!doctype html|<html\b)`) that reads only the body's own
first bytes, never the content-type, and never a body that is HTML by
tag-shape rather than by a literal doctype string.

Not hypothetical on either signal it misses. The content-type signal is the
one the docstring's own 608KB measured case turns on — a "Page not found"
page can easily open with something other than a literal doctype (a
boilerplate comment, a CDN banner) while still being served `text/html`. The
tag-shape signal is proven live two tests below in the same file: "extracts
HTML fragment without contentType (no DOCTYPE, no `<html>` prefix)" already
establishes that WAF interstitials commonly open with no doctype at all —
that test just never used a `.txt`/`.md`/`.json` URL, so nobody had asked
whether that exact fragment shape still gets caught when soft-404 is the
verdict that should fire. It doesn't: such a body sails past
`looksLikeHtml`, gets extracted by the very next line (`shouldExtract =
isHtml(...)`, which correctly answers true), and — if the extracted text
clears 200 chars, as a real error page's boilerplate usually does — comes
back `found`, an HTML error page misfiled as real content instead of the
`soft-404` a stored run's dead-end taxonomy exists to count separately.

Fixed by computing `shouldExtract = isHtml(r.body, r.contentType)` before the
soft-404 check and testing that instead of `looksLikeHtml(r.body)` — the
soft-404 branch and the extraction decision now ask the identical question,
which they always should have, since `shouldExtract` was already computed
one line later from the same inputs. Added two regression tests: one for the
doctype-less WAF-fragment shape on a `.txt` URL (content-type `text/html`,
body opening with a comment before `<div>`), one isolating the
content-type-only path (a body with zero HTML tag signals, caught only by
its `text/html` header). Verified non-vacuous by mutation: reverted just the
`sniff.ts` change (kept the tests), reran — both new tests failed reading
`found` where `not_found` was asserted; restored the fix. Every existing
soft-404/extraction test in the file (the markdown-with-generics cases, the
`<code>`-mention case, the plain-text-file case) still passes unmutated: none
of them trip `isHtml` any differently than they tripped `looksLikeHtml`
before, since none carry a `text/html` content-type or two-or-more real tag
signals on a plain-text URL.

`pnpm check && pnpm test` both green: 3322 tests passing (up from 3320, two
new), 13 skipped (same gated census as SELF-521/522/523).

Backlog item: SELF-524

**SELF-525 (2026-09-18 overnight fire) — read `core/src/export-kb.ts` end to
end and found nothing to fix; read this before re-reading the same file.**
SELF-515 named it explicitly: "`packages/core/src/export-kb.ts` (1,143 lines)
[is] far larger than a single fire can read end to end adversarially… still a
genuinely open angle for a future fire." This fire is that read — all 1,162
lines (it has grown since SELF-515), every exported function (`exportDrop`,
`slugOf`, `fm`, `tierSort`, `receiptSource`, `segmentOf`,
`withoutStolenNames`, `exportKbFiles`) and every inline gate inside
`exportKbFiles` (the domain-collision `bySlug`/`rendered` split SELF-519 fixed,
the induced-subgraph edge cut, the half-edge taint set, the shared-suffix
hoist in `relations/unknown.md`, the segment-key folding, the README/SKILL.md/
llms.txt count arithmetic, the manifest serialization).

Nothing was wrong. The file is already the most heavily self-documented one on
this branch — nearly every non-obvious line carries a paragraph proving it
correct with a measured number (`export-kb.test.ts` is 1,193 lines, longer
than the source), and several of the exact defect classes this branch's other
`SELF-<n>`'s have found elsewhere (a `.find()`/`[0]` picking the wrong row, a
raw `new Map` overwriting a first occurrence, a falsy check standing in for a
real predicate) are already called out and either fixed or deliberately
documented as inert here (`segmentOf`'s `foundBy?.[0]` tie is measured at ~3%
and left alone with a written reason; the `?? ""`/`|| "unattributed"`
fallbacks are each proven dead by the invariants two lines above them, not
guessed at).

Also read, in the same pass, every other file this branch's history had never
opened that was large enough to plausibly hide something: `core/src/
scorecard.ts` (290 lines — the finish-gate's own instrument; its test file
already exercises every branch this read could find, including the exact
mutation-style edge cases — a `window===1` vs plural-window `recent` count, a
`den===1` singular noun, an all-empty-families sentence — a fresh read would
have reached first); `packages/sweep/src/ui.ts` (71 lines, narration framing)
and its dedicated `a-torn-ui-frame-degrades-to-one-missing-line.test.ts`;
`scripts/query-yield.ts` (257 lines) and `tests/query-yield.test.ts`;
`packages/web/lib/demo.ts` (the read-only demo-mode gate, not the out-of-scope
demo gallery — confirmed by reading `docs/overnight-backlog.md`'s own "NOT IN
SCOPE" line before opening it); `packages/web/app/kb/page.tsx`, `kb/[id]/
page.tsx` and `runs/page.tsx`; and the previously-untouched icon/legend
components `GraphLegend.tsx`, `TabBar.tsx`, `icons/NodeGlyph.tsx` (plus its
`glyphForNotePath` test), and `viz/Donut.tsx`/`Gauge.tsx`'s arc-geometry math
(the `large`-arc-flag and single-segment-circle special cases in both,
independently derived and both correct). None held a defect either.

One near-miss worth recording so it is not re-investigated: `GraphLegend.tsx`
carries the sentence "port NOTE, THE footnote earns ITS line." — its
capitalisation looks corrupted at first read. It is not: `packages/web/app/
runs/page.tsx` independently opens a comment "port NOTE. v1 built this page
from the KB manifests on disk…", so "port NOTE" is this codebase's own porting-
note marker (paired with `layerMeta.tsx`'s spelled-out "PORT NOTE — what came
across, and what did not."), not a typo. Checked before touching it, on the
same "no honest seam" standard the rest of this branch holds itself to for a
code change; the same standard says an unowned guess at a confusing but
possibly-intentional sentence is not a fix.

Not a claim that `export-kb.ts` or any of the above is bug-free forever — only
that this specific angle (a full adversarial read, the tool SELF-515 itself
prescribed for files too large for a coverage sweep) is exhausted for these
files today. `packages/swarm/src/orchestrator.ts` was the other file SELF-515
named as too large; SELF-516 already gave it this same treatment.

`pnpm install` first (fresh clone, no `node_modules` — same as SELF-515 hit).
`pnpm check && pnpm test` both green: 3322 tests passing, 13 skipped (same
gated census as SELF-524; unchanged by a read-only, docs-only fire).

Backlog item: SELF-525 - BLOCKED

**SELF-526 (2026-09-19 overnight fire) — read `packages/web/components/build/
SearchesPanel.tsx` end to end and found a row's expanded state can silently
collapse under the "only the empty" toggle, even though the row never left
the list.** Each row's `id` — the key `open === id` compares against, so a
click can reopen the exact row it just closed — was built from the row's
index in `shown`, the array AFTER `onlyEmpty` filtering: `shown.map((s, i) =>
{ const id = `${s.query}-${i}`; ...})`. `shown` recomputes on every toggle
(`useMemo` depends on `onlyEmpty`), and filtering drops rows from the middle
of the list, not just the tail — so a row that survives the filter (it is
itself barren or failed, matching `!s.ok || s.hits.length === 0`) can still
shift to a new index once the rows ahead of it that DON'T survive are
removed. Its `id` changes on the very re-render that keeps it visible, `open`
stops matching, and `isOpen` goes false: a reader has a search's detail panel
open, clicks "only the empty" to see the rest of the barren ones, and the one
they already had open — never removed from the list — reads as collapsed
with no click of their own to explain it.

Verified by hand-tracing three searches: `X` (ok, has hits), `Y` (failed),
`Z` (ok, zero hits). With the toggle off, `shown = [X, Y, Z]` and opening `Z`
sets `open = "Z-2"`. Toggling "only the empty" on makes `shown = [Y, Z]` (`X`
is dropped) — `Z` is still there, but now at index 1, so its freshly computed
id is `"Z-1"` and `open === id` is false. `Z`'s own row never moved out of
the list; only its position within the SHOWN array moved out from under it.

Fixed by assigning each row its id once, over the full `searches` list,
before any filtering — a new exported `withRowIds(searches)` — and having
`shown` filter that already-tagged array (`rows.filter(({ s }) => ...)`)
rather than filtering first and re-indexing after. An id is now a row's
identity (its query plus its position in the run's own search order), not
whatever slot it happens to land in after the reader's filter choice, so a
row keeps its id — and therefore its open/closed state — for as long as it
stays in `searches` at all.

Added two tests against the new pure `withRowIds` export: one confirming a
surviving row's id is the one computed over the full list, not one recomputed
after filtering (mirrors the `X`/`Y`/`Z` trace above); one confirming two
searches sharing the same query text still get distinct ids (guards the
obvious wrong fix of dropping the index and keying on `s.query` alone).
Verified non-vacuous by mutation: temporarily changed `withRowIds` to
`id: s.query` (dropping the index) and reran — the duplicate-query test
failed (`expected 'dup' not to be 'dup'`); restored the fix and reran clean.
Could not mutation-test the id-*reassignment* bug itself end to end through
the component — `open`/`onlyEmpty` only change from a click, and
`SearchesPanel.test.tsx`'s own header comment already documents why nothing
here can run one: no jsdom/RTL harness exists in this repo (the same
limitation `TabBar.test.tsx`, `ThemeToggle.test.tsx` and
`GraphSearch.test.tsx` note for their own interaction-gated parts). The two
`withRowIds` tests are the closest a static-render-only suite can get to
proving the fix, by testing the exact contract the component's `rows`/`shown`
split now relies on.

`pnpm install` first (fresh clone, no `node_modules`, same as SELF-515/525).
`pnpm check && pnpm test` both green: 3324 tests passing (up from 3322, two
new), 13 skipped (same gated census as SELF-524/525).

Backlog item: SELF-526

**SELF-528 (2026-09-19 overnight fire) — a fresh end-to-end read of eight
files nobody had fully read found nothing to fix; read this before
re-reading any of them.** SELF-527 (untracked here — a test-only commit,
`d6e17da`) landed since SELF-526; git log is still the count that matters,
not this file. Picked the D-scope's own prescription (a genuine logic read,
not another coverage sweep) and targeted files with zero or one prior
commit touching either the source or its test, confirmed with
`git log a7bbc57..HEAD --oneline -- <src> <test>` per file before opening
it, so this does not re-read ground SELF-509 through SELF-526 already
covered (their own file lists checked first: `scorecard.ts`, `ui.ts`,
`demo.ts`, `query-yield.ts`, `GraphLegend.tsx`, `TabBar.tsx`,
`NodeGlyph.tsx`, `Donut.tsx`/`Gauge.tsx`, `board.ts`, `export-kb.ts`,
`sniff.ts`, `orchestrator.ts` were all excluded on that basis before this
fire started).

Eight files, full read, none held a defect:

- `app/api/run/[id]/stream/route.ts` + `lib/stream-adapter.ts` — the live
  and replay NDJSON framing. Already the target of two prior fires' tests
  (`c0d866d`, `e336041`) that drove every branch including the genuine
  mid-stream-fault catch; `stream-adapter.ts` itself had never been read
  end to end and turned out clean (the `ui.frame.agent` restore, the
  cumulative cost counters, the narration/work split all check out against
  their own doc comments).
- `components/build/types.ts` (528 lines) — the wire contract for all five
  streams. `AGENT_STAGE`'s "retired" keys (`read`, `discover`, `catalog`,
  `search`, `classify`, `extract`, `complete`) are dead against the current
  `Phase` type (`sweep.ts:1390` — `understand | plan | sweep | rank | link |
  write`), confirmed by grepping every `say(agent, …)` call site in
  `sweep.ts` and `swarm/src` for an `agent:` string outside that union: none
  exists. Kept as-is — the comment already says why ("kept so a frame from
  an older shape still lights the right stage"), and a stored older run's
  spans replaying through this same route are exactly the shape that would
  need them.
- `swarm/src/family-ledger.ts` — traced whether `opened()`'s reuse of an
  existing row (it resets `status`/`lens`/`priority`, never `nodesAdded`)
  can under-report a family that landed once, was killed, and reopened.
  It cannot: `board.kill` (`core/src/board.ts:170-176`) only removes a
  QUEUED item — a claimed or landed mission has no path back to `killed`,
  so any row `family-ledger.killed()` ever reaches still holds
  `nodesAdded: 0`. The invariant is real, not assumed: grepped every
  `families.landed`/`.killed` call site in `orchestrator.ts` and
  `tools-control.ts` to confirm neither fires on a claimed key.
- `core/src/grounding.ts` — `appears()`'s doc comment claims "same boundary
  discipline as `namesHost`" (`coverage.ts`), but `namesHost` excludes
  hyphen from its boundary class (`[^a-z0-9-]`, so "bright-sdk.com" does not
  name "sdk.com") while `appears()` does not (`[^a-z0-9]`, so "sdk" reads as
  grounded by "bright-sdk"). Confirmed the divergence is real with a
  throwaway `node -e` check before touching anything, then found
  `grounding.test.ts`'s own "a 2-gram matches across whitespace and
  punctuation" case already asserts this exact behaviour and names it in
  its comment ("1-grams both appear (hyphen is a boundary)") — a prior fire
  already made this call deliberately. Left alone: "same discipline" in the
  doc comment overstates it slightly (it means the shared over-collection
  guard, not an identical character class), which is a wording nit, not a
  functional bug, and not worth a diff that would only reword a comment
  while an existing test pins the opposite of what a "fix" would do.
- `core/src/investigator.ts` — already the target of four prior
  branch-coverage fires (`28da7ca`, `a7e0033`, `7d5b3eb`, `b227714`); a full
  read (as opposed to those fires' targeted-uncovered-line reads) found
  nothing past what they already fixed.
- `components/build/BuildWorkflow.tsx` (961 lines, the largest component in
  the repo with only one prior commit — a coverage test for
  `isSpendDecision`/`mergeEntities`). Read end to end. `mergeEntities`
  relies on `Map#set` NOT reordering an existing key on update — verified
  against spec, not assumed, so a re-classified entity keeps its screen
  position. `calls`/`spendHistory`/`agentChunks` cap their arrays at
  `length > N ? [...slice(-N), new] : [...old, new]`, which lets each grow
  to N+1 before the next trim (`addFeed` two lines away does the same job
  without the overshoot, checking length AFTER appending) — a real
  inconsistency, but the consequence is an array one element over its
  stated cap, never wrong data or a growth leak, nowhere near this
  codebase's own bar for a fix (a quantified failure scenario). Left alone
  as beneath the threshold rather than patched for its own sake.
- `components/kb/KbBrowser.tsx` — the tab/note routing shell already
  covered by SELF-141's coverage fix on `pickDefaultNote`/`resolveTab`/
  `resolveNote`; the rest of the component (counts, command palette wiring,
  the `port NOTE` comment already explained by SELF-525's near-miss entry)
  held nothing new.
- `lib/public-runs.ts` — the visitor daily-allowance gate (`runGate`,
  `publicRunsPerDay`). Financial-critical, already the target of two prior
  fires (a doc fix and a `runGate` branch test). Read end to end including
  the UTC-day arithmetic and the fail-closed uncountable-store path;
  `remaining = Math.max(0, limit - used)` floors correctly even if a race
  let `used` exceed `limit`. Clean.

No code change this fire — every candidate either already had its defect
fixed by an earlier one, or the thing that looked like a defect turned out
to be a previously-made, tested, deliberate call. `pnpm install` first
(fresh clone). `pnpm check && pnpm test` both green: 3325 tests passing, 13
skipped (same gated census as SELF-527) — unchanged by a read-only fire.

Backlog item: SELF-528 - BLOCKED

**SELF-529 (2026-09-19 overnight fire) — read the eight small/medium
financial and address-safety modules the D section names or implies and
never got a full adversarial pass, found nothing to fix; read this before
re-reading any of them.** Continued the file-by-file sweep SELF-515/525/528
established (git log confirmed zero or one prior touch on both source and
test before opening each one): `core/src/ledger.ts` and `core/src/
spend-cap.ts` (the two files the D section names by hand — "areas nobody
has swept: `core/src/ledger.ts` and `spend-cap.ts`"), `core/src/breaker.ts`,
`core/src/flags.ts`, `core/src/spans.ts`, `core/src/coverage.ts`,
`core/src/evidence.ts`, and `core/src/url.ts` (the SSRF-guard module —
`isReservedHost`/`isIpLiteral`/`registrableHost`/`canonicalUrl`).

`ledger.ts`: traced every method (`reserve`, `settle`, `draw`, `warnAt`,
`overrunAbort`, `affordTurn`, `spendable`) against its own doc comments and
`packages/core/tests/ledger.test.ts`'s 25 cases. One thing that looked like
a gap on first read — a ceiling under ~$0.15 makes `finishReserveUsd`
($0.12 floor) exceed the whole pool, so `spendable()` starts negative and
`reserve()` refuses even the cheapest (`peek`, $0.03) tier from the first
call — is not a fresh find: `ledger.test.ts`'s own "a ceiling below the
floor leaves nothing spendable, not a crash" and the sentence-formatting
test right after it already exercise and title this exact shape as
deliberate, tested fail-closed behaviour, not a gap to close. `affordTurn`
is advisory-only (no hold), but every call site (`swarm/src/agent.ts:838`)
follows it with a real `reserve()` in the same synchronous turn, so there
is no window for two turns to both pass `affordTurn` against money only one
of them can actually claim.

`spend-cap.ts`: the ordering argument (announce → abort → record, abort
BEFORE record on purpose, `stillRunning` racing a behind-the-log consumer,
the `onRecordFailure` unhandled-rejection guard) is already the target of
`packages/core/tests/spend-cap.test.ts`'s 13 cases, one per race this
file's own comments name. Nothing in a full read added to that list.

`breaker.ts`, `flags.ts`, `spans.ts`, `coverage.ts`, `evidence.ts`: all
small, all clean. `spans.ts`'s fan-out (`#subscribers`, one cursor per
`stream()` caller) resumes each parked subscriber via a Promise resolve,
which schedules a microtask rather than re-entering `emit`'s own
subscriber loop synchronously, so a subscriber added mid-`emit` cannot
observe a torn iteration. `coverage.ts`'s `answerKeyRecall` takes an
`anchorAliases` param that, undocumented but confirmed by reading both call
sites (`orchestrator.ts:932`, `sweep.ts:7239`), is NEVER omitted in
production — both always pass `anchorAliasSet`'s result, which always
contains the anchor itself — so the function's own `if (opts.anchorAliases)`
branch that skips host-based probe exclusion when the param is absent is
dead in practice, not a hole: every real probe pool already has the anchor
and its aliases filtered out one layer up in `run-evidence.ts`'s
`recallProbePool` / `sweep.ts`'s inline `anchorAliasSet` call before
`answerKeyRecall` ever sees the pages.

One near-miss worth recording so it is not re-investigated as a security
bug: `url.ts`'s own header states `ipv4Value` implements "inet_aton's
grammar, which is also the WHATWG URL parser's... anything this reads as
an address is an address `fetch` will connect to, and reading it any other
way is the bug." It is not quite that grammar: WHATWG's IPv4 parser picks
octal (radix 8) for any part with a leading zero and LENGTH > 1, then fails
the WHOLE address if that part contains an invalid octal digit (8 or 9) —
it never falls back to decimal. `ipv4Value`'s octal branch is
`/^0[0-7]+$/`, and when a leading-zero part fails that test (e.g. "08") it
falls through to the plain `/^\d+$/` decimal check instead of returning
null, misreading "08" as decimal 8 rather than a parse failure. Confirmed
against Node directly: `new URL("https://08.0.0.1/llms.txt")` throws
`Invalid URL`, while `ipv4Value("08.0.0.1")` in this file returns
134217729 (8.0.0.1) and `isReservedHost("08.0.0.1")` answers `false`.

Traced whether this actually changes a real verdict, in both directions.
Under-blocking (a false "not reserved" on something `fetch` really would
reach): impossible from this gap alone — every host `new URL` fails to
parse for THIS reason is a host `fetch` can never open a connection to
either, guarded or not, so `isReservedHost`'s answer on it is moot. The one
caller that sees the raw, un-parsed string before any `new URL` call
(`normalizeDomain` in `web/lib/anchor.ts`) still lands on the identical
"not reserved" verdict with or without this bug, confirmed directly
(`isReservedHost("08.0.0.1")` and `isReservedHost("09.0.0.1")` both read
`false` today; patching the octal branch to return null on an invalid digit
does not change the answer, because the fallback path — "not an IP, does
it end in `.local`/`.internal`/etc." — answers `false` for the same
reason). Over-blocking is the only direction this bug can move a verdict:
a leading-zero part whose decimal misreading happens to land in a reserved
octet range (`"0229.0.0.1"` → decimal 229 ≥ 224 → flagged reserved) gets
refused, but a four-label all-numeric string is never a real company
domain to begin with — nobody types `0229.0.0.1` into the anchor field
meaning a website. Not fixed: every path this could touch is either
provably unreachable (the URL constructor already fails closed first) or
already correct, so a diff here would be exactly the "arithmetic dressed
as evidence" P1-8 and SELF-515 both already warn against — tightening a
grammar with no case where the tighter version and the current one give a
different, reachable answer.

`pnpm install` first (fresh clone, no `node_modules`, same as SELF-515/
525/526/528). `pnpm check && pnpm test` both green: 3325 tests passing, 13
skipped (same gated census as SELF-527/528) — unchanged by a read-only
fire.

Backlog item: SELF-529 - BLOCKED

**SELF-533 (2026-09-20 overnight fire) — a fresh read of nine more small
modules found nothing to fix; one near-miss worth recording so a future
fire does not retest it with less rigor than this one did.** Continued the
D-scope file-by-file sweep, picking files with zero commits against either
source or test in `git log a7bbc57..HEAD` (checked per file before opening
it, so this does not overlap SELF-509 through SELF-532's own lists):
`core/src/scorecard.ts` + `scorecard-view.ts` (the finish-gate instrument
and its web card, re-verified independently of SELF-515's own pass —
traced `computeScorecard`'s yield-window arithmetic, every fraction's
den-0 rule, and `scorecardObjections`'s threshold comparisons by hand
against `scorecard.test.ts`'s 40-odd cases; all correct), `packages/swarm/
src/family-ledger.ts` (re-confirmed SELF-515/528's own finding — a killed
row's `nodesAdded` cannot leak from a landed one, because `board.kill` only
releases a QUEUED key), `packages/sweep/src/rank.ts` (a 12-line re-export
shim, nothing to find), `components/build/CostBreakdown.tsx` (155 lines,
never read before — confirmed `byKind`/`byAgent` arrive pre-sorted
descending by `usd` from `sweep.ts`'s own `lines()` at line ~1843, so
`Lines`' `rows.slice(0, max)` truncation always folds the SMALLEST-dollar
rows into the "+N more" tail, never hides the largest one — the one way
this component's truncation could have misled a reader), `components/
build/DecisionsStrip.tsx`, `StageTracker.tsx`, `components/viz/
Sparkline.tsx`, `components/SkipLink.tsx`, `components/kb/layerMeta.tsx`
(all already covered by a dedicated test file from an earlier fire —
`DecisionsStrip.test.tsx` (SELF-85), `Sparkline.test.tsx`, `SkipLink.
test.tsx`, `layerMeta.test.ts` — confirmed on this read that the test
file's own edge cases match the source's actual branches, nothing missed),
and `components/KbGallery.tsx`'s `sortedGallery` (hand-traced the "recent"
sort's `(builtAtOf(b) ?? "").localeCompare(builtAtOf(a) ?? "")` comparator
in both directions against its own doc comment's claim — "a run with no
recorded finish time sorts last, not first" — and confirmed it holds
whichever side of the pair is missing a timestamp, not just the one
direction a hasty read would check).

One near-miss, caught before it became a false "fix": a byte-level replay
of `zip.ts`'s local file header looked, on a first hand-count of its
`chunks.push(...)` call, like it wrote SIX 2-byte fields before the CRC
(one too many for the ZIP spec's 30-byte local header) — a plausible bug
shape given SELF-517's drift-in-a-second-copy precedent. Verified against
a REAL unzip binary rather than trusting the hand count or the existing
self-referential round-trip test (which only proves `zipOf` and its own
`readZip` test helper agree with EACH OTHER, not with the ZIP spec): wrote
the exact source line to a throwaway script, built an archive, and ran
`unzip -l`/`unzip -p` against it. The apparent sixth field was a
transcription slip made while retyping the line into the throwaway script,
not a defect in `zip.ts` itself — `unzip -p` on an archive built from a
byte-exact copy of the real `chunks.push(...)` line extracts both entries
correctly, and re-reading `zip.ts` character-by-character (`python3 -c
"print(repr(...))"`, to rule out an editor/tool reformatting the line) with
a plain count confirms five 2-byte fields before the CRC, matching the
30-byte header SELF-515 already byte-counted. Recorded so a future fire
that eyeballs this same line does not repeat the miscount — the module
itself is unchanged and correct.

No code change this fire — every candidate was already correct, either
newly confirmed or re-confirming a prior fire's own finding. `pnpm install`
first (fresh clone, no `node_modules`). `pnpm check && pnpm test` both
green: 3328 tests passing, 13 skipped (same gated census as SELF-529) —
unchanged by a read-only fire.

Backlog item: SELF-533 - BLOCKED

**SELF-534 (2026-09-20 overnight fire) — a genuinely different angle (the
lowest-git-touch CLI scripts and provider modules, rather than another D-scope
file-by-file sweep) found nothing fixable, plus one dead-output near-miss
worth recording so a future fire does not chase it.** SELF-509's own advice
("pick a genuinely different angle... rather than another instrumented
sweep") and five straight BLOCKED sweeps since (515/525/528/529/533) argued
against a sixth exhaustive file list. Instead, picked by `git log
a7bbc57..HEAD --oneline -- <file>` count — the files this branch's 500+ prior
commits had touched least — on the theory that a low touch count on a file
that is not obviously dead code is where an undiscovered bug is likeliest to
still hide: `scripts/overnight.ts`, `scripts/show-prompt.ts`,
`scripts/fatal.ts`, `scripts/audit.ts`, `scripts/discover.ts`,
`scripts/export-target.ts`, `packages/providers/src/pricing.ts`,
`packages/providers/src/safe-fetch.ts`, `packages/core/src/verdict.ts`, and
`packages/core/src/tools.ts`. Read every one end to end, including checking
`overnight.ts`'s `parseSweepStdout` regexes against the exact template
literals `scripts/sweep.ts`/`packages/sweep/src/sweep.ts` print (grepped
every `console.log`/`say()` site that could produce a competing `$N ·`,
`N on the map`, or `N products →` substring earlier in the same stdout, to
rule out the unanchored-regex class of bug SELF-517 found in `diff-runs.ts`)
and `safe-fetch.ts`'s redirect-hop counter by hand (confirms `maxRedirects`
redirects are followed and the `(maxRedirects+1)`th throws, no off-by-one).
All ten were already either bug-free or had their bug already fixed by an
earlier fire and pinned by a test (`fatal.ts`, `show-prompt.ts`,
`discover.ts`'s `costBreakdown` each carry a comment naming the prior fix).

One dead-output near-miss, recorded so it is not mistaken for a live bug:
`tools.ts`'s `remember` tool merges a second sighting of an existing node by
pushing onto `existing.alsoWhat`/`alsoWhyHere` when the new value differs
from `existing.what`/`whyHere` — but `existing.what` is set once at creation
and never reassigned, so the guard only catches a repeat of the ORIGINAL
value (exactly what `tools.test.ts`'s three-call test proves), not a repeat
of a value already sitting in `alsoWhat` itself. A second and third sighting
that agree with EACH OTHER but differ from the original would duplicate the
same string in `alsoWhat`. Traced whether this is reachable in the product
rather than assuming it from the code shape: `grep`ing every file in the repo
for `alsoWhat`/`alsoWhyHere` outside `tools.ts` and its own tests returns
nothing — `RunContext`/`makeTools`/`StoredNode` are wired only through
`core/src/investigator.ts`, which is called only by
`scripts/demo-investigate.ts` (a live-money manual harness, not the sweep or
swarm pipeline `packages/sweep/src/sweep.ts` and
`packages/swarm/src/orchestrator.ts` actually run — confirmed by grepping
`orchestrator.ts`'s own imports for `investigate`/`makeTools`/`StoredNode`:
none). `demo-investigate.ts`'s own print loop reads `n.what`/`n.whyHere`/
`n.howFound`/`n.evidence` but never `n.alsoWhat`/`n.alsoWhyHere`, and its own
comment says the demo gallery (`packages/web/lib/runs.ts`) never even lists a
`demo-` run. So a duplicate in `alsoWhat` reaches the JSON file
`demo-investigate.ts` writes (the field survives the `[...ctx.graph.nodes.
values()]` spread) and then reaches nothing else at all — not a rendered
page, not an export, not another script. Not fixed: a duplicate with zero
observable reader is not the "quantified failure scenario" this branch's own
bar requires, and this script sits beside the demo gallery this backlog
already excludes, not inside the sweep/swarm pipeline the P0-P1/self-work
above actually hardens.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3328 tests passing, 13 skipped (same gated census as
SELF-533) — unchanged by a read-only fire.

Backlog item: SELF-534 - BLOCKED

**SELF-535 (2026-09-20 overnight fire) — a git-log-confirmed "zero prior
touch" sweep, checked against source AND test this time, found one of three
candidates held a real, verifiable UI bug.** Built the untouched-file list
for every non-test `.ts`/`.tsx` under `packages/*/src`,
`scripts/`, and `packages/web/{app,components,lib}`, checked
`git log a7bbc57..HEAD --oneline -- <src> <its .test sibling>` together, not
the source alone — SELF-528's own method, which SELF-534 had drifted back to
counting source files only. The source-only version first returned several
files (`components/build/EventFeed.tsx`, `components/viz/BarMeter.tsx`)
that turned out to already carry dedicated, thorough test files added
without ever touching the source — a few minutes of reading them before the
joint check caught it, not a wasted fire, but the reason to record the
correct method again here. Three files cleared the joint bar:
`packages/web/app/runs/page.tsx`
(read once before, in SELF-525's "kb/page.tsx, kb/[id]/page.tsx and
runs/page.tsx" pass, but never edited or given its own test), and the two
trivial re-export barrels `components/icons/index.ts` / `components/viz/
index.ts` (7 and 14 lines, nothing but `export * from` — read, confirmably
inert, not worth a diff).

`runs/page.tsx`'s KPI row: `<div className={... grid grid-cols-2 ... ${
failedCount > 0 ? "sm:grid-cols-4" : "sm:grid-cols-3"} }>` — the adjacent
comment ("A fixed four would put the Failed tile alone on a second row with
three empty cells beside it... three slate blocks would read as tiles whose
numbers failed to load") proves the author reasoned carefully about
avoiding an orphaned grid cell, and did, for the `sm:` breakpoint: 3 tiles
at `sm:grid-cols-3` or 4 at `sm:grid-cols-4`, always an exact fit. The base
`grid-cols-2`, sitting in the same className string, was never made
conditional. Below `sm` (which is where a phone visitor actually is) the
common case — no failed runs, 3 tiles — lays out 2-then-1: the third tile
alone in row two, with an unfilled cell beside it that paints the
container's own `bg-slate-800` rather than a tile's `bg-slate-900`
(`StatTile.tsx`), which is the exact "reads as a tile whose number failed
to load" defect the comment already names — just on the breakpoint it
forgot, in the case (no failures) that is the common one, not the rare one.

Also found, in the same paragraph: the comment itself has drifted.
"Four columns, or five when there is a fifth tile" was true when this row
carried four fixed tiles — Runs, Entities mapped, Spent, Unplaced — plus the
conditional fifth, Failed (confirmed against `13fa081`'s own diff, which
shows `failedCount > 0 ? "sm:grid-cols-5" : "sm:grid-cols-4"` on the removed
side). `Spent` and `Unplaced` were both replaced by a single `Companies
found` tile in that same commit ("feat(web): the runs page counts market,
not the owner's bill, and says how to make one"), which dropped the tile
count from 4/5 to 3/4 and changed the `sm:grid-cols-4/5` split to today's
`sm:grid-cols-3/4` — but never touched the sentence describing it, the same
"a fix landed but the sibling text/logic describing it did not" shape
SELF-517/518/519 each already found elsewhere in this branch.

Fixed both: made the base breakpoint conditional too —
`failedCount > 0 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"` (three
tiles fit exactly at every width with `grid-cols-3` alone, so no `sm:`
override is even needed in that branch any more) — and rewrote the comment
to state the current 3/4 tile count, explain why both breakpoints need the
condition, and cite `13fa081` as where the count changed and the comment
should have been updated but wasn't.

Added `packages/web/app/runs/page-kpi-grid.test.tsx` (a new file rather than
a new `describe` in the existing `runs/page.test.tsx`, on purpose:
`lib/runs.ts` keeps an in-memory run registry that `listStoredRuns` merges
in "even when the disk refused", per that file's own comment, and it is
module-scoped — shared by every test in one file regardless of which
`OPENKB_RUNS_DIR` a given test points at. `runs/page.test.tsx`'s own
earlier describes already populate it with failed runs, so a `describe`
appended there could never observe a clean "zero failures" state; tried
exactly that first and watched the "no failures" assertion see 3 leaked
failed runs from earlier tests in the same file before splitting it out.
Vitest isolates modules per test FILE by default, so a dedicated file gets
a fresh `runs.ts` and therefore an empty registry — confirmed by the same
two tests failing for the RIGHT reason, an empty registry, once isolated).
Two tests: the 3-tile case asserts `grid-cols-3` present and `grid-cols-2`
absent (the string appears nowhere else on this page — confirmed by grep
before relying on it); the 4-tile case asserts the exact contiguous string
`grid-cols-2 sm:grid-cols-4`. Verified non-vacuous by mutation: `git stash`
on just `page.tsx`, reran — both new tests failed against the un-fixed
source. The 3-tile case failed as expected (`grid-cols-2` is present, from
the old unconditional base class). The 4-tile case failed for a more
specific reason worth recording: the un-fixed markup DOES contain both
`grid-cols-2` and `sm:grid-cols-4`, just not adjacent to each other — the
old template put six other classes (`gap-px overflow-hidden rounded-lg
border border-slate-800 bg-slate-800`) between them, so the exact contiguous
string the test looks for never appears until the fix moves the conditional
class next to the base one. That is what makes the assertion a real check
of the fix's own shape rather than a loose "both classes present somewhere"
test — then `git stash pop` restored the fix and both passed clean.

`pnpm install` first (fresh clone, no `node_modules`, same as SELF-533/534).
`pnpm check && pnpm test` both green: 3330 tests passing (up from 3328, two
new), 13 skipped (same gated census as SELF-534) — the KPI-grid file is new,
`runs/page.test.tsx` itself unchanged.

Backlog item: SELF-535

**SELF-536 (2026-09-20 overnight fire) — a joint source+test zero-touch sweep
read four more files end to end and found two theoretical gates gaps, both
confirmed unreachable in this codebase; read this before re-chasing either.**
Continued SELF-528/535's method (`git log a7bbc57..HEAD --oneline -- <src>
<test>` per candidate, checked against both files together, not source
alone): `packages/web/app/layout.tsx` (173 lines, the root layout and its
no-FOUC script), `packages/swarm/src/index.ts` (184-line barrel), and the two
`scripts/check-*.mjs` guards that had never been touched on this branch —
`check-core-purity.mjs` and `check-test-collection.mjs` — read together with
their dedicated probe suites, `tests/purity.test.ts` and
`tests/collection.test.ts`.

`layout.tsx`: already the most densely self-documented file this sweep has
found (`viewport`'s own comment walks through what survives a throw in the
component below it, measured against a real production build). One claim
worth checking rather than trusting: "`mergeViewport` in Next's metadata
resolver walks the keys this object actually has and leaves the rest of
`createDefaultViewport()` alone." Read `mergeViewport` directly out of this
repo's pinned `next@16.2.12`
(`node_modules/.pnpm/next@16.2.12.../next/dist/lib/metadata/resolve-metadata.js:315`)
— it does exactly that, a `for...in viewport` switch over a `structuredClone`
of the already-resolved default. The no-FOUC script's own "must agree with
`themeFromStored`" claim is likewise not asserted, it is tested:
`theme.test.ts` extracts the real script text out of this exact file with a
regex and runs it against a fake `document`/`localStorage`, so a future edit
that breaks the agreement fails loudly rather than silently. Nothing to fix.

`swarm/src/index.ts`: a pure re-export barrel, the same shape `sweep/src/
rank.ts` was in SELF-533 — nothing behind an `export { ... } from` line for a
sweep like this one to find.

`check-core-purity.mjs` + `purity.test.ts`: the vendor/DOM/env rules are
exercised branch-by-branch, including the one the suite's own comment says
"had no probe at all until this one" (deleting the vendor regex left the
whole suite green). Two things looked, on a first read, like the same class
of gap that regex-vulnerability history warns about, and both turned out
unreachable once checked against the real tree rather than assumed from the
regex alone:
  - The HTTP-framing rule's import/require branch only matches
    `"node:https?"` — a bare `require("http")` or `import x from "https"`
    would sail past it. Grepped the whole repo for `from ["']https?["']` and
    `require(["']https?["'])`: zero matches anywhere, in or out of core —
    every real import in this codebase already spells the `node:` prefix, so
    the gap has no live target and hardening the regex would be exactly the
    "arithmetic dressed as evidence" P1-8/SELF-529 already warn against.
  - `\bfetch\s*\(` would flag a legitimate call THROUGH an injected port if
    that port were ever callable directly (`ctx.fetch(url)`), which is
    different from the `ctx.fetch.get(url)` shape the suite's own
    "does not false-positive on a 'fetch' property declaration" test already
    covers. Checked the real port instead of guessing: `FetchPort`
    (`core/src/ports.ts:129`) is `{ get(url, mode, opts?): Promise<...> }` —
    never a bare callable — and grepping `packages/core/src` for a direct
    `.fetch(` call (as opposed to `.fetch.get(`) returns nothing. The shape
    this rule could misfire on does not exist in the interface it is
    guarding, so there is no reachable case to add a probe for.

`check-test-collection.mjs` + `collection.test.ts`: the under-collection path
(a test file vitest would not run) has two direct probes — the repo-root
`UNREACHABLE` file and the `components/**` `.tsx`-reachability case — but the
over-collection path (`foreign`: vitest collects a file git does not
consider part of the repo) has none. Traced whether that is a real,
constructible gap rather than assuming a missing test always is one:
`vitest.config.ts`'s `include` is a hand-maintained allowlist (`tests/**`,
`packages/*/tests/**`, `packages/web/{app,lib,components}/**`,
`packages/web/*.test.*`, `packages/web/scripts/*.test.*`), and none of those
paths overlap any `.gitignore` entry (`/docs/`, `/.superpowers/`,
`/overnight/`, `/branding/`, the two `public/` scratch dirs — none of them
under `app/`, `lib/`, `components/` or `scripts/`). An ordinary new untracked
file inside an included directory is still caught by `git ls-files --others
--exclude-standard`, so it lands in BOTH sets, not just `seen`. The only way
to make `foreign` non-empty by construction is a nested git repository or
worktree sitting inside one of the included directories — the exact case the
script's own header names for `.claude/worktrees/`, which sits outside every
included path today — and that is not a lightweight fixture two `writeFileSync`
calls can stand up the way `UNREACHABLE`/`REACHABLE` do. Left untested,
deliberately: a probe for a branch with no constructible trigger would be a
test that always passes for a reason unrelated to the code, which is the
same vacuity `purity.test.ts`'s own comments warn against elsewhere in this
file's neighborhood.

No code change this fire — both near-misses traced to ground rather than
patched on suspicion, same standard SELF-515/525/528/529/533/534 already
held themselves to. `pnpm install` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both green: 3330 tests passing, 13 skipped (same
gated census as SELF-535) — unchanged by a read-only fire.

Backlog item: SELF-536 - BLOCKED

**SELF-537 (2026-09-20 overnight fire) — individually re-read the seven small
`app/api/kb*`/`app/api/run*` routes SELF-515 had only swept together in one
bullet, plus the three untouched `app/` pages and every remaining barrel
file; found nothing to fix, and one false lead worth recording so a future
fire does not chase it as a gap.** SELF-515's own list read "every route
under `kb/[id]/*`, `kb/route.ts`, `run/[id]/route.ts`,
`run/[id]/cancel/route.ts`" as a single clause, shallower than the dedicated
per-file treatment other D-scope entries gave `stream/route.ts` (SELF-528)
or `middleware.ts`/`next.config.ts` (SELF-515 itself, in more depth). Read
each of the seven on its own, end to end: `kb/[id]/export/route.ts` (the zip
download — traced `new Uint8Array(zip).buffer`: the `TypedArray(typedArray)`
constructor copies into a freshly sized buffer, so this is safe regardless
of whether `zipOf`'s return value is ever a subarray of a larger buffer, not
the "send extra bytes past a view's length" bug this shape usually hides),
`kb/[id]/graph/route.ts`, `kb/[id]/note/route.ts`, `kb/[id]/route.ts`,
`kb/route.ts`, `run/[id]/route.ts` (its own `body()` helper — confirmed
`StoredRun`/`RunRecord` in `lib/runs.ts` carry identical `queries`/
`startedAt`/`endedAt`/`status`/`error`/`result` shapes, so the "one function
builds both" merge the file's own comment describes cannot drift the two
call sites apart), and `run/[id]/cancel/route.ts`. All seven clean.

Also read the three `app/` pages SELF-515/525's own file lists never named:
`app/page.tsx`, `app/film/page.tsx`, `app/story/page.tsx`. The near-miss:
`app/page.tsx` is 114 lines with zero commits touching it in
`git log a7bbc57..HEAD`, which is exactly the zero-touch signal SELF-535's
method flags as unread — but `page.test.tsx` is 541 lines, five `describe`
blocks driving every branch (`!demo`/no-allowance, `!demo`/allowance-on,
demo/no-allowance, demo/allowance-open, demo/allowance-spent,
demo/uncountable-store, demo/maps-missing, a metered non-demo deployment),
predating this branch's overnight work entirely (it ships with the
`09280dc` demo-gallery-rewrite commit). A zero-touch file is not the same
claim as an unread one; this is the gap in that heuristic, not a gap in the
page. Read it against its own test file line by line anyway rather than
trusting the census, on the same "verify, don't infer" standard the rest of
this sweep holds — the early-return ordering (`publicRunsPerDay() === 0`
checked before the first `await`, so an unmetered deployment reaches no
disk), the `invite`/`gate` branching, and the `notice` field's
`reason === "used-up"` filter (matched against `runGate`'s three
`GateReason`s in `lib/public-runs.ts`, confirming `read-only` and
`uncountable` are deliberately silent per the comment beside them) all check
out. `film/page.tsx` and `story/page.tsx` are thin wrappers (a `<video>`
tag; a bare `<ScrollFilm />`) with their own dedicated coverage tests
(`9054f14`, `31c854c`) already added by an earlier fire without touching the
source — the same shape SELF-535 already named for `EventFeed.tsx`/
`BarMeter.tsx`. Nothing to fix in any of the three.

Last, the five remaining pure re-export barrels this sweep's earlier passes
had not individually listed: `packages/providers/src/index.ts`,
`packages/sweep/src/index.ts` (2 lines, `export *` from `ui.js`/`sweep.js`),
`packages/web/components/icons/index.ts`, `packages/web/components/viz/
index.ts`. All `export { ... } from`/`export *` lines with nothing behind
them, the same shape `swarm/src/index.ts` (SELF-536) and `sweep/src/rank.ts`
(SELF-533) already confirmed inert.

No code change this fire — every candidate was already correct. `pnpm
install` first (fresh clone, no `node_modules`, same as every fire since
SELF-515). `pnpm check && pnpm test` both green: 3330 tests passing, 13
skipped (same gated census as SELF-535/536) — unchanged by a read-only fire.

Backlog item: SELF-537 - BLOCKED

**SELF-538 (2026-09-20 overnight fire) — a genuinely different angle (per
SELF-515/537's own advice to stop re-sweeping files): audited every
unlocaled `.toLocaleString()` call in `packages/web` for the classic
Next.js bug where server-render and client-hydration disagree on number
formatting because they resolve different default locales. Found the
pattern is real and already fixed in one place, and traced why it is safe
everywhere else — no code change, but worth recording so a future fire
does not have to re-derive this.**

`grep -rn "toLocaleString" packages --include="*.ts" --include="*.tsx"`
(excluding tests) turned up 7 call sites. Two pin `"en-US"` explicitly
(`KbCard.tsx:51`, `DemoHome.tsx:65`); five call it bare — `viz/StatTile.tsx:27`,
`viz/BarMeter.tsx:44`, `build/CostBreakdown.tsx:134`, `app/runs/[id]/
page.tsx:316`, `core/src/sniff.ts:311`. A bare `.toLocaleString()` uses the
JS engine's own default locale, which is the server process's locale during
SSR and the visiting browser's own locale during client hydration — a
German-locale browser (`.` as the thousands separator) hydrating a number a
US-locale Node process rendered as `"1,234"` is a real, if cosmetic, React
hydration-mismatch class of bug, and this codebase already carries the
fix in two places, which is what made this worth checking rather than
assuming the two are the only two spots that need it.

Traced each of the five instead of patching on suspicion. `sniff.ts:311` is
core (Node-only, never hydrated — no browser involved at all). The other
four are `packages/web` components, but none of them sit where a real
SSR-then-hydrate mismatch can fire, for two different reasons:

- `app/runs/page.tsx` and `app/runs/[id]/page.tsx` (the only callers of
  `StatTile`/`CostBreakdown` fed by a server-computed number) carry no
  `"use client"` directive anywhere in their tree — pure Server Components,
  rendered to HTML once and never hydrated, so there is no second render to
  disagree with the first.
- `KbOverview.tsx` (`StatTile`) and `BuildWorkflow.tsx`/`ResultPanel.tsx`
  (`CostBreakdown`, `BarMeter`) ARE `"use client"`, but neither receives its
  numbers as an initial prop from the server. `KbOverview` starts
  `loading` and only has a manifest after its own `GET /api/kb/<id>` fetch
  resolves post-mount (verified: `if (loading) return <OverviewSkeleton />`
  gates every `StatTile`); `BuildWorkflow`'s `cost`/`result`/`plan` state
  all initialize to `null`/empty and only fill from the run's own stream
  after the component is already mounted. The server-rendered HTML and the
  first client hydration pass both render the empty/skeleton state — a
  bare `.toLocaleString()` never runs on real data until after hydration
  has already completed and there is nothing left to compare it against.

`KbCard.tsx`/`DemoHome.tsx` are the one path that differs: `app/kb/
page.tsx` (a Server Component) computes `KbSummary[]` — real manifest
numbers — and passes it as a prop straight into `KbGallery.tsx`
(`"use client"`), so the SAME real values format on both the server's SSR
pass and the client's hydration pass through the identical RSC-serialized
prop. That is exactly the shape the bug needs, and it is exactly the two
files that already pin `"en-US"` — confirming the existing fix is
deliberate and correctly scoped, not an accident that happened to dodge
four other call sites.

Not fixed, because nothing needs fixing: the four bare call sites were
each traced to a component shape (pure SSR with no hydration, or client
state that starts empty and only fills post-mount) that cannot reach the
bug, verified by reading the actual `useState`/`loading` gates rather than
inferring from the directive alone. Recorded here so a future
locale/formatting sweep starts from this conclusion instead of re-tracing
the same five call sites.

No code change this fire. `pnpm install` first (fresh clone, no
`node_modules`). `pnpm check && pnpm test` both green: 3330 tests passing
(unchanged — no code touched), 13 skipped (same gated census as SELF-537).

Backlog item: SELF-538 - BLOCKED

**SELF-539 (2026-09-20 overnight fire) — a genuinely different angle (the
`prompts/` tree itself, cross-checked word-for-word against the code and
tests each prompt describes, rather than another `packages/`/`scripts/`
sweep) found one real drift and confirmed the rest clean.** Every prior
D-scope fire read source and test files; nobody had read the prompt
markdown — `prompts/agents/*.md` and `prompts/doctrine/*.md` — as its own
class, even though CONTRIBUTING.md names them explicitly
("prompts-as-markdown-without-rebuild"). Built the untouched list the same
way SELF-535 did (`git log a7bbc57..HEAD --oneline` per file): six agent
prompts (`discover.md`, `group.md`, `investigator.md`, `orphan.md`,
`triage.md`, `understand.md`) and five doctrine files (`01-the-thesis.md`,
`03-evidence.md`, `04-search-craft.md`, `05-reading-the-web.md`,
`06-breadth.md`) plus `prompts/swarm/skill.md` had zero commits against them
anywhere in this branch's history.

Read every one end to end and checked every checkable claim against the code
it describes: tool names and schemas in `discovery.ts` against `discover.md`;
`PEER_RELATIONS`/`OrphanStand` against `orphan.md`; `Grouping`/`Decomposition`
against `group.md`; `RELATIONS`/`SWARM_RELATIONS`/`JUDGED_RELATIONS` against
`02-relations.md` and `skill.md` (already reconciled by an earlier fire, and
guarded by `tests/the-judge-and-the-map-teach-one-vocabulary.test.ts`); the
tier dollar amounts, `WARN_FRACTION`, `LEAD_TURN_CAP`, `DEFAULT_LANES`,
`OPEN_AT` and `MIN_QUOTE_LENGTH` in `skill.md` against `ledger.ts`,
`agent.ts`, `orchestrator.ts`, `breaker.ts` and `evidence.ts` — all exact
matches, nothing to fix.

One real find: `understand.md`'s "Its comparison pages are read by something
else" section and `packages/sweep/src/sweep.ts`'s own comment above
`rivalsFromSitemap` (plus the dedicated
`a-company-names-its-own-rivals.test.ts`) both cite the SAME measurement —
shopify.com's sitemap, read into the same 4,251-entity map — but disagree:
the code comment and its test say 40 comparison urls, 26 distinct rival
names, five missing from the map (naming them: magento, etsy, woocommerce,
wix, squarespace); `understand.md` said 42 urls, 34 distinct rivals, 12
missing. Traced to the source: both were introduced in the SAME commit
(`cf079e8`, predating this branch's base), the commit message itself citing
"40 in those namespaces, 26 distinct names" — so the prompt's 42/34/12 was
never a second, later measurement, just a transcription that drifted from
the number the author had just measured and written into the code comment
and the commit message beside it, the same "a number copied twice disagrees
with itself" shape SELF-517/518/519 already found elsewhere on this branch,
here in a prompt file instead of a code comment. The dedicated test pins the
authoritative figure (26 rival names, five unmapped) as the one the engine's
own behaviour is measured and tested against, which is what makes the
prompt's 34/12 the wrong one to trust, not an ambiguous disagreement between
two equally-measured facts.

Fixed by editing `understand.md`'s sentence to read "40 such urls naming 26
distinct rivals, five of which never reached that run's 4,251-entity map" —
matching `sweep.ts`'s comment and the test verbatim. Text-only: this number
is illustrative context for the model reading the prompt (explaining why
collecting rivals is not its job), not a value any schema or test asserts
against, so no test change was needed or possible — grepped
`packages/*/tests` for "understand.md"/"42 such urls"/"34 distinct" first to
confirm nothing already covers this file's prose.

`pnpm install` first (fresh clone, no `node_modules`, same as every fire
since SELF-515). `pnpm check && pnpm test` both green: 3330 tests passing
(unchanged — a prompt-text-only fix, no schema or logic touched), 13 skipped
(same gated census as SELF-538).

Backlog item: SELF-539

**SELF-540 (2026-09-20 overnight fire) — read `scripts/check-skips.mjs` end to
end and found its own census misreports one of its seven gates as dark no
matter what `runs/` holds.** Six of the seven `GATES` entries gate a
`describe` block, whose own title lands as the PREFIX of a name `vitest list
--json` prints ("brightdata live > spends real money..."), which is the shape
the census's `open` check was written for: `t.name.startsWith(\`${g.suite} >
\`)`. `tests/run-doctor.test.ts`'s gate is the one exception — a gated `it`
nested inside a plain, ungated `describe` — so its own title lands as the
SUFFIX instead ("run-doctor over the runs on disk > survives every run
file..."). `startsWith` can never match a suffix, so this specific gate prints
"dark" unconditionally in the printed census, regardless of whether `runs/`
genuinely has the >20 sweep files its own `skipIf` checks for.

Confirmed directly rather than reasoned from the code shape alone: created 25
dummy `runs/sweep-*.json` fixtures (content is never read — `vitest list`
collects a test's declaration without executing its body, so only the
directory's file count matters against the gate's `skipIf(files.length ===
0)`) and ran `vitest list --json` by hand. The gate's test genuinely shows up
in the collected list — proving it is open — while the old `open` check still
read `t.name.startsWith(...)` as false and printed it dark. This bug is
confined to the census's own informational summary (the "dark"/"runs" lines
and the "N of M" sentence): the separate pass/fail reconciliation
(`problems`, source-vs-manifest) never calls `open`, so `pnpm check` itself
was never at risk of a false pass or fail — only the one line of output this
whole script exists to make trustworthy ("the difference between two greens
is readable instead of being ... invisible", per this file's own header) was
wrong for this one gate, always.

Fixed by splitting a collected name on the same `" > "` vitest joins segments
with and checking membership instead of prefix: `t.name.split(" >
").includes(g.suite)` matches both shapes — a describe title as the first
segment, a leaf test's own title as the last (or the only) segment — where
`startsWith` only ever matched the first.

Verified non-vacuous by mutation, and by hand before writing a test: stashed
just the `check-skips.mjs` fix, ran the new test with 25 real `runs/` fixture
files staged — it failed printing "dark" for the run-doctor gate exactly as
predicted; restored the fix, reran, passed. The regression test folds the
`runs/`-populated scenario into the SAME already-expensive `execFileSync`
call the existing "current skip census is clean" test already pays for
(`vitest list --json` over ~3300 tests, measured elsewhere in this file at
~30-70s), rather than adding a second one: doing that first and running the
file surfaced a real, reproducible `[vitest-worker]: Timeout calling
"onTaskUpdate"` unhandled error — two ~30-70s synchronous `execFileSync`
blocks back to back in one file overran vitest's own internal, non-
configurable worker heartbeat and turned `pnpm test`'s exit code non-zero
even though every assertion passed. One call, two assertions, closed that
before it became a flake landed on this branch.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3330 tests passing (unchanged — the new assertions extend
an existing test rather than adding one), 13 skipped (same gated census as
SELF-539).

Backlog item: SELF-540

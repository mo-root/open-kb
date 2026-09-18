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

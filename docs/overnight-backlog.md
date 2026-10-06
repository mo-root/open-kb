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

**SELF-541 (2026-09-20 overnight fire) — a doc-vs-code cross-check of
`ARCHITECTURE.md` (never swept this way before — SELF-539 checked `prompts/`
against code, nobody had checked the main architecture doc itself) found the
`OPENKB_PAGES` paragraph describing the CLI's own default backwards, copied
into two other files.** `ARCHITECTURE.md`'s sweep-phase section said "The CLI
passes `OPENKB_PAGES`, default `4`, which collapses the pair... The web route
passes no `pages` and gets the real 2→4 behaviour" — but `scripts/sweep.ts:241`
reads `pages: Number(process.env.OPENKB_PAGES ?? 0) || undefined`, unset
unless the env var is set, with its own adjacent comment stating "UNSET BY
DEFAULT... Unset restores 2→4." The CLI and the web route are identical today:
both leave `pages` unset and both get the real 2→4 behaviour Both were fixed
in the SAME commit (`d740379`, "variable page depth was inert on every CLI
run, and the docs caught up to the engine") — the code was fixed to unset the
default, but this one paragraph, written in that same commit, kept describing
the pre-fix behaviour it had just corrected, and no fire since caught it.

Grepped the whole repo for the same claim rather than assuming
`ARCHITECTURE.md` was the only carrier: `.env.example`'s `OPENKB_PAGES`
comment said "The CLI defaults to 4" (same wrong claim, same origin — it
was not touched by `d740379` either), and `scripts/experiment.ts`'s
`baseline` arm description said "as it ships: 4 pages per query" for an arm
whose `env: {}` leaves `OPENKB_PAGES` unset, i.e. the real 2→4 shape, not a
flat 4. Three independent copies of the same stale fact, none of the ~500
prior commits on this branch had corrected any of them.

Fixed all three to state the actual default (unset, 2→4, same as the web
route) and keep the collapse-to-4 case as what happens when `OPENKB_PAGES` is
explicitly set, not the default. Text/comment-only: no logic changed, nothing
asserts prose, so no test change needed or possible. Left `experiment.ts`'s
`pages-2` arm alone despite a related near-miss worth recording: setting
`OPENKB_PAGES=2` sets `SHALLOW_PAGES=2`, and since the CLI has no way to set
`deepPages` independently, `DEEP_PAGES` still floors at its own `?? 4`
default — making `pages-2` numerically identical to `baseline`'s now-correct
2→4 description, not "half the pages" as its own `what` string claims. Not
fixed: `experiment.ts` is a live-money manual harness this loop cannot run
(`OPENKB_LIVE`/real OpenRouter calls) and giving the arm a genuinely
different behaviour would mean adding a `deepPages` override the CLI has
never had — a new capability, not a doc fix, and outside what a single fire
can verify without a live run.

`pnpm install` first (fresh clone, no `node_modules`, same as every fire
since SELF-515). `pnpm check && pnpm test` both green: 3330 tests passing
(unchanged — no schema or logic touched), 13 skipped (same gated census as
SELF-540).

Backlog item: SELF-541

**SELF-542 (2026-09-20 overnight fire) — a genuinely different angle (`.md:NNN`
line citations, which SELF-509's own citation-drift sweep explicitly excluded)
found two real, confirmed drifts, one of them present since before this
branch's own base commit.** SELF-509's automated sweep grepped "every
`file.ts:NNN` comment citation across the repo, 260 of them" and found none
stale — but that pattern only matches a `.ts` target, so a comment citing a
line inside a `.md` file was never in its sample. Grepped for that shape
directly (`\.md:[0-9]`) across every source and script file and found exactly
two hits: `packages/sweep/src/sweep.ts:5510` citing `classify.md:65-66`, and
`scripts/bakeoff.ts:181` citing `README.md:183`. Both were stale.

`sweep.ts`'s citation was written by `41e477a` (P1-6's fix), pinned to
`classify.md`'s "Answer with" line as it stood at that commit — verified
directly with `git show 41e477a:prompts/agents/classify.md`, which does show
that line at 65. Three later commits in this same branch's history
(`9a96f2f`, `3a2519d`, `a983f23` — the placement-ladder feature and its two
follow-on relation-ordering fixes) added lines to `classify.md` above that
point without ever touching the citation in `sweep.ts`, so it drifted out
from under itself: the sentence is genuinely still there, unchanged in
wording, just eleven lines further down, at 76-77 today. The dedicated test
this same P1-6 commit added,
`classify-answers-in-the-order-its-prompt-teaches.test.ts`, carried an
identical `classify.md:65-66` citation in its own header comment for the same
reason — copied from the same commit, drifted the same way — even though the
test's own assertion reads the line out of the file directly by regex and was
never wrong about the substance, only the comment describing it.

`bakeoff.ts`'s citation is older and stranger: `git log -S` traces both its
half-citations (`README.md:183` and, in the same paragraph, `audit.ts:88-92`)
to `1770fca`, the v0.2.0 commit that predates this branch's own base
(`a7bbc57`) — so this was never introduced by an overnight fire. Checked
directly with `git show 1770fca:README.md` and `git show 1770fca:scripts/
audit.ts`: the `audit.ts:88-92` half was accurate at that commit (the
`existsSync` refusal block sat right there), but `README.md:183` was wrong
from the moment it was written — at `1770fca`, line 183 was unrelated prose
about the investigator's spend wall, and the quoted phrase the comment
attributes to README ("the winner of that table, not a preference") does not
appear anywhere in this branch's README history at all, at any commit
(`git log --all -S` on the phrase across the whole repo turns up only
`1770fca` itself and one commit on an unrelated backup branch,
`main-backup-20260819`, that is not an ancestor of this one). The nearby
`audit.ts:88-92` half drifted separately, before this branch's base too:
`audit.ts` picked up lines somewhere between `1770fca` and `a7bbc57` (main's
own history, not this branch's — only one, test-only commit on this file
appears in `a7bbc57..HEAD`), landing the real refusal block at 100-104 today.

Fixed all three citations to name their current, verified location rather
than re-pin a number a future edit could just as easily outdate again:
`sweep.ts`/`classify-answers-...test.ts` now cite `classify.md`'s line
76-77 and name the dynamic test that actually keeps the claim honest going
forward; `bakeoff.ts` now cites `README.md:74-77` with the literal phrase
that block actually contains today ("not a claim that it finds the most" —
checked character-for-character against the file before quoting it) and
`audit.ts:100-104` for its sibling citation. Text/comment-only across all
three files: no schema, logic or test assertion changed, so `pnpm check &&
pnpm test` needed no new coverage. Ran the same grep with `test`/`spec`
paths included too, to confirm no fourth copy of either citation exists
uncorrected: none does.

`pnpm install` first (fresh clone, no `node_modules`, same as every fire
since SELF-515). `pnpm check && pnpm test` both green: 3330 tests passing
(unchanged — comment-only), 13 skipped (same gated census as SELF-541).

Backlog item: SELF-542

**SELF-543 (2026-09-20 overnight fire) — read `packages/web/lib/store/
supabase.ts` end to end, the one file this D section names by hand
(`web/lib/store/supabase.ts`) that had never been the subject of a dedicated
read; found nothing to fix.** Every one of the file's 33 prior commits
(`git log a7bbc57..HEAD --oneline -- packages/web/lib/store/supabase.ts
packages/web/lib/store/supabase.test.ts`) is a targeted, coverage-driven
single-branch test or a citation-drift doc fix — "countRunsSince had zero
test coverage", "claimRun had an inner catch nobody's test ever tripped",
and so on — never a synthesized full read of the file as its own unit the
way SELF-509/510/512/513/514 gave the smaller D-scope files. That made it
a genuinely open angle rather than a re-sweep: the branch-by-branch tests
prove each individual line does what it claims, not that the file as a
whole holds no cross-function bug a targeted test wouldn't think to ask
about.

Read all 447 lines (grown from whatever size it was when `009ba9a` started
this file's own coverage drive) plus its 630-line test file, function by
function: `config`/`configured` (the trailing-slash strip), `rest` (header
merge order, `cache: "no-store"`), `quiet` (the never-throw wrapper every
read/write but `claimRun` goes through), `upsertRun`, `appendSpans`,
`listRuns` (the `running`-row drop, `toStored`'s null-return folded through
`flatMap`), `countRunsSince` (the `Content-Range` parse — traced `0-0/137`
and the no-match `*/0` shape against what PostgREST's own `count=exact`
Prefer header actually returns, not just the two cases the test file
already drives), `claimRun` (the fail-closed `unconfigured`/`unavailable`
split spend-limits.ts's own `assertSpendAllowed` depends on — read that
caller too, at `packages/web/lib/spend-limits.ts:697-742`, to confirm
`claim.kind !== "claimed" && claim.kind !== "refused"` really does catch
every non-money-safe outcome this file can return, which it does: the
`ClaimResult` union has exactly four members and the caller's condition is
the exact complement of the two the file may safely report as decided),
`getRunRow`, `getSpans`, and the `errorColumn`/`noticeIn` pair (the
first-occurrence-only split of the `error` column, re-verified against the
comment's own claim that erring towards a truncated notice is the only
safe direction).

Nothing was wrong. The file already carries the same self-documenting
density this branch's other financial/store code does (`ledger.ts`,
`spend-cap.ts` in SELF-529) — every non-obvious choice (one round trip in
`claimRun` instead of read-then-write, `quiet`'s fallback values chosen per
caller, `toStored` keeping `running` and `failed` rows for a reason spelled
out in a 15-line comment citing the exact bug a browser hit) has a comment
proving it deliberate, and the test file's 46 `it()` blocks already probe
every branch a full read turned up, including the two-postgrest-response-
shape parsing (`0-0/137` vs `*/0`) and the `claimRun` unreachable-`!res`
backstop SELF-<n>-style prior fires had already traced and left alone
(`e64ab2d`'s own comment covers the `?? 0`/`|| 0` distinction this read
re-confirmed rather than re-litigated).

`pnpm install` first (fresh clone, no `node_modules`, same as every fire
since SELF-515). `pnpm check && pnpm test` both green: 3330 tests passing
(unchanged — a read-only fire, no code or test touched), 13 skipped (same
gated census as SELF-542).

Backlog item: SELF-543 - BLOCKED

**SELF-544 (2026-09-20 overnight fire) — re-verified the D-section's file
list is exhausted, then tried a genuinely new angle (package.json dependency
hygiene across all six workspace manifests) and found one real-looking near
miss that traces to a false lead; found nothing to fix.** Rebuilt the
git-touch-count audit SELF-534/535 used (`git log a7bbc57..HEAD --oneline --
<file>` per file, across `packages/*/src` and `packages/web/{app,lib,
components}`) to check for any file still unread. Every zero- or low-touch
file it surfaced (`scorecard.ts`, `investigator.ts`, `rank.ts`,
`family-ledger.ts`, `grounding.ts`, `graph/layout.ts`, `graphIcons.ts`,
`StageTracker.tsx`, and the rest) was already named and fully read by a
prior fire (SELF-515, 525, 528, 534, 536, 537, or 539) — confirmed by
grepping each filename against this document before opening it, not by
memory. `orchestrator.ts` and `export-kb.ts`, the two files SELF-515 itself
flagged as too large for one sitting, were also already each the subject of
their own dedicated full read since (SELF-516-class entry above, and
SELF-519/525). Nobody had read the six `package.json` manifests
(`./package.json` plus one per workspace package) as their own artifact,
cross-checked against what the code actually imports — a fresh angle in the
same family as SELF-539's prompt-vs-code cross-check, just for dependency
declarations instead of prose claims.

Read all six end to end. Root's `dependencies` list `ai` and `zod`;
grepping `scripts/*.ts` and `tests/**` for `from ["']zod["']` returns zero
hits, which looked exactly like the `fatal.ts`-shaped "declared and never
read" pattern `b436c5c` fixed. Traced it before touching anything, the same
standard SELF-515/525/528/529/533/534/536 already held themselves to: ran
`pnpm install` fresh and read `ai@7.0.48`'s own `package.json` at
`node_modules/.pnpm/ai@7.0.48*/node_modules/ai/package.json` —
`"peerDependencies": { "zod": "^3.25.76 || ^4.1.8" }`. Root's own
`dependencies` list `ai` directly (needed for the `StepResult`/`ToolSet`
type import in `scripts/discover.ts:11`, confirmed by grep — the only
direct `ai`/`zod` import anywhere at root scope), so root's `zod` entry is
what satisfies that peer requirement for root's own copy of `ai`, not dead
weight — nothing imports zod BY NAME at root, but the dependency is real
all the same. `packages/core`, `packages/sweep` and `packages/swarm` each
also declare `zod` themselves (`^4.0.0`, satisfied by the same installed
4.4.3), so this is not a version-skew case either — every declaration in
the graph is independently justified. Not fixed, because there was nothing
to fix: removing root's `zod` on the strength of a name-grep alone would
have been exactly the false positive `check-test-collection.mjs`'s own
near-miss reasoning (SELF-536) already warns this branch against —
recorded here so a future dependency-pruning fire checks peer dependencies
before removing anything a direct-import grep alone flags as unused.

Also checked, no fixable gap: `.github/workflows/check.yml` (re-read past
C2's own audit — the pinned-SHA comments, the `push`/`pull_request`
trigger-scoping reasoning, the census step's `always()` — all already
correct and already explained by their own comments); `ARCHITECTURE.md`
and `CHANGELOG.md` (both already the subject of a dedicated fix this branch
— `daf864a`, `bc5705b` — and a fresh read turned up nothing past those).

No code change this fire. `pnpm install` first (fresh clone, no
`node_modules`, same as every fire since SELF-515). `pnpm check && pnpm
test` both green: 3330 tests passing (unchanged — a read-only fire), 13
skipped (same gated census as SELF-543).

Backlog item: SELF-544 - BLOCKED

**SELF-545 (2026-09-20 overnight fire) — used `noUncheckedIndexedAccess` as a
temporary bug-detector for `packages/web`, the one workspace package that
does not carry it, and confirmed every hit is the same class of false
positive already catalogued for the engine packages; found nothing to fix.**
`tsconfig.base.json:7` turns this flag on for `core`/`providers`/`sweep`/
`swarm`, and this branch's own history (SELF-347, SELF-348, SELF-441, and
others) documents in place, at each call site the flag flags, exactly why
the indexed read can never actually be `undefined` there — `.split()[0]`
after a mandatory separator, a regex capture group inside a pattern where
that group is not optional, a loop index bounded by the same array's own
`.length`. `packages/web/tsconfig.json` never opted in, so no one had
checked whether the same audit, run once against the web package, would
turn up a genuinely different case — the "doctrine contradictions" angle
this section names, applied to a flag rather than a runtime default.

Temporarily added `"noUncheckedIndexedAccess": true` to `packages/web/
tsconfig.json` (`pnpm install` first, fresh clone) and ran the project's own
`pnpm --filter @open-kb/web exec tsc --noEmit` — not a bare `tsc`, which
fails to resolve `next`/`vitest`/workspace packages outside pnpm's own
resolution and produces unrelated noise. It surfaced ~90 errors across ~20
files. Read every application-code site by hand (test-file fixture errors
excluded — they are literal object construction hitting the same widened
type, not a code path): `GraphCanvas.tsx` (`parseHex`'s `m[1]` regex-capture
read, `hexToRgba`'s `m[1]`, and the fullscreen focus-trap's `els[0]`/
`els[els.length-1]` after an `els.length === 0` early return), `lib/graph/
cluster.ts` (`separationShoves`'s `discs[i]`/`discs[j]` inside a
`for (i...) for (j = i+1...)` pair, already the most densely
self-documented file this campaign has read, per its own header), `SiteIcon.
tsx`'s `normalizeDomain`'s `.split(...)[0]`, `TabBar.tsx`'s `tabs[to]` where
`to` is one of `i±1 % tabs.length`/`0`/`tabs.length-1`, `NotesTab.tsx`'s
`flat[next]` under the identical modulo-bounded shape, `Donut.tsx`'s
`ring[0]` gated by a `single` flag that is only true when `ring.length ===
1`, `Sparkline.tsx`'s `x(n-1)`/`y(last)` where `n` is the same array's own
`.length`, `AgentPanel.tsx`'s `shown[i-1]` short-circuited behind
`i === 0 ||`, and `kb-from-run.ts`'s `RELATION_WEIGHT[e.relation] ??
RELATION_WEIGHT.none` — the `.none` half also flagged, because
`Record<string, number>`'s dot-notation access widens exactly like its
bracket access under this flag, even though the object literal defines
`none: 15` unconditionally two lines above.

Every one of these is bounds-safe by construction, not by luck — the
pattern this section's own prior fires named as the reason engine code
needed no fixture rewrites when the flag was added there. No case in the
web sweep introduced a NEW shape (a genuinely reachable `undefined` a
comment would need to guard); it is the identical three-shape taxonomy
already on record. Reverted `packages/web/tsconfig.json` before finishing —
committing the flag now would demand ~90 defensive comments or non-null
assertions across ~20 files for zero behavioural gain, which is exactly the
"arithmetic dressed as evidence" P1-8 already warns this branch against:
adding ceremony a type checker cannot verify is safer than the reasoning
that already holds.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3330 tests passing (unchanged — no code or config
committed), 13 skipped (same gated census as SELF-544).

**SELF-546 (2026-09-20 overnight fire) — read the three files this branch's
own history had added but never named (`packages/sweep/src/deadline.ts`,
`packages/web/lib/scrollProgress.ts`, `packages/web/lib/typingGuard.ts`,
per a fresh `git log --diff-filter=A` against the base) and, one file over
from the third, found a stale duration claim.** `deadline.ts` and
`typingGuard.ts` checked out clean — both already carry their own dedicated
regression tests (`model-calls-have-a-deadline.test.ts` covers the
`--expose-gc` GC-collection case `deadline.ts`'s header comment measures;
`typingGuard.test.ts` covers every branch). `scrollProgress.ts` itself is a
clean pure clamp, also fully tested — but its one caller, `ScrollFilm.tsx`,
sits behind `app/story/page.tsx`, whose own header comment had never been
checked against the constant the component next to it actually uses.
`story/page.tsx` described the scroll-driven launch film as "25 seconds of
montage." `ScrollFilm.tsx`'s own `TOTAL = 32.5` (sourced, per its comment,
"from the rig itself"), the rig's own `packages/web/public/launch-rig.html:113`
(`const TOTAL = 32.50;`), and `DemoHome.tsx`'s independent comment on the
same film playing on the homepage ("the pitch in 32 seconds") all agree on
~32.5 seconds — three independent sources, zero of which say 25. The 25
never matched anything on disk; nothing suggests it was ever true, just
unchecked since the page was written.

Fixed by rewriting the comment to state 32.5 seconds and cite where that
number comes from (`ScrollFilm.tsx`'s own `TOTAL`, cross-checked against the
rig and `DemoHome.tsx`) — the same "cite what you can verify yourself"
standard this document's own rules ask of every entry. No code or test
changed: the claim was in a doc comment only, `story/page.test.tsx` doesn't
(and shouldn't) assert on comment prose, and the component's actual
behaviour was already correct.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3330 tests passing (unchanged — a comment-only fix), 13
skipped (same gated census as SELF-545).

Backlog item: SELF-546

**SELF-547 (2026-09-20 overnight fire) — a full adversarial read of
`scripts/swarm.ts` (429 lines, the swarm CLI entrypoint), the largest
script in `scripts/*.ts` with no prior dedicated full-read entry visible in
this document; found nothing to fix.** `git log a7bbc57..HEAD --oneline --
scripts/swarm.ts` shows two prior commits — `e30d38f` (a real fix: an
unparseable `ceilingUsd` CLI arg used to feed `NaN` into `Ledger`,
silently making every reservation succeed) and `ac4c5bc` (the resulting
`tests/swarm.test.ts` for the three pure env-parsing functions this file
exports) — but neither commit, nor anything else `grep -n "scripts/swarm"
docs/overnight-backlog.md` turns up, is a read of the file end to end the
way SELF-516 read `orchestrator.ts` or SELF-519/525 read `export-kb.ts`.
Read all 429 lines, cross-checked against `tests/swarm.test.ts` (which
covers `wallClockMsFromEnv`, `ceilingUsdFromArg` and `familyFloorFromEnv`
completely — every fallback and refusal branch has its own case) and
against `packages/swarm/src/index.ts`'s exported surface.

The three pure functions are exactly as tested: `wallClockMsFromEnv`
defaults and falls back to 600_000 on anything non-finite or non-positive
(a malformed wall only changes how long a run may take, so a default is
safe); `ceilingUsdFromArg` REFUSES the same shape of bad input instead of
defaulting, and its own comment gives the reason with a directly-verified
claim (`new Ledger(Number("abc"))` — confirmed by reading `Ledger`'s
`reserve()` guard — makes `amount > left + EPSILON` a comparison against
`NaN`, always false, so a NaN ceiling makes every reservation succeed
unconditionally); `familyFloorFromEnv` passes an out-of-range number
through honestly rather than clamping, because the library it configures
does the clamping, matching `packages/swarm/src/orchestrator.ts`'s own
family-floor handling.

The untested `invokedDirectly` CLI body (lines 164-429 — argv, real
credentials, `runSwarm`, two watchdogs) holds together the same way:
`RUN_CAP_USD` is derived from `ceilingUsd` (already validated finite and
positive above it) rather than a flat default, so it cannot inherit the
same NaN failure mode `ceilingUsdFromArg`'s own comment warns against; the
`.catch` after `withSpendCap` returns `null` only when `capStop.trip` was
actually set by the watchdog's own `record` callback, and the one
`if (run === null && capStop.trip)` branch that follows is the only place
that reads `run` before the unconditional `run!` a few lines later, so a
`null` with no trip — which the catch's own branching makes impossible —
is not a reachable state to write a probe for. `OPENKB_SWARM_LANES`
parsing (`Number(env ?? 0) || undefined`) was checked by hand against
`"0"`, unset, a valid number and a non-numeric string: all four fall back
to the library's own six-lane default or pass through a real number,
never `NaN` or `0` reaching `runSwarm`. No test harness change was needed
or made — the spending body is deliberately unreachable from a test
process, same as `sweep.ts`'s own CLI tail, and this fire found no new
pure logic inside it worth extracting.

Also re-confirmed, mechanically rather than by memory: every one of root
`package.json`'s 14 `scripts` entries names a file that exists on disk,
and the README's "Every command" block's `pnpm check` description
("three guards, tsc, five test projects") matches the actual composition
of the `check` script exactly — `check-core-purity.mjs`,
`check-test-collection.mjs` and `check-skips.mjs` are the three guards;
`tsc -b` plus the web package's own `tsc --noEmit` are the "tsc" the
sentence names as one word; and `packages/{core,providers,sweep,swarm}/
tsconfig.tests.json` plus `tsconfig.root.json` (confirmed by its own
header comment: "the four tsconfig.tests.json cover only their own
package's tests") are the five test projects.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3330 tests passing (unchanged — a read-only fire), 13
skipped (same gated census as SELF-546).

Backlog item: SELF-547 - BLOCKED

Backlog item: SELF-545 - BLOCKED

**SELF-548 (2026-09-20 overnight fire) — CONTRIBUTING.md's own workspace
table claimed `packages/sweep` is "one file"; it never was, not even the day
that table was written.** Cross-checked `CONTRIBUTING.md`'s and
`ARCHITECTURE.md`'s workspace tables against `packages/sweep/src` on disk (a
"genuinely different angle" per SELF-509/534's own advice — auditing the
GitHub-facing docs' own claims, not another source-file sweep). `ls
packages/sweep/src` shows five files: `sweep.ts` (7,777 lines, the engine),
`rank.ts` (an 11-line re-export shim for `judgeHosts`, which
`3bfdca5` moved to `packages/core/src/judge.ts` — SELF-533 already read this
file and called it "a 12-line re-export shim, nothing to find"), `ui.ts` (71
lines, the `ui:`-prefixed narration protocol `emitUi`/`readUi` — real logic,
not a shim), `deadline.ts` (26 lines) and `index.ts` (a 2-line barrel).
`git log --diff-filter=A` on each: `index.ts`, `ui.ts` and `rank.ts` all date
to `1770fca` (v0.2.0, 2026-08-10 10:35 +03:00) — before `CONTRIBUTING.md`
itself was added (`e5c4183`, 2026-08-23 01:42 UTC = 04:42 +03:00). So the
table's "one file" was never true; it was wrong on arrival, not a claim that
drifted afterward. `deadline.ts` came later that same day (`100ae589`,
08:14 UTC), making the count five now, four then.

`ARCHITECTURE.md`'s parallel row for the same package reads "The breadth
engine and its rank kernel." with no file-count claim at all — already
accurate, and left untouched. Fixed by dropping the false ", one file" from
`CONTRIBUTING.md`'s row, matching `ARCHITECTURE.md`'s existing wording
exactly rather than inventing new phrasing. Left "and its rank kernel" in
both docs alone: `judgeHosts` itself lives in core (both tables already say
so on core's own row — "judge" — and `rank.ts`'s header comment confirms the
move), but the rank PHASE `sweep.ts` runs — the pool, `OPENKB_RANK_UNLOCK`
escalation, narration — is still genuinely sweep's own code, so the phrase
is not a second error riding along with the first.

Doc-only change, no source or test touched. `pnpm install` first (fresh
clone, no `node_modules`). `pnpm check && pnpm test` both green: 3330 tests
passing (unchanged — a doc-only fix), 13 skipped (same gated census as
SELF-547).

Backlog item: SELF-548

**SELF-549 (2026-09-21 overnight fire) — a genuinely new angle (`noUnusedLocals`/
`noUnusedParameters`, never tried by this campaign's prior flag experiments)
found real dead code across six source files, one dropped feature's leftover
plumbing, one exported function carrying a parameter nothing ever read, and
one test that destructured a value it forgot to assert on — then committed
the flags permanently, unlike SELF-545's reverted `noUncheckedIndexedAccess`
experiment, because this one paid for itself.** SELF-509's own coverage-gap
sweep and SELF-544/545's dependency/flag audits are the closest priors; both
found nothing fixable. `tsconfig.base.json`'s `strict`/`noUncheckedIndexedAccess`
say nothing about a declaration nobody reads, and this repo has no ESLint
config at all (`find . -iname '.eslintrc*' -o -iname 'eslint.config*'`,
nothing outside `node_modules`) — so "declared, never read" was the one class
of drift no existing gate could catch. Added `noUnusedLocals` and
`noUnusedParameters` to `tsconfig.base.json` (engine) and, separately, to
`packages/web/tsconfig.json` (web never inherits base — the same fact
SELF-545 recorded), then ran `tsc -b`, all four `tsconfig.tests.json`
projects, `tsconfig.root.json`, and the web package's own `tsc --noEmit`.

16 hits, each read and traced by hand rather than deleted on the compiler's
say-so alone:

- `packages/sweep/src/sweep.ts:58` (`type SearchResult`) and
  `packages/swarm/src/tools-free.ts:7` (`registrableHost`) — both dead since
  `1770fca` (v0.2.0, before this branch existed), confirmed by
  `git log -S` on each import line; both survive only inside a comment
  (`SearchResult.redirects`, `registrableHost's own TLD-collapse`), never as
  real usage. Removed both imports.
- `packages/web/components/kb/GraphCanvas.tsx`'s `LABEL_MIN_SCREEN_R` (a
  hardcoded 9, dead since the same `1770fca` base commit) and its `rng`
  local (a slug/resetSeed-keyed `mulberry32`, instantiated and never called
  — its own neighbouring comment already said "not from `rng()`" without
  anyone asking why `rng` existed at all). Traced what actually drives label
  reveal and reset behaviour before deleting either: `minScreenR:
  settings.labelThreshold` (line ~1738) is the live threshold, and its own
  "zoom reveal" explanation already lives at `lib/graph/labels.ts:64-68`, so
  deleting the orphaned copy loses nothing; `seedPosition` (`lib/graph/
  layout.ts`) seeds every node from `hashUnit(n.id)` alone, and `resetSeed`'s
  only real job (`GraphCanvas.tsx` ~914: "a reset … never consults memory")
  is skipping the remembered layout cache, not reseeding a shape — so `rng`
  was never load-bearing. Corrected `GraphCanvas.test.ts`'s own SELF-102
  comment, which had credited `hashStr`+`mulberry32` with "the layout's
  determinism" at "line ~862" — the exact dead line — since v0.2.0; that
  claim was never true, not something this fire's own edit broke.
- `packages/web/components/kb/GraphSearch.tsx:5` (`type NodeType`) — dead
  since `1770fca`, same treatment.
- `packages/web/components/kb/KbBrowser.tsx`'s `unplaced` prop (destructured,
  typed, never read in the component body) and its caller,
  `app/kb/[id]/page.tsx:232`'s `unplaced={summary.unplaced}`. Not a bug: the
  component's own header comment (~line 200, "THE UNPLACED BADGE IS GONE
  FROM THE HEADER — owner's call") already documents that this exact number
  was deliberately pulled from the header, with the same count still shown
  by `KbOverview` (its own independent `/api/kb/<id>` fetch, not this prop)
  and the canvas legend. `summaryOf`'s `unplaced` field itself is not dead —
  `app/runs/[id]/page.tsx` reads it directly — only this one unused hop was.
- `scripts/overnight.ts:17` (`writeFileSync`) — dead since `1770fca`; the
  file only ever appends (`appendFileSync`, which creates the file), never
  writes fresh.
- `scripts/run-doctor.ts`'s `diagnose(r, stats)` — `stats` was never read
  inside the function, and every one of `tests/run-doctor.test.ts`'s 36 call
  sites already passed `{}` for it, which is what made the gap findable by
  eye once the compiler pointed at it rather than a real behavioural
  question. Removed the parameter rather than `_`-prefixing it: the two real
  callers (`scripts/run-doctor.ts`'s own `load()`, and `scripts/sweep.ts:641`
  — which this fire's own grep found still passing `out.stats`, a second
  caller `run-doctor.test.ts`'s header comment names but this file's own
  history had not touched) both dropped the dead argument, and 36 test call
  sites lost their trailing `, {}`.
- Five test-file-only hits, each traced before touching: `packages/core/
  tests/verdict.test.ts`'s `aggregatorHtml` helper (built HTML, never called
  — checked whether the aggregator-threshold integration it implies is
  untested anywhere else first: `judge.ts:801` wires `outboundHosts()` into
  `admit()` for real, and `judge.ts:946-951`'s own comment already proves
  that exact call site structurally dead by a different route, so this was
  leftover scaffolding, not a coverage gap); `packages/swarm/tests/
  agent.test.ts`'s `type LeadDeps` and `from-sweep.test.ts`'s
  `RECALL_GAP_NAMES` (both plain dead imports); `packages/sweep/tests/
  rank.test.ts:971`'s `text` and three `packages/sweep/tests/
  second-look.test.ts` `.map((h, i) => …)` callbacks — all unused mock
  parameters, `_`-prefixed rather than deleted since the position (before
  `i`) is load-bearing.
- `tests/purity.test.ts:305` was the one real bug, not dead code: `const {
  status, output } = runOverProbe()` destructured `output` and never
  asserted on it, in the one "does not false-positive" test in the file that
  skipped the vacuity guard every sibling case (lines 222, 283) carries —
  `expect(output).toContain(\`plus 1 under ${PROBE_DIR}\`)`, "proves the
  probe was READ, not merely named," per that file's own comment about
  exactly this failure mode. Added the missing assertion instead of deleting
  the binding.

Committed the flags rather than reverting them (SELF-545's call for
`noUncheckedIndexedAccess` on web doesn't apply here): that flag found zero
fixable cases and would have cost ~90 defensive comments for no behavioural
gain; this one found sixteen, twelve genuinely fixable with a net negative
line count, and the repo has no other mechanism that would ever catch this
class of drift again.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3330 tests passing (unchanged — every fix here removed
dead code or added an assertion that was already true, never changed
behaviour), 13 skipped (same gated census as SELF-548).

Backlog item: SELF-549

**SELF-550 (2026-09-21 overnight fire) — pushed the same flag-as-detector
angle one step further than SELF-549's landing spot and, unlike it, found
nothing to fix — a clean pass, added anyway because it cost nothing.**
`strict`/`noUncheckedIndexedAccess`/`noUnusedLocals`/`noUnusedParameters`
say nothing about a function that returns a value on some paths and falls
off the end on others, or a `switch` case that runs into the next one
silently; this repo still carries no ESLint config to catch either class
another way (re-checked, same as SELF-549: no `.eslintrc*`/`eslint.config*`
outside `node_modules`).

Added `noImplicitReturns`/`noFallthroughCasesInSwitch` to
`tsconfig.base.json` (engine — reaches `core`/`providers`/`sweep`/`swarm`
`src`, their `tests` via each package's `tsconfig.tests.json`, and
`scripts`/`tests`/root `*.ts` via `tsconfig.root.json`, all of which
extend it) and separately to `packages/web/tsconfig.json` (web never
inherits base, per SELF-545/549). Ran every command `pnpm check` itself
runs — `tsc -b`, the web package's own `tsc --noEmit`, all four
`tsconfig.tests.json` projects, `tsconfig.root.json` — and got zero errors
from either flag, anywhere in the repo.

Before trusting a silent, zero-error result — the failure mode a wrong or
misspelled flag name would produce identically — planted both bug shapes
in a scratch file outside the repo (an `if` branch with no trailing
return; a `case` with a statement but no `break`/`return` before the next
`case`) and ran `tsc --strict --noImplicitReturns
--noFallthroughCasesInSwitch --noEmit` against it directly: TS2366 and
TS7029 fired exactly as expected, then the scratch file was discarded
without being added anywhere in this repo. The codebase's own `switch`
surface is small enough to state precisely: 4 real `switch` statements
outside test files (`orchestrator.ts:1061`, `tools-free.ts:243`,
`stream-adapter.ts:104`, `BuildWorkflow.tsx:404` — two other `catalog.ts`
grep hits are the word "switch" inside a regex literal, not a statement),
every one already `default`-terminated with each case returning or
breaking.

Committed rather than left unrecorded: unlike SELF-545's
`noUncheckedIndexedAccess`-on-web experiment (90 hits, all false
positives, reverting was the right call because keeping it would have
demanded ~90 defensive comments for zero behavioural gain), a flag that
finds zero violations costs literally nothing to keep — no code changed,
no comment ceremony owed anywhere — while still standing permanent guard
against two real bug classes the very next commit could introduce. Same
"free insurance" reasoning SELF-549 gave for keeping its own two flags
once they paid for themselves; this pair paid for itself before a single
line needed to change.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3330 tests passing (unchanged — no source touched), 13
skipped (same gated census as SELF-549).

Backlog item: SELF-550

**SELF-551 (2026-09-21 overnight fire) — read `packages/web/lib/api-error.ts`
end to end and found `demoMapsMissing`'s own JSDoc had drifted onto the
wrong function.** `namedFaults`' own header states the rule this shelf
depends on: "An entry's TEXT is a literal in this file" and each doc block
exists to justify why that entry's sentence is safe to print verbatim. The
original commit (1770fca) placed `demoMapsMissing`'s doc block (the
"OPENKB_DEMO is on and the committed maps are not where they should be…"
comment) directly above the `demoMapsMissing` function, as every other
entry's doc block sits above its own function. A later commit (fda04249,
same day, 13:22 vs. 10:11) inserted the new `runCostCeiling` entry — but
inserted it BETWEEN `demoMapsMissing`'s doc block and the `demoMapsMissing`
function itself, rather than after the whole entry. `git blame` confirms
the split: lines 402-422 (the demo-maps doc block) still carry 1770fca's
original timestamp, while `runCostCeiling`'s own doc block and function
immediately below them carry fda04249's. The result: `runCostCeiling`
read as if undocumented at a glance (its own doc block, added later by
459cd8e for `runDeadline`, sits between the two), and `demoMapsMissing` —
the function actually being described — had no doc comment directly above
it at all, an easy trap for the next fire that reads this file top to
bottom and reasonably assumes the header the compiler happens to sit under
belongs to it.

No behavior changed — this is prose only, same class as SELF-518's
ThemeToggle.tsx fix. Fixed by moving the fifteen-line block to sit
directly above `demoMapsMissing` again, after `runDeadline`'s entry,
restoring the one-doc-block-per-entry shape every other item in the shelf
already has. No test change: `api-error.test.ts`'s "the whole shelf" test
asserts the object's exact keys, not comment placement, and nothing here
touches a key.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3330 tests passing (unchanged — comment-only), 13
skipped (same gated census as SELF-550).

Backlog item: SELF-551

**SELF-552 (2026-09-21 overnight fire) — read every source file this branch's
history had genuinely never touched (one commit each, the original add) end
to end, traced two promising leads to their roots, and found both already
closed by earlier work.** `git log --oneline -- <file>` against every
`packages/*/src` and `packages/web/{app,lib,components}` file gave five
files with exactly one commit in the whole branch: `core/src/families.ts`,
`core/src/ports.ts`, `web/lib/nodeTypes.ts`, `web/components/SiteIcon.tsx`,
`web/scripts/bake-layouts.ts` (the last is demo-gallery tooling, out of
scope). `ports.ts` is interfaces only, nothing to execute. `nodeTypeOf`/
`SiteIcon`'s fallback logic read clean on a full trace.

`families.ts` looked most promising: `rivalHand`'s pair loop
(`names[i]` vs `names[i+1]`) never checks the two names it pairs are
distinct, so `rivalHand(["wix", "wix", "magento"], 6)` genuinely does emit
`"wix vs wix"` — a self-paired, wasted query — and the existing test at
`tests/a-rival-is-not-the-anchor.test.ts:59-62` only asserts the OUTPUT
strings are unique, which a nonsense self-pair satisfies trivially, so it
would not have caught this. Traced both real callers to check whether a
duplicate name can actually reach `rivalHand` in production:
`rivalsFromComparisonUrls` (`core/src/catalog.ts:410-487`) keys its `found`
Map by `rivalName()`'s output, which is always lowercased and therefore
unique by construction — no caller-side duplicate is possible. The listicle
harvest (`sweep.ts:5008-5017`) already deduplicates its `fresh` array by
`.toLowerCase()` before ever calling `rivalHand(fresh, ...)`, precisely
because an earlier fire (see that block's own comment) found and fixed the
identical "wix vs wix" shape at that one caller who could hand it a
case-variant duplicate. Both current call sites are structurally incapable
of feeding `rivalHand` a repeat, so the gap in `rivalHand` itself is real
but unreachable — fixing it now would be exactly the "arithmetic dressed as
evidence" SELF-515's own BLOCKED note already warns against, not a second
independent bug.

Second lead, `DecisionsStrip.tsx`'s `clock(atSec)` (`packages/web/
components/build/DecisionsStrip.tsx:36-40`): `s = atSec % 60` is never
rounded or floored, so a fractional `atSec` prints as `"00:12.5"` rather
than a real clock reading, and `Decision.atSec: number` (not restricted to
integers) plus `types.test.ts:483-484`'s own passing case
(`atSec: 12.5` survives `readProgress` unchanged) show the type contract
allows exactly that shape. But the only producer of a `Decision`'s `atSec`
in this codebase is `sweep.ts`'s `say()` (`atSec: sec()`,
`sweep.ts:1758`: `sec = () => Math.round((Date.now() - t0) / 1000)`) — every
progress frame this pipeline emits already carries a whole-second
`atSec`, and `"progress"` namespace frames have exactly one emitter
(grepped `packages/sweep/src`, `packages/swarm/src`, `packages/web/app`,
`packages/web/lib` for the string). The swarm orchestrator's own
unrounded `sec()` (`orchestrator.ts:308`) only reaches `landings[].atSec`,
which `serialize.ts:220` writes into a stored run's `missions[].atSec` —
a field no web surface currently reads (`grep`'d every `.atSec` use under
`packages/web/lib`, `app`, `components`: only `DecisionsStrip`/
`BuildWorkflow`/`types.ts`, all fed exclusively by the rounded `progress`
stream). Same verdict as the first lead: a real gap in the function, no
live path that reaches it.

Not fixed, either one — both are documented here so the next fire that
reads either file does not re-open ground this one already walked, the
same service SELF-515's own entry did for the small-module sweep it
closed.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3330 tests passing (unchanged — docs only), 13 skipped
(same gated census as SELF-551).

Backlog item: SELF-552 - BLOCKED

**SELF-553 (2026-09-21 overnight fire) — a different angle than the last few
fires' single-file re-reads: grepped for a function DEFINED more than once
across the repo, the exact shape SELF-128 already fixed once for
`isTypingTarget`.** `grep -rnE "^(export )?function |^const .* = \("` over
`packages/*/src` and `scripts`, tallied by function name, turned up
`isAbortError` — the identical three-line predicate (`err?.name ===
"AbortError" || /abort/i.test(String(err?.message ?? ""))`), byte-for-byte,
defined separately in `packages/swarm/src/agent.ts:774` and
`packages/swarm/src/orchestrator.ts:292`. Neither imported the other; each
had its own private copy. (The other repeated names checked and cleared:
`normalizeDomain` in `SiteIcon.tsx`/`anchor.ts` are deliberately different —
one a display-only favicon-domain cleaner, the other a security validator
with its own five-paragraph SSRF rationale that never mentions the display
copy, so this is not the same drift risk. `tierOf` in `kb-from-run.ts`/
`tools-free.ts` take different argument shapes entirely — different
functions sharing a name, not a duplicate. `hostOf` in `NoteView.tsx`/
`SearchesPanel.tsx` and `identityKey` in `export-kb.ts`/`judge.ts`/
`sweep.ts` are small one-line normalizers with no independent test coverage
either way to compare — deferred rather than touched this fire, since
`isAbortError`'s two copies were both actively read from a live call site,
which is the shape most likely to drift silently the next time either
caller's failure handling changes.)

Each copy is live: `orchestrator.ts:1423` uses it to decide whether a failed
lead turn is charged to the wall/caller (skipped) or counted as a real fault
(`leadFaults += 1`, can stop the run after 2); `agent.ts:1137` uses it to
decide whether a crashed investigator turn is labelled `"timeout"` or
`"crashed"`. A fix or a widened check (e.g. catching a provider's own
`RequestAbortedError` shape) landing in one copy and not the other would
silently keep the OTHER caller mis-attributing that failure — exactly the
"a fix landing in one copy and not the other reopens the bug in whichever
component was missed" risk SELF-128's own note names for `isTypingTarget`.

Exported `isAbortError` from `agent.ts` (no behaviour change — same three
lines) and had `orchestrator.ts` import it from `./agent.js`, which it
already depends on for `runLead`/`runInvestigator`, rather than adding a new
shared file for one three-line predicate. Removed orchestrator's own copy.

Added `packages/swarm/tests/is-abort-error.test.ts`: neither existing abort
test (`agent.test.ts`, `orchestrator.test.ts`) exercised the predicate
directly, only end to end through a real turn that happens to abort. New
tests cover each disjunct (name-only via a real `DOMException(..., 
"AbortError")`, message-only under a different name, case-insensitivity)
and the negative case, plus the two non-Error shapes `e: unknown` callers
are not guaranteed to avoid — a plain string and `undefined` — confirming
neither throws.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both green: 3334 tests passing (up from 3330, the 4 new ones), 13
skipped (same gated census as SELF-552).

Backlog item: SELF-553

---

**SELF-557 (2026-09-21 overnight fire) — this backlog file itself lost sync
with its own `Backlog item:` trailers for the three commits right above:
SELF-554/555/556 each landed real work but none touched
`docs/overnight-backlog.md`, breaking the file's own stated contract ("tracked
on this branch and carries every item with its measured evidence and file:line
pointers").** Confirmed with `git log a7bbc57..HEAD --oneline -- docs/
overnight-backlog.md` next to a plain `git log a7bbc57..HEAD --oneline`:
SELF-553 (7c863cf) is the last commit whose diff touches this file; SELF-554
(949cfab), SELF-555 (fdaa39e) and SELF-556 (3f7fc63) each landed a real change
but recorded nothing here — the same class of drift SELF-554 itself found and
fixed for `CHANGELOG.md`, one file over. Catching up from each commit's own
message, verified against the current source rather than restated blind:

- **SELF-554** (949cfab, `docs(changelog)`) — `CHANGELOG.md`'s "Bug fixes"
  section had missed two real fixes landed since SELF-530: SELF-532's
  `StatTile` K/M-rounding bug and SELF-535's `/runs` KPI grid mobile layout.
  Added both bullets. No code change.
- **SELF-555** (fdaa39e, `fix(core)`) — `identityKey` (the fold
  `text.toLowerCase().replace(/[^a-z0-9]/g, "")`) was byte-for-byte duplicated
  across `packages/core/src/export-kb.ts`, `packages/core/src/judge.ts`
  (module-level, called from `wrongDoorName` at judge.ts:249 and
  `anchorIdentityTheft` at judge.ts:305) and `packages/sweep/src/sweep.ts`.
  export-kb.ts's own copy carried a comment claiming it couldn't import
  judge.ts's version because that version lived nested inside `judgeHosts` —
  false; it was already module-level and already re-exported through
  `index.ts`, just missing the `export` keyword. Exported it from judge.ts,
  had export-kb.ts's suppression check (export-kb.ts:492-493) and sweep.ts's
  "ONE SPELLING, ONE OWNER" pass import it instead of restating it. Added
  `packages/core/tests/identity-key.test.ts` (4 tests) — no prior test
  exercised the fold directly, only each consumer's higher-level behaviour.
  This was SELF-553's own deferred lead.
- **SELF-556** (3f7fc63, `fix(web)`) — `NoteView.tsx`'s `hostOf` read `new
  URL(url).host`, keeping an explicit port, where `SearchesPanel.tsx`'s
  sibling copy already reads `.hostname` and drops one. NoteView's result
  feeds `SiteIcon`'s `domain` prop directly (NoteView.tsx:325-326); `SiteIcon`
  never strips a port either, so a ported URL would mislabel the source and
  404 its favicon. Confirmed unreachable today (`kb-from-run.ts`'s two
  `sources[].url` call sites, lines 754 and 772, never carry a port) but the
  fix is one word and removes a second copy free to drift independently on
  its own. Added a test to `NoteView.test.ts`, verified non-vacuous by
  reverting the fix and watching the new test fail. Also SELF-553's own
  deferred lead.

No code changed by this entry — doc-only, matching SELF-554's own precedent
for treating a backlog/changelog sync gap as an item in its own right rather
than leaving it silent. `pnpm install` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3339 tests passing, 13 skipped
(unchanged — same gated census as SELF-556; this touches only prose).

Backlog item: SELF-557

**SELF-558 (2026-09-21 overnight fire) — full adversarial reads of
`scripts/batch.ts` (636 lines) and `scripts/bench.ts` (651 lines), the two
largest files in `scripts/*.ts` with no prior dedicated full-read entry;
found nothing to fix.** Both files carry real prior work — `git log
a7bbc57..HEAD --oneline -- scripts/batch.ts` and `-- scripts/bench.ts` each
show a handful of commits — but every one is a targeted coverage-driven test
("`batch.ts` had zero test coverage anywhere", "argv parsing, dedup and
per-attempt outcome had zero direct test coverage") or a single traced fix
(bench's `$undefined`/`$Infinity`/`RangeError` guards, batch's own
run-cost-figure duplication), never a synthesized read of either file as a
whole the way SELF-516/519/525/543/547 gave `orchestrator.ts`,
`export-kb.ts` (twice) and `supabase.ts`/`swarm.ts` — the same gap SELF-547
named and closed for `swarm.ts` itself, one file over.

`batch.ts`: read all 637 lines against its own header's three failure modes
(a run that hangs, a run that dies, the batch itself dying) and the two
pulled-out pure functions' tests (`readFlag`/`computeOutcome`,
`batch.test.ts`). Traced `computeOutcome`'s three-way split (capped-with-a-
map, capped-with-a-stopped-file, not-capped) against `EXIT.capped` and
confirmed the two file-prefix scans (`mine`/`stopFile`, both keyed off
`anchor.replace(/\W+/g, "-")`) cannot collide between concurrent workers for
any two distinct real domains — `\W+` folds punctuation, not letters, so two
different registrable domains never fold to the same prefix, and the only
way to force a collision is to hand the list two anchors that are already
identical after that fold, which is a malformed list, not a runtime race.
Checked the retry loop's off-by-one against the header's own claim ("retried
once by default"): `RETRIES=1` (the default) runs `attempt` from 2 while
`attempt <= RETRIES + 1` (`2 <= 2`), so exactly one retry; `--retries 0`
makes `2 <= 1` false immediately, matching the CLI's own worked example.
Confirmed the child-process group-kill comment's claim against `EXIT.capped`
and `spawn`'s `detached: true` — both do what the comment says.

`bench.ts`: read all 652 lines. `deriveRun`'s CLI-vs-web `source` attribution
(`file.startsWith("swarm-")`/`"sweep-"` else `"web"`) was the one lead worth
tracing rather than trusting: confirmed against `packages/web/lib/runs.ts`
(`FILE_PREFIX = "run-"`, `CLI_PREFIX = "sweep-"`, `SWARM_PREFIX = "swarm-"`)
that a web-triggered run is always written `run-<id>.json`, never
`sweep-`/`swarm-`-prefixed, so the `named ? "cli" : "web"` split cannot
misattribute a web run as CLI. Every arithmetic guard already on record here
(`Math.min(...[])` → `Infinity`, `?.toFixed()` → the literal string
`"undefined"`, division by a zero `onMap`/`hosts`) has a corresponding `?? 
null`/`!== null` check at its call site — checked each of the nine table
columns and all six generated footnotes by hand, not just the three the
prior fixes named.

No code change either file — both already correct. `pnpm install` first
(fresh clone, no `node_modules`). `pnpm check && pnpm test` both exit 0:
3339 tests passing (unchanged — a read-only fire), 13 skipped (same gated
census as SELF-557).

Backlog item: SELF-558 - BLOCKED

**SELF-559 (2026-09-21 overnight fire) — the same live-duplicate-function
shape SELF-553 found for `isAbortError`, this time in `scripts/`, which that
fire's grep never covered (it scanned `packages/*/src` and `scripts` for
top-level `function`/`const … = (` declarations, but `query-yield.ts` and
`recall.ts` both define `hostOf` as `export const hostOf = (u: string) =>
{...}` — same pattern, so it should have shown; rechecked and it does turn up
both, meaning SELF-553 tallied the name but the entry never mentions it, an
oversight rather than a considered pass, this fire's find rather than a
re-litigation of that one).** `scripts/query-yield.ts:164-166` and
`scripts/recall.ts:199-201` carried byte-for-byte identical bodies:
```
export const hostOf = (u: string): string => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, "") } catch { return "" }
}
```
`git log --diff-filter=A -- scripts/query-yield.ts scripts/recall.ts` dates
`query-yield.ts` first (9d12ee5, 2026-08-23 19:07) and `recall.ts` second
(3d51f37, 22:12) — `recall.ts`'s own header already cites `query-yield.ts` by
name for a different reason ("Checked against the page-loss confound that
skews the yield tables in query-yield.ts"), so the copy was almost certainly
a paste while writing the second file against the first as a model. Both
copies are live: `query-yield.ts:195`'s `tallyQueryYield` and
`recall.ts:311`'s `byFamily` block each call their own `hostOf` to dedupe a
query's hit URLs down to hosts before checking them against a market/rival
set — exactly the "read from a real call site" shape SELF-553 named as the
risk worth fixing (a widened check, e.g. stripping a port the way SELF-556
fixed for `NoteView.tsx`'s `hostOf`, landing in one file and not the other
would silently leave the other's host-keyed sets under- or over-counting).

Kept `query-yield.ts`'s copy as the owner (it is chronologically first and
already the file `recall.ts`'s own comments treat as the source of the
yield/page-loss methodology) and had `recall.ts` import it
(`import { hostOf } from "./query-yield.js"`) plus re-export it
(`export { hostOf }`) so `tests/recall.test.ts`'s existing
`import { hostOf, recallForAnchor } from "../scripts/recall.js"` needed no
change. Did not add a new shared `scripts/` util file for a one-line
predicate, matching SELF-553's own reasoning for preferring an existing
relationship over a new file, and did not touch `recall.ts`'s unrelated
web/CLI script naming — `scripts/recall.ts` and the pre-existing
`fix/linking-recall` branch (checked with `git branch -a`; unrelated, no
files in common) are coincidental namesakes.

Both existing test files needed no edits: `tests/query-yield.test.ts`
still tests the original definition directly, `tests/recall.test.ts` now
tests the re-export — both assert the same normalize-and-lowercase-and-
strip-www behavior they did before, so the duplicate test coverage was left
in place rather than deleted, matching SELF-553's precedent of adding
targeted coverage for a newly-shared predicate rather than removing a
caller's own view of it.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3339 tests passing (unchanged — no behavior change, pure
dedup), 13 skipped (same gated census as SELF-558).

Backlog item: SELF-559

**SELF-560 (2026-09-21 overnight fire) — read every `packages/web` file this
branch's own history had never named, from `git log a7bbc57..HEAD
--name-only` against the current file tree; found nothing to fix.**
Confirmed via `comm -23` between the full `packages/**/*.{ts,tsx}` source
list and that name-only log which files had genuinely never been touched by
a commit on this branch, then cross-checked the result against SELF-515's
own read-list (which covers most of `packages/web/lib`) to find the
sliver neither that entry nor any later one names: `packages/web/components/
kb/TabBar.tsx` (the tablist — underbar measurement, ResizeObserver wiring,
the ArrowLeft/Right/Home/End keyboard handler and its wraparound math),
`packages/web/components/kb/GraphLegend.tsx` (the type-toggle/highlight
overlay) and `packages/web/components/kb/layerMeta.tsx` (the three manifest
accessors `KbCard` and `KbOverview` share), plus `packages/web/app/page.tsx`,
`app/kb/page.tsx` and `app/film/page.tsx` (the three route shells choosing
between the live run surface, the metered-demo box and the read-only
gallery). `packages/web/components/icons/NodeGlyph.tsx` was also on the
untouched-file list but already carries its own dedicated test file
(`NodeGlyph.test.tsx`, added by a prior fire) covering `glyphForNotePath`'s
folder-then-basename precedence end to end, so it was read for confirmation
only, not as a gap.

Read each end to end against the class of bug this branch's D-section keeps
finding (a falsy check standing in for a real predicate, an index or `.find()`
that can silently match the wrong slot, a boundary an invariant elsewhere
assumes holds): `TabBar`'s `(i + 1) % tabs.length` / `(i - 1 + tabs.length) %
tabs.length` wraparound is correct for every `tabs.length >= 1` (the
`findIndex` guard above it already bails on `-1` before either runs);
its `btnRefs` ref-callback deletes on unmount so a removed tab cannot leave a
stale measurement target; the `ResizeObserver` cleanup unsubscribes both the
list and every button it observed, not just the list, so no observer outlives
a re-render. `GraphLegend`'s `visible`/`counts` reads are keyed by the same
`NodeType` union the caller (`GraphCanvas.tsx`, confirmed by grepping its one
call site) builds both records from, so there is no key drift to find; the
`onPointerLeave` on both the container and each row is redundant, not buggy —
confirmed by tracing the callback isn't referentially unstable across
renders that would make the redundancy matter. `layerMeta.tsx`'s three
accessors are pure and already exactly what `KbCard`/`KbOverview`/`KbBrowser`
need per their own call sites (grepped all three). The three route shells
were traced branch-by-branch against `lib/public-runs.ts`'s three `runGate`
outcomes (`open`, `used-up`, `read-only`, `uncountable`) and `lib/demo.ts`'s
`isDemo()` — every combination the comments claim is reachable renders the
component the comment says, and the one early-return ordering the file's own
comment flags as load-bearing (`publicRunsPerDay() === 0` checked before any
`await`) does in fact skip `runGate()`'s directory read on that path.

No code change — every file already correct. `pnpm install` first (fresh
clone, no `node_modules`, same as SELF-557 through SELF-559). `pnpm check &&
pnpm test` both exit 0: 3339 tests passing, 13 skipped (same gated census as
SELF-559; unchanged by a read-only fire).

Backlog item: SELF-560 - BLOCKED

**SELF-561 (2026-09-21 overnight fire) — tried `exactOptionalPropertyTypes` as
the next flag-as-detector (the angle SELF-545/549 used for
`noUncheckedIndexedAccess`/`noUnusedLocals`/`noUnusedParameters`), and found a
real but out-of-scope pattern rather than a fixable bug.** Enabling it in
`tsconfig.base.json` and running `tsc -b --force` (TS 5.9.3, installed fresh —
`node_modules` was absent again) surfaced 78 errors across 15 files spanning
all four packages: `core/src/{board,discovery,evidence,investigator,judge,
sniff,spans,tools,testing/fake-provider}.ts`, `providers/src/brightdata.ts`,
`swarm/src/{agent,orchestrator,run-evidence,tools-paid}.ts` and
`sweep/src/sweep.ts`. Every single one is the same shape: a value typed
`T | undefined` (an optional chain, a ternary, a field carried through from
another optional) assigned into a property declared `field?: T` rather than
`field?: T | undefined`. That is not a scattered handful of call sites to
patch — it is this codebase's one recurring telemetry/IO shape
(`Span`/`SpanInput`'s `error`/`servedBy`, `FetchResponse`/`SniffResult`'s
`contentType`/`detail`/`reason`, `{ signal?: AbortSignal }` on every
cancellable call, `BoardRow`'s `mission?`) hitting the same two-value
convention everywhere it is used, because the convention itself (build the
optional field from a variable that can be `undefined`, then spread or return
it) is used consistently. Making the flag pass would mean widening a good
dozen shared interface definitions to `field?: T | undefined` throughout, which
changes nothing any of these 78 sites actually does — checked several by hand
(e.g. `board.ts:117`'s `{ mission: undefined, skipped }`; its one caller reads
`result.mission` truthy, never `"mission" in result`, so explicit-`undefined`
and absent-key already behave identically here) — before concluding this is a
type-strictness style adoption across ~10 shared type definitions, not a bug
this branch's "one item, small, real, tested" scope owns, the same reasoning
`SELF-516` used to decline `Board.popAffordable`'s redesign. Reverted the
`tsconfig.base.json` edit before finishing (`git diff` clean, confirmed).

Also checked, all clean, before landing on the flag experiment above: every
file this branch's history shows fewer than 2 commits against it
(`packages/sweep/src/{rank,deadline,index}.ts`, `packages/core/src/{flags,
grounding,investigator,pricing,prompts,scorecard}.ts`,
`packages/swarm/src/{family-ledger,index}.ts`,
`packages/providers/src/index.ts`, `scripts/check-{core-purity,
test-collection}.mjs`) — `rank.ts` is an 11-line re-export with a comment
already explaining why it moved to `core/src/judge.ts` (SELF-533 read that
target), and every other name on the list already carries a prior fire's
full-read entry in this file (SELF-515 for `grounding.ts`/`investigator.ts`/
`pricing.ts`/`prompts.ts`, SELF-528 for `scorecard.ts`) despite drawing no
follow-up commit, i.e. read-and-found-nothing, not read-never. A basename
grep against this file's own prose (used to shortlist candidates) is
unreliable for the same reason: `clock.ts`, `from-sweep.ts`,
`corroboration-arrival.ts` and `brightdata.ts` all miss a literal filename
match here despite each having its own dedicated entry under a different
description. `scripts/build-demo-maps.ts` was the one genuine miss and is the
demo gallery's own rebuild script — out of scope by this file's own header.

Confirmed no unchecked `- [ ]` item remains anywhere in this file (`grep -n
'^\s*- \[ \]'`, zero hits) — sections A through D are each fully done or
BLOCKED, so this and future fires are self-discovered work only until a human
adds a new dated section.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3339 tests passing, 13 skipped (same gated census as
SELF-560; unchanged — the only edit this fire kept is to this file).

Backlog item: SELF-561 - BLOCKED

**SELF-562 (2026-09-21 overnight fire) — checked whether SELF-526's
row-identity-across-filter bug recurs anywhere else in `packages/web`;
it does not.** SELF-526 found that `SearchesPanel.tsx` built each row's `id`
from its own index in the array AFTER `onlyEmpty` filtering, so toggling the
filter could re-index a row that never left the list and silently collapse
its open detail panel — a filter changing WHICH slot a still-visible row sits
in, not a bounds error (the class `noUncheckedIndexedAccess`'s SELF-545 sweep
already covers). That is a narrower, easy-to-miss shape: local state keyed by
a position that is only stable when nothing upstream of it is ever filtered.

Grepped `packages/web/{components,app}` for every file combining `useState`
with `.filter(` — the same two ingredients `SearchesPanel.tsx` had — and got
seven hits: `KbGallery.tsx`, `GraphCanvas.tsx`, `KbOverview.tsx`,
`NoteView.tsx`, `CommandPalette.tsx`, `AgentPanel.tsx` and
`SearchesPanel.tsx` itself (already fixed). `KbGallery.tsx` is the demo
gallery, out of scope by this file's own header. Read the other four end to
end for this one question — does any locally-held state identify a row by a
position computed from a filtered array:

- `AgentPanel.tsx` has the closest shape (`shown = only ? entries.filter(...)
  : entries`, an agent-lane toggle) but each `Entry`'s `id` is a counter
  assigned once in `buildEntries`, over the full unfiltered chunk list,
  before `only` ever filters anything (`AgentPanel.tsx:74`, `:94`, `:102`,
  `:110`); `key={e.id}` never changes when the lane filter does.
  `shown[i-1]` (`:234`) reads a post-filter index too, but only to decide
  whether to print a speaker name on a hand-off — nothing is stored against
  it across renders, so there is nothing to desync.
- `CommandPalette.tsx` holds `cursor`, a numeric position into
  `results.flat` (the filtered/ranked list) — structurally the same
  "position into a filtered array" shape — but it is reset to 0 by a
  dedicated `useEffect(() => setCursor(0), [q])` on every keystroke, the
  only thing that changes what is filtered (`:225`), and `runAt` resolves a
  click or Enter against `results.flat[i]` fresh at call time rather than
  against a remembered identity (`:227-235`). Nothing persists a row's
  position past the render that filtered it.
- `GraphCanvas.tsx`, `KbOverview.tsx` and `NoteView.tsx` carry no per-row
  open/expanded state at all keyed by list position — their `useState` hooks
  hold a domain value instead (`peekId`/`focusId`/`detail`, `note`/`error`/
  `loading`), which cannot drift when a list gets re-filtered because it was
  never a position to begin with.

`SearchesPanel.tsx` was the one place the shape existed, and SELF-526
already fixed it (`withRowIds`, assigning identity once over the full list
before any filter runs). No code change this fire — every other candidate
already keys its state the safe way, most by construction rather than by a
deliberate fix.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3339 tests passing, 13 skipped (same gated census as
SELF-561; unchanged — a read-only fire).

Backlog item: SELF-562 - BLOCKED

**SELF-563 (2026-09-21 overnight fire) — tried `noImplicitOverride` and
`noPropertyAccessFromIndexSignature` as the next flag-as-detector pair, the
angle SELF-545/549/550/561 already used for
`noUncheckedIndexedAccess`/`noUnusedLocals`/`noUnusedParameters`/
`noImplicitReturns`/`noFallthroughCasesInSwitch`/`exactOptionalPropertyTypes`.
One is a clean pass like SELF-550's; the other is a second instance of
SELF-561's own verdict — a real, systemic pattern, not a fixable bug.**

`noImplicitOverride`: zero hits anywhere. Grepped every ` extends ` across
`packages/*/src` and `packages/web/{app,lib,components}` first to confirm
there was even a class hierarchy for the flag to check: three classes extend
`Error` (`core/src/evidence.ts`'s `CitationError`, `providers/src/
safe-fetch.ts`'s `BlockedHostError`, `web/lib/api-error.ts`'s `NamedFault`),
none override an inherited method — each only adds a constructor, which
`noImplicitOverride` does not gate. Added to `tsconfig.base.json` and
(separately, web never inherits base per SELF-545/549/550) `packages/web/
tsconfig.json`; ran every command `pnpm check` runs (`tsc -b`, web's own `tsc
--noEmit`, all four `tsconfig.tests.json` projects, `tsconfig.root.json`) —
zero errors. Kept, same "free insurance, no reason to revert" reasoning
SELF-550 gave `noImplicitReturns`/`noFallthroughCasesInSwitch`: it costs
nothing today and gates a real bug class the day this branch's currently
override-free classes gain a sibling.

`noPropertyAccessFromIndexSignature`: 128 hits in the engine build alone
(`tsc -b tsconfig.root.json`), zero attempted on web (the engine result
alone already settled the verdict). Read every hit rather than trusting the
count. 61 are `process.env.OPENKB_*`/`BRIGHTDATA_*`/`OPENROUTER_*` reads
across `scripts/*.ts`, `tests/live/*.ts` and `sweep.ts`/`from-sweep.ts` — the
flag's own textbook noisy case, since `NodeJS.ProcessEnv` is itself typed
with an index signature. The other 67 are every one of this codebase's
`Record<string, ...>`-typed report/frontmatter shapes accessed by their own
declared field names, not a typo class this flag can catch (it forces
bracket notation on a correct key, it does not validate the key): `core/src/
prompts.ts`'s `frontmatter: Record<string, string>` (`.agent`, `.doctrine`,
`.includes` — deliberately open, since frontmatter's whole job per the
file's own header is running whatever key an `.md` file declares);
`scripts/run-doctor.ts`'s `diagnose(r: Record<string, any>)` (`.budget`,
`.wire`, `.kernel`, …) — deliberately untyped because, per this same file's
own `run-doctor.test.ts` entry, its job is surviving "every run file, across
every engine version that wrote one," so a fixed interface here would be the
bug; `scripts/experiment.ts`/`read.ts`'s cost-breakdown printers, `sweep.ts`'s
own report literal, `tests/query-yield.test.ts`'s `plain`/`debranded`
fixtures — all the same shape, a loosely-typed record deliberately, not
narrowly. Reverted the `tsconfig.base.json` edit before finishing (`git diff`
clean, confirmed) — this is `SELF-561`'s exact verdict a second time: a real
but out-of-scope type-strictness style adoption across many call sites, not
one bug.

One process note for the next fire: running `tsc -b` directly against
`tsconfig.base.json`/`tsconfig.root.json` outside `pnpm check`'s own command
line emits stray `.js`/`.d.ts` next to every source file it touches — those
two configs carry no `outDir` (only each package's own `tsconfig.json` does,
via the reference graph `pnpm check`'s bare `tsc -b` walks from the *root*
`tsconfig.json`, not `tsconfig.base.json`). Caught it via `git status`
showing ~780 untracked files after the first probe, deleted every one (none
were ever staged), and re-verified with `pnpm check`'s own command line
afterward, which is unaffected. No stray file was committed.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3339 tests passing (unchanged — only `noImplicitOverride`
survives, and it changed no code), 13 skipped (same gated census as
SELF-562).

Backlog item: SELF-563

**SELF-564 (2026-09-21 overnight fire) — the same live-duplicate-function
shape SELF-553 found for `isAbortError` and SELF-559 found in `scripts/`,
this time in `packages/web/components`: `hostOf` still had two separate
bodies after SELF-553 itself deferred exactly this pair, on the grounds that
neither copy had independent test coverage to compare against.** That
blocker no longer holds — `NoteView.test.ts` (added by a later fire) now
gives `NoteView.tsx`'s `hostOf` full branch coverage (www-strip, port-strip,
case, the non-parseable and empty-string fallbacks), while
`SearchesPanel.tsx`'s copy is only exercised indirectly through rendering
(`SearchesPanel.test.tsx`'s own comment records it at 0% direct branch
coverage in a prior `--coverage` run). Confirmed both bodies are still
byte-for-byte identical (`new URL(url).hostname.replace(/^www\./, "")`,
catch returns the raw input) — `NoteView.tsx:47`'s own comment already notes
`SearchesPanel.tsx`'s sibling was the reference `hostOf` was resynced
against — so this is the exact SELF-553/559 risk: a widened check (a port
strip, a lowercase) landing in one copy and not the other would silently
leave the other caller's rendering wrong.

Unlike SELF-559's `scripts/` pair, `SearchesPanel.tsx` (`components/build/`)
had no existing import relationship with `NoteView.tsx` (`components/kb/`)
to lean on. Checked `packages/web/lib` for a shared URL-utility home first
(the natural non-invasive fix) — none exists; the closest, `lib/anchor.ts`'s
`normalizeDomain`, is a security validator with its own SSRF rationale, not
a general-purpose host stripper (SELF-553 already confirmed the two must
stay separate). Rather than open a new shared file for a five-line
predicate — the same call SELF-553/559 made — exported `hostOf` from
`NoteView.tsx` (already public; `NoteView.test.ts` already imports it the
same way) and had `SearchesPanel.tsx` import it
(`import { hostOf } from "@/components/kb/NoteView"`), removing its own
copy. Checked for a cycle first: `NoteView.tsx` imports only `react`,
`@open-kb/core`, `@/lib/viewTypes`, `@/components/SiteIcon` and
`@/components/ui` — nothing under `components/build` — so the new edge is
one-directional.

No behaviour change: both bodies were already identical, so this is pure
dedup, and `SearchesPanel.tsx`'s renders now run under `NoteView.test.ts`'s
coverage of the same function instead of an untested copy.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3339 tests passing (unchanged — same function, same
behaviour, one fewer copy), 13 skipped (same gated census as SELF-563).

Backlog item: SELF-564

**SELF-565 (2026-09-21 overnight fire) — same live-duplicate-function shape
again, this time in `packages/web/components/viz`: `polar`, byte-for-byte
identical in `Gauge.tsx` and `Donut.tsx`.** Found by listing every top-level
function name defined across `packages/*/src` and `packages/web/{app,lib,
components}` and grepping for one repeated with the same signature — `tierOf`
and `dedupe` also repeat but take different argument shapes for genuinely
different jobs (checked both pairs by hand before ruling them out); `polar`
was the one real match. Both copies are the identical five-line SVG-arc
helper:

```ts
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
```

Unlike the `hostOf` pair SELF-553 deferred for lack of coverage, this one was
never blocked on that: `Gauge.test.tsx` and `Donut.test.tsx` each already pin
the exact rendered `d="…"` path string their own `arcPath`/`arc` produces
(`Gauge.test.tsx`'s `/A59 59 0 1 1/` / `/A59 59 0 0 1/` assertions,
`Donut.test.tsx`'s equivalent), which is `polar`'s output baked into a string
— a widened formula in one copy and not the other would fail that copy's own
existing test, not go unnoticed the way an unconsumed `hostOf` divergence
would have.

No shared geometry file existed under `components/viz` (checked — the
directory holds five components and one barrel `index.ts`, nothing else), so
rather than pick one of the two sibling files to own the other's import (an
arbitrary choice neither `Gauge` nor `Donut` has priority for), added
`polar.ts` as its own one-function module next to them, following this
repo's one-purpose-file convention, and had both `Gauge.tsx` and `Donut.tsx`
import `{ polar } from "./polar"` in place of their own copy. Neither file is
in `viz/index.ts`'s barrel by its internal helpers (only the components are
exported), so `polar.ts` needed no barrel entry either. No cycle: `polar.ts`
imports nothing.

No behaviour change — both bodies were already identical, so this is pure
dedup. `arcPath` (Gauge) and `arc` (Donut) stay separate on purpose: Gauge's
takes a `sweep` direction Donut's `arc` does not need, so unlike `polar` they
were never actually the same function, just built from the same primitive.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3339 tests passing (unchanged — same function, same
behaviour, one fewer copy), 13 skipped (same gated census as SELF-564).

Backlog item: SELF-565

**SELF-566 (2026-09-21 overnight fire) — took SELF-509's own advice a second
time: a fresh end-to-end read of files this file's own prose had never named,
rather than another instrumented sweep. Found nothing to fix.**

SELF-561/562/563 already showed a basename-grep against this file is
unreliable (a fire can cover a file under a different description and miss a
literal filename match), so this fire cross-checked candidates two ways:
grepped every non-test `.ts`/`.tsx` under `packages/*/src` and
`packages/web/{app,lib,components}` for a zero-or-one-hit basename here,
then re-checked each survivor against its own exported function/const names
(`useUrlView`, `GraphSettingsPanel`, `KindChip`, `judgeExportTarget`,
`arrivalRow`, …) — a name match confirms a prior fire truly never engaged
the file; a miss on the name but a hit on some other description (as
`corroboration-arrival.ts` turned out to have, via `tests/
corroboration-arrival.test.ts`) rules it back out without a wasted read.

Read end to end, all clean:

- `packages/web/lib/useUrlView.ts` + its one caller, `KbBrowser.tsx`. Traced
  the mount-sync effect, the popstate handler and `go()`'s ref-outside-the-
  updater trick (the file's own comment: React Strict Mode double-invokes a
  state updater, which would double-push history) against every path `view.
  note`/`view.tab` can take — including the case where the server passes no
  `initialNote` and the client's mount effect reads `null` off a bare URL, a
  potential resync mismatch that turns out not to fire because `KbBrowser`'s
  `selected` is recomputed through `resolveNote(view.note, notes,
  defaultNote)` every render rather than trusting `view.note` to already
  carry the resolved default. `useUrlView.test.ts` already covers `readUrl`/
  `writeUrl` directly; the hook itself has no jsdom harness per this file's
  own B4, same limitation `TabBar.test.tsx` documents.
- `packages/web/components/kb/GraphSettings.tsx` + `lib/graph/settings.ts`.
  Checked every numeric field in all three `PRESETS` entries (quiet/airy/
  detailed) against its own slider's `RANGES` bound by hand — the exact
  drift class this file's own comment warns a test should catch — all in
  bounds; `GraphSettings.test.ts` already asserts this same thing.
  `loadSettings()`'s per-field validation (`clampNum`, the `?? default` vs
  `=== true` split between opt-out and opt-in booleans) matches its own
  comment in every case.
- `packages/web/components/ui.tsx` and `packages/web/components/HeaderNav.tsx`
  — the shared chip vocabulary and the route nav. `KIND_TONES`'s own comment
  already documents its one known gap (`unknown` sharing `publisher`'s tone,
  same shape as SELF-105/106); `ui.test.tsx` pins it. Nothing else to find.
- `packages/core/src/testing/fake-provider.ts` — `FakeSearch`/`FakeFetch`.
  Confirmed `search()`'s pre-dedupe-recording / post-dedupe-answering split
  matches the billing contract its comment describes, and `FakeFetch`'s
  `unlocked` row fallback (`row.unlocked ?? row`) correctly keeps every
  existing single-row table answering both modes identically.
- `scripts/corroboration-arrival.ts` and `scripts/export-target.ts` — both
  looked like genuine misses by the basename-grep pass (1 mention apiece,
  both only in passing lists) but both already carry dedicated, thorough
  test files (`tests/corroboration-arrival.test.ts`, 7 cases;
  `tests/export-target.test.ts`, 23 cases covering the file-vs-directory
  confusion, foreign-contents-one-level-down and marker-forgery incidents
  its own header narrates) — read-and-already-covered, not read-never.
- `prompts/README.md` — verified against the files it describes rather than
  taken on faith: the doctrine-file ownership table matches
  `prompts/doctrine/*.md` on disk exactly; `agents/investigator.md`'s
  `includes:` frontmatter matches the table's own example verbatim; the "eight
  commercial and three channel" relation count matches both
  `prompts/doctrine/02-relations.md`'s own headers (counted by hand) and
  `packages/core/src/judge.ts`'s `JUDGED_RELATIONS` (13 entries: the same 11
  plus the `unknown`/`none` placeholders the doc does not claim to cover).

No code change — every candidate this fire's two-pass filter surfaced was
either already correct or already tested for the exact drift this class of
sweep looks for. `pnpm install` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3339 tests passing, 13 skipped (same
gated census as SELF-565; unchanged — a read-only fire).

Backlog item: SELF-566 - BLOCKED

**SELF-567 (2026-09-22 overnight fire) — `packages/swarm/src/tools-paid.ts`
had never had a dedicated end-to-end read for logic bugs (its one prior
mention was a line-by-line `exactOptionalPropertyTypes` error list in
SELF-561, not a read for behaviour) — a full read found a real per-host
overspend bug in `harvestTool`.** The comment on the claim-dry check inside
`landOne` says "the instant the claim runs dry, stop the pool" — but the
check (`ctx.ledger.draw(ctx.claimId, 0)` then `controller.abort()`) sat only
on the tail of the branch that successfully lands a host on the map, AFTER
three earlier `return`s: `e.kind === "noise"`, `e.relation === "none"`, and
`out.rejected.length > 0` (the mint refusing the node). All three fire
before `rememberTool` and skip the dry check entirely — yet the real dollars
for that host (the fetch, via the `recordingFetch` wrapper, and the classify
call, via the `classify:` closure passed to `judgeHosts`) are already drawn
against the claim by the time `judgeHosts` calls `onJudged` and `landOne`
runs (confirmed in `packages/core/src/judge.ts`: `judgeOne` awaits
`deps.fetcher.get` then `deps.classify`, THEN `emit()`s, which is the only
caller of `deps.onJudged`). `worker()`'s own pool loop
(`judge.ts:972-984`) checks `deps.signal?.aborted` before popping the next
host, so `controller.abort()` genuinely does stop the pool from starting new
work — the mechanism is sound, it just never fires when the hosts crossing
zero are noise, none, or gate-rejected. A harvest whose candidates run
heavy to off-topic residue (a realistic shape, not a contrived one — that is
exactly what `kind: "noise"` and `relation: "none"` exist to describe) could
keep drawing fetch and classify dollars past its reservation for every
remaining candidate in the call, up to the full `MAX_HARVEST_HOSTS` (40),
never once tripping the abort the comment promises.

Fixed by factoring the check into a `checkDry()` closure and calling it from
all four exit points of `landOne` — the three early returns plus the
existing tail — instead of only the last one. No change to the check's own
logic (still `remainingUsd <= EPSILON`, still `!ranDry` to abort at most
once) and no change to what counts as "judged" (`judgedHosts.add` still runs
unconditionally at the top, unaffected either way).

Reproduced before fixing: added a test with `concurrency: 1`, a $0.05
reservation, four hosts at $0.01 fetch + $0.02 classify each (the same
shape `docs/overnight-backlog.md`'s existing "the allowance running dry
aborts the pool" test uses), but with every host judged `noise` instead of
landing. Pre-fix, the test failed — all 4 hosts were judged and drawn
against (`r.spentUsd` came back 4 × 0.03, not 2 × 0.03) because the noise
branch's early return skipped the dry check every time. Post-fix it passes:
exactly 2 hosts judged before `ranDry` trips, 2 come back "allowance ran dry
mid-harvest", `r.spentUsd` is exactly `2 * 0.03`. The three pre-existing
dry-abort and kill-mid-harvest tests (which exercise the success path, where
the check already fired correctly) still pass unchanged, confirming this
was additive, not a behaviour change on the path that was already right.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3340 tests passing (up from 3339, the one new
regression test), 13 skipped (same gated census as SELF-566; unchanged).

Backlog item: SELF-567

**SELF-568 (2026-09-22 overnight fire) — read the small top-level helper
functions in `packages/sweep/src/sweep.ts` that sit before the giant
`sweep()` function itself (`walkUpForPrompts`, `promptsRoot`, `makePrompt`,
`scopeToPlatform`, `mostCorroboratedFirst`, `resolves`, `suggest`, `onMap`,
`rankThinkLine`, `runPool`) — none of them have a dedicated mention anywhere
in this file by name, unlike almost everything else in `packages/sweep/src`
at this point — and found `suggest()` does not do what its own two doc
comments say it does.** The function-level comment ("A typo is nearly always
a doubled OR TRANSPOSED letter in the TLD") and the in-loop comment ("one
character away: a doubled letter, a missing one, or TWO SWAPPED") both name
transposition as a shape this function corrects, but only two of the three
branches were ever implemented: the doubled-letter regex and the
length+1-and-includes extra-character check. There was never a branch for
two adjacent letters swapped. Verified directly:
`suggest("foo.ogr")` returned `""`, not "Did you mean foo.org?" — same as a
typo with no fix at all, for exactly the shape (`ogr`/`org`, `cmo`/`com`,
`oi`/`io`) both comments claim is handled. Not hypothetical: a same-length
adjacent-swap is one of the two typo shapes real fat-fingering actually
produces (the other, a doubled letter, is the one branch that already
worked), so this silently dropped the useful reply for half its own
documented cases, in the small window a user's very first look at this
tool is likely to hit it (an anchor domain that fails the DNS preflight is
the input `suggest` exists to help with).

Fixed by adding the missing same-length,
one-adjacent-pair-reversed check next to the other two, using the same
`good` loop and `fixes` set — no change to the doubled-letter or
extra-character branches, and no new collision risk: checked by hand that
none of the eight `GOOD_TLDS`' own adjacent-swap forms (`ocm`/`cmo` for
`com`, `oi` for `io`, `ia` for `ai`, `edv`/`dve` for `dev`, `pap` for `app`,
`oc` for `co`, `ent`/`nte` for `net`, `rog`/`ogr` for `org`) collides with a
DIFFERENT entry in the same list — the exact class of bug the early-return
guard just above this loop (the co/com collision) was already written to
prevent, so a new collision would have silently reopened it.

Added three cases to the existing dedicated suite
(`suggest-never-turns-a-real-tld-into-a-different-one.test.ts`, which
SELF-466 added when the co/com collision was fixed): `foo.ogr` →
`foo.org`, `foo.cmo` → `foo.com`, `foo.oi` → `foo.io`. Confirmed non-vacuous
by mutation: stashed just the `sweep.ts` change and reran — the new test
failed on the first assertion (`''` where `'Did you mean foo.org?'` was
expected); restored the fix and reran clean before staging.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3341 tests passing (up from 3340, the one new test case),
13 skipped (same gated census as SELF-567; unchanged).

Backlog item: SELF-568

**SELF-569 (2026-09-22 overnight fire) — `packages/core/src/catalog.ts` had
never had a dedicated end-to-end read; a full read found one alternation
branch that is implemented but was untested by construction, not merely by
coverage.** `COMPARISON` and `NAMES_ONE_RIVAL` both list eight alternatives
(`compare|comparisons?|versus|vs|alternatives?|alternative-to|migrate(?:-
from)?|switch(?:ing)?-from`), and every one of them traces to a specific
fetched sitemap in this file's own comments — the commerce platform backing
`compare`/`versus`/`alternatives` (838 urls, 2026-08-12), the email vendor
backing `migrate` (2026-08-16) — except `switch(?:ing)?-from`, which joined
both regexes in the same commit as `migrate` (4d34b08) on the same "single
segment IS the name" reasoning, but carries no citation of its own and,
confirmed by `grep -rn "switch-from\|switching-from"` across every `.ts`
file in the repo, had zero test fixtures exercising it — the one alternative
among eight with no measured example and no test, in a file whose own header
says "MEASURED, against ground truth" is the whole method.

Traced it by hand rather than trusting the regex: `COMPARISON.test("/switch-
from/mailchimp")` and `NAMES_ONE_RIVAL.test("switch-from")` both return
`true` (confirmed in a scratch `node -e`), so the namespace shape — a
`/switch-from/<rival>` or `/switching-from/<rival>` folder, exactly like
`/migrate/<rival>` — is correctly wired end to end. Not a logic bug: the
branch does what `NAMES_ONE_RIVAL`'s own name says. What it lacks is
evidence that any real vendor publishes that shape rather than the single
hyphenated segment `-alternatives?$` already gets its own dedicated suffix
check for (`/switch-from-mailchimp` as one segment, which this function does
not catch under any branch — confirmed `COMPARISON.test("/switch-from-
mailchimp")` is `false`, and the depth-two slug branch requires
`segs.length === 2`, which a single segment never is). Fixing that gap would
mean guessing at a new regex with no sitemap to check it against — exactly
the kind of live-fetch-shaped work this offline pass is not scoped to do —
so this fire narrowed to what a fixture can prove: that the branch as
written matches its own stated intent.

Added a test to the existing dedicated suite
(`packages/core/tests/a-comparison-url-names-a-rival.test.ts`, next to the
`migrate` test it mirrors) covering `/switch-from/mailchimp` and
`/switching-from/sendgrid`. Confirmed non-vacuous by mutation: dropped
`|migrate(?:-from)?|switch(?:ing)?-from)` down to `|migrate(?:-from)?)` in
both `COMPARISON` and `NAMES_ONE_RIVAL`, reran — the new test failed
(`[]` where `["mailchimp", "sendgrid"]` was expected) — then restored the
original regexes and reran clean before staging. Left the source file's own
comments untouched: adding a fabricated "MEASURED" citation for a shape this
offline pass cannot verify against a live sitemap would be worse than
leaving the gap visible.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3342 tests passing (up from 3341, the one new test case),
13 skipped (same gated census as SELF-568; unchanged).

Backlog item: SELF-569

**SELF-570 (2026-09-22 overnight fire) — tried `allowUnreachableCode`,
`allowUnusedLabels` and `noUncheckedSideEffectImports` as the next
flag-as-detector triple, the angle SELF-545/549/550/561/563 already used for
seven other strict-family flags; two are clean passes, the third is the same
"real pattern, not a fixable bug" verdict those fires kept landing on.**
Before reaching for a new flag, spent this fire's first pass re-reading
`packages/web/lib/graph/{layout,layoutCache}.ts`, `scorecard-view.ts`,
`notes-view.ts`, `zip.ts`, `graphIcons.ts`, `core/src/pricing.ts` and
`prompts.ts` end to end looking for the falsy-check/wrong-slot/no-guard bug
class SELF-510/512/513/514 found — all seven turned out to be exactly the
files SELF-515 already read line 550-568 of this same document (grepping
`packages/web/lib/graph/layout.ts` etc. by their un-prefixed basename earlier
missed that entry's comma-separated file lists, which name most of them
without a full path). No new ground there; recorded so a future fire's
basename grep does not repeat the same miss, and switched angles.

`allowUnreachableCode: false`: exactly 3 hits, all `tests/fatal.test.ts:25-27`
inside `callFatal`'s helper — `fatal(e, what)` is typed `(e: unknown, what:
string): never` (`scripts/fatal.ts:98`, since a real call always ends in
`process.exit`), so TypeScript's flow analysis marks every statement after
the call unreachable in every caller, including this one, where
`process.exit` is `vi.spyOn`'d to a no-op specifically so execution CAN
continue (the file's own header: "every case here stubs `process.exit` ...
rather than calling through them"). The three lines the flag flags are the
ones reading `exitSpy.mock.calls`/`errorSpy.mock.calls` after the call —
exactly the assertions the test exists to make, and the suite passing today
is the proof they already run. Not a bug: a `never`-typed function mocked
for testing is an intentional, unavoidable type-lie, the same shape
`SELF-561`/`SELF-563` already named for `exactOptionalPropertyTypes` and
`noPropertyAccessFromIndexSignature` — a real, systemic pattern this flag
cannot distinguish from an actual dead branch, not a call site to fix. Left
out of both tsconfigs.

`allowUnusedLabels: false` and `noUncheckedSideEffectImports: true`: zero
hits in either `tsconfig.base.json`'s build (`tsc -b`, all four
`tsconfig.tests.json` projects, `tsconfig.root.json`) or `packages/web`'s own
`tsc --noEmit` — this codebase uses no labelled statements and no
side-effect-only imports of an unresolvable specifier. Kept, same "free
insurance, no reason to revert" reasoning `SELF-550`/`SELF-563` gave
`noImplicitReturns`/`noFallthroughCasesInSwitch`/`noImplicitOverride`: costs
nothing today, gates a real (if currently absent) bug class the day either
shape is introduced. Added to both `tsconfig.base.json` and
`packages/web/tsconfig.json` (web never inherits base, per SELF-545/549/550).

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3342 tests passing (unchanged — no source file touched,
only the two kept flags), 13 skipped (same gated census as SELF-569).

Backlog item: SELF-570

**SELF-571 (2026-09-22 overnight fire) — tried `erasableSyntaxOnly`
(TS 5.8+, new since the last flag-as-detector triple) as the next untried
strict flag; it flagged one file, and the file it flagged was a genuine
house-style outlier, not a false positive.** `tsconfig.base.json` and
`packages/web/tsconfig.json` carry nine strict-family flags between them
already (`noUncheckedIndexedAccess`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noImplicitOverride`, `allowUnusedLabels`,
`noUncheckedSideEffectImports`, the three SELF-570 just added or confirmed);
`erasableSyntaxOnly`, `verbatimModuleSyntax` and `isolatedDeclarations` were
the three genuinely untried ones left (checked by grepping this file for
each name — zero prior hits for all three, confirmed against the installed
`typescript@5.9.3`, which supports all three). `isolatedDeclarations` and
`verbatimModuleSyntax` both reshape how every export across the codebase is
written (explicit return types on every exported function; `import type`
everywhere a specifier is type-only) — too large a surface for a single
fire to land safely, the same reasoning that has kept them off since
`declaration: true` first shipped. `erasableSyntaxOnly` — TS1294 on any
construct that cannot be erased to nothing at compile time (parameter
properties, enums, namespaces, `<reference>` triple-slash directives) — is
a narrow, binary check, the same shape as SELF-570's own triple, so tried it
first.

Added to `tsconfig.base.json` and, separately (web never inherits base, per
SELF-545/549/550), `packages/web/tsconfig.json`, then ran `tsc -b` (the same
command `pnpm check` runs). Exactly 3 hits, all `TS1294` on the same
construct — TypeScript parameter-property shorthand
(`constructor(private table: ...)`) — and all three inside one file,
`packages/core/src/testing/fake-provider.ts`. Before deciding whether this
was SELF-570's `allowUnreachableCode` verdict (a real, systemic, unfixable
pattern) or a real gap, grepped every `constructor(` across
`packages/*/src` and `packages/web` for a `private`/`public`/`protected`/
`readonly` modifier anywhere near it: four other hits looked like the same
shorthand at a glance (`ledger.ts`, `safe-fetch.ts`, `map.ts`,
`graphIcons.ts`) but reading each one showed every single one already
declares its fields explicitly and assigns them in the constructor body
(`this.ceilingUsd = ceilingUsd`, etc.) — the grep matched a `private` field
declared a few lines above or below the constructor, not the parameter list
itself. `fake-provider.ts`'s two classes (`FakeSearch`, `FakeFetch`) were
the only real use of the shorthand anywhere in the codebase — a one-file,
three-call-site style outlier, not a project-wide pattern, so this landed
in "small, fixable, tested" territory rather than "leave the flag out."

Converted both constructors to the explicit-field-plus-assignment shape
every other class in the codebase already uses: `table`/`opts` become
declared `private` fields, assigned in the constructor body from
plain (non-modified) parameters. `FakeSearch`'s `opts` type (three
documented optional fields, `failing`/`failingErrors`/`pacedMs`) was
previously written inline in the parameter list with its field-level doc
comments attached to each property; pulled it out to a named
`FakeSearchOpts` type above the class so the field declaration and the
constructor parameter reference the same type instead of two independently-
typed copies that could drift (`FakeFetch`'s row shape got the same
treatment, as `FakeFetchRow`). Behavior is unchanged — same public
constructor signature, same field names, same default `{}` for
`FakeSearch`'s second argument — confirmed by the two classes' own call
sites across the test suite needing no changes.

`pnpm install` first (fresh clone, no `node_modules`). `tsc -b --force`
after the fix: zero errors, so the flag has zero remaining hits across
every project `tsc -b` builds. Kept `erasableSyntaxOnly` in both
`tsconfig.base.json` and `packages/web/tsconfig.json` — same "free
insurance" reasoning `SELF-550`/`SELF-563`/`SELF-570` gave the other
strict-family additions: costs nothing today (the one real hit is fixed),
and it keeps this codebase's own explicit-field convention machine-
enforced rather than merely consistent by habit. `pnpm check && pnpm
test` both exit 0: 3342 tests passing (unchanged — the two classes' public
shape didn't move), 13 skipped (same gated census as SELF-570).

Backlog item: SELF-571

**SELF-572 (2026-09-22 overnight fire) — set out to cross-check the doctrine/
prompt tree against code again, found SELF-539 already did exactly that
exhaustively; pivoted to a fresh coverage sweep scoped to what changed since
SELF-509's snapshot, and found one real gap: `seed-families.ts`'s own fix
commit had left its own new fallback lines untested.** Read
`prompts/doctrine/{01,03,04,05,06,07}-*.md`, `investigator.md`, `assess.md`
and `catalog.md` end to end against `packages/swarm/src/{agent,tools-free}.ts`
and `packages/sweep/src/sweep.ts` (`scopeToPlatform`/`MAX_SCOPED_WORDS`
specifically, catalog.md's "five words is the ceiling" claim) looking for
drift — all of it checked out exactly, including the 42.8%/211-of-493 and
0.85%/7-of-826 figures catalog.md and 07-query-families.md both cite (same
measurement, quoted identically in both places). Before writing any of that
up as this fire's finding, re-read SELF-539 in full and confirmed it had
already read every one of those doctrine/agent files (its own list: six agent
prompts plus five doctrine files, `01/03/04/05/06`) word-for-word against
their code and fixed the one drift it found (`understand.md`'s rival-count
prose) — so a second pass over the same files was this fire re-doing already-
verified work blind, not new ground. `catalog.md`/`assess.md` were outside
SELF-539's list only because they already carried earlier commits
(07-query-families' own fix), which is exactly why they turned out clean
here too.

Switched to SELF-509's tool (coverage-v8) rather than its target — that fire
explicitly said do not re-run ITS OWN sweep, not that coverage is exhausted
as a method, and 62 SELF-tagged commits have landed against `packages/core`,
`packages/swarm` and `packages/sweep` since its 2026-09-17 snapshot, several
adding new branches. Installed `@vitest/coverage-v8@3.2.7` (matched to this
repo's `vitest@3.2.7`, same as SELF-509; never committed — `git checkout --
package.json pnpm-lock.yaml` before finishing) and ran it over
`packages/{core,swarm,sweep,providers}`. Three packages came back exactly as
SELF-509 left them (core 99.89%, providers 100%, sweep's one open line
already dated); `packages/swarm/src` had moved to 99.41% branch-covered with
one new file in the miss list SELF-509 never named: `seed-families.ts`,
lines 160-164, 88.09% branch.

Traced it: `git blame` puts those five lines at `5a1b8bf`
("seed-families' template picker could swallow its own reserve slot"),
committed the SAME day as SELF-509's sweep — the fix that introduced them
landed either just before or just after that fire's snapshot, and either
way nobody circled back to check its own new branches. The five lines
(`alternatives`/`best`/`vs`/`top`/`openSource`) each read `open[1]?.q ??
fallback` / `reserve[0..3]?.q ?? fallback` — an array-index fallback,
distinct from `bare`'s `q()`-find-miss fallback three lines above (already
covered by this same test file's "bare's equality check misses on an
untrimmed category" case). The index fallback fires only when `open` and
`reserve` come back EMPTY, which happens when `openingHand`'s own `t0` is
falsy — an all-whitespace or empty category, which `terms.map(t =>
t.trim()).filter(Boolean)` drops before its `if (t0)` branch ever runs.
`familyProfileFrom`'s `usable()` guarantees `category.length >= 3` on the
one production path that builds a `FamilyProfile`, so this branch is
unreachable there — but `seedFamilyMissions` is exported and takes the
interface as given, with no re-check of its own, so any direct caller that
skips `familyProfileFrom` (this test file already does exactly that for
several other cases) reaches it.

Verified with `npx tsx -e` calling `seedFamilyMissions({ category: "",
source: "capability" })` directly before writing the test, to get the exact
fallback strings right rather than guess: `bare` comes back `""`,
`alternatives` `" alternatives"`, `best` `"best "`, `vs` `" vs"`, `top`
`"top  companies"`, `openSource` `"open source "` — never a crash, just a
degenerate-but-syntactically-valid template. Added one test to
`packages/swarm/tests/seed-families.test.ts` pinning exactly that: a
directly-constructed empty-category profile, asserting all four affected
briefs (market/competitors/substitutes/buyers) carry the fallback text
computed above. Not a behaviour change — the fallback was already correct,
just unexercised by any test since the day it was written.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3343 tests passing (up from 3342, the one new test case),
13 skipped (same gated census as SELF-571).

Backlog item: SELF-572

**SELF-573 (2026-09-22 overnight fire) — `packages/web/lib/spend-limits.ts`
(848 lines, the deployment's own money guard) had never had a dedicated
end-to-end read; found one genuinely live, genuinely untested branch among
eight.** Read all 849 lines against its own header doctrine ("FAIL CLOSED,
EVERYWHERE") function by function — `runUsd`/`defaultRunCapUsd` (re-verified
the $0.41/$1.51/$3.74 table by hand, matching SELF-509's own citation-check
of the same figures), `setting`/`readLimits` (the three refusal shapes: cap
too small, day cap below run cap, a bad value), `clientIp`/`bareAddress`/
`bucket` (the last-entry-of-`x-forwarded-for` reasoning, the IPv4-in-IPv6
unwrap, the IPv6 /64 expansion by hand against several addresses), the
in-memory ledger (`noteRunStarted`'s 2-day prune, `noteRunEnded`'s finite-
usd guard), `count`/`claimInMemory` (the visitor-then-day-then-at-once
order, matching the doc comment's own stated priority), and `refusal`'s
three sentences.

Installed `@vitest/coverage-v8@3.2.7` (matched to this repo's `vitest@3.2.7`,
same as SELF-509/572; never committed — `git checkout -- package.json
pnpm-lock.yaml` before finishing) and ran it scoped to `packages/web/lib`
rather than the whole app, since SELF-509's "no jsdom/RTL harness" verdict
was measured against `.tsx` components and never actually checked whether
that generalized to the package's plain `.ts` logic files. It does not:
`packages/web/lib`'s non-component files came back 98.75% branch-blind-spot-
free at the line level and 100% at the function level, `spend-limits.ts`
itself included — a real, closeable angle B1-B4's jsdom verdict does not
cover and no prior fire had measured. Its one file came back 94.16% branch,
eight uncovered branches.

Traced every one by hand rather than trusting the percentage. Seven are
already unreachable through this file's own callers, each for a documented
reason: `bucket()`'s `g || "0"` IPv6 zero-fill (dead once every group is
already filled from an explicit `"0"` literal); the ledger's 2-day prune and
`noteRunEnded`'s `Number.isFinite(usd) ? usd : 0` guard (this file's one
caller, `app/api/map/route.ts:611`, passes `record.spans.totalUsd()`, and
`packages/core/src/spans.ts`'s `SpanStream.emit` already forces every
individual span's `usd` finite before accumulating `#total` — confirmed
reading `emit()` itself — so the sum handed to `noteRunEnded` cannot be
non-finite today); `count()`'s matching guard on an ended row's `usd`
(same reason one layer up: every ledger entry's `usd` was already forced
finite by `noteRunEnded`'s own guard by the time `count()` reads it); and
the three `?? 0` fallbacks in `refusal()` (`claimInMemory` only ever
returns `limit: "visitor"`/`"day"`/`"at-once"` when the matching
`perVisitorPerDay`/`dayCapUsd`/`atOnce` is non-null, so the null case
`refusal` defends against cannot arise from this file's own claim path —
only the Postgres `claim_run` path could disagree, which is exactly why the
guard is worth keeping and not worth deleting).

The eighth was real: `quote()`'s `text.length > 40 ? ... slice(0, 40) + "…"
: text` truncation arm. Every bad-value test in this file and in
`app/api/map/limits.test.ts` (`"$5"`, `"lots"`, `"2.5"`, `"-1"`, `"Infinity"`,
`"NaN"`) is under 40 characters, so the truncated arm — the one that stops
an operator's misconfigured value (a pasted URL, a JSON blob, a whole `.env`
line dropped in the wrong field) riding whole into the 429/503 sentence a
stranger reads — had never fired in any suite. Added one test to
`spend-limits.test.ts`: a 58-character junk value, asserting the refusal
quotes exactly the first 40 characters plus `…` and never contains the
value whole. Confirmed non-vacuous by mutation: temporarily replaced
`quote`'s body with a bare `JSON.stringify(text)`, reran — the new test
failed on its first assertion, comparing the untruncated message against
the truncated expectation — then restored the original (`git diff` on the
source file is empty; only the test file changed).

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3344 tests passing (up from 3343, the one new test case),
13 skipped (same gated census as SELF-572).

Backlog item: SELF-573

**SELF-574 (2026-09-22 overnight fire) — `scripts/read.ts`'s `resolve` had a
one-mention basename hit (grouped with `experiment.ts` as "cost-breakdown
printers", never a dedicated read); a full read of the file plus its own
test suite found the exact input its own docstring promises to handle was
the one it silently broke.** The header comment states `resolve` "accepts a
domain, a run id, a filename or a path" specifically so a reader does not
have to learn the run-file naming scheme. But the `.json`-suffix fast path
(`if (arg.endsWith(".json")) return arg`, unedited since the initial commit,
`1770fca`) could not tell "a filename" from "a path" — both end in `.json` —
and always treated the arg as an already-correct path, handing it back
unprefixed with `runs/`.

The one input this breaks is the most natural one there is: `ls runs/`
prints `sweep-brightdata-com-20260821105321.json`, and a reader who copies
that name straight into `pnpm read <name>` (rather than stripping the
extension, which the existing "bare run id" test shows already worked)
hits the fast path, gets that literal string back with no directory, and
`readFileSync` throws ENOENT from the repo root — where every `pnpm read`
invocation runs. Verified directly: `resolve("sweep-brightdata-com-
20260821105321.json", files)` returned the bare filename; the same arg
without `.json` already returned `runs/sweep-brightdata-com-
20260821105321.json` correctly, via the slug-match branch below it.

Fixed by keying the fast path on whether the arg carries a directory
component (`arg.includes("/")`), not merely the `.json` suffix: a `.json`
arg with a slash (an absolute path, or one naming a directory other than
`runs/` — the existing `"some/where/run.json"` test) still passes straight
through unprefixed; a bare `.json` filename now joins `runs/` the same way
a domain or a bare run id already does. No change to the domain/run-id
slug-match branch, and no new case for a `.json` file that lives outside
`runs/` under its own bare name — the docstring's four accepted shapes are
domain, run id, a `runs/`-relative filename, and a full path, not a bare
name elsewhere, so that input keeps failing exactly as before.

Added one test to `tests/read.test.ts` pinning the fixed behaviour: a bare
`sweep-brightdata-com-20260821105321.json` resolves to `runs/sweep-
brightdata-com-20260821105321.json`. Confirmed non-vacuous by mutation:
stashed just the `read.ts` change and reran — the new test failed, returning
the bare filename where the `runs/`-prefixed path was expected — then
restored the fix and reran clean before staging.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3345 tests passing (up from 3344, the one new test case),
13 skipped (same gated census as SELF-573).

Backlog item: SELF-574

**SELF-575 (2026-09-22 overnight fire) — a genuinely new angle (dead-export
detection via `knip`, never tried by any prior fire) found six components
each shipping one `export default` line with zero callers anywhere in the
repo, the same shape as SELF-16's `usageSince`.** Every strict-flag-as-
detector combination TypeScript itself offers has already been run
(SELF-545/549/550/561/563/570/571), and every file this branch's own git
log or prose shows a low touch count has already had a dedicated read
(SELF-528/529/533/534/566 and the many single-file entries between them) —
so this fire picked a tool instead of a file list: installed
`knip@6.37.0` at the workspace root the same way SELF-509/566/573 installed
`@vitest/coverage-v8` (temporary, `git checkout -- package.json
pnpm-lock.yaml` before finishing) and ran it unconfigured against the whole
pnpm workspace.

Zero unused files, zero unused dependencies, zero unlisted dependencies —
this repo is clean on all three, which is itself worth recording so a
future fire does not re-run the same check expecting a different shape of
result. The "unused exported types" list (24 entries) is entirely a
components/lib library re-exporting its own prop and return types through
`index.ts` barrels for callers that do not yet exist — normal API surface,
not a bug, and indistinguishable in kind from `DonutSegment`/`StatTileProps`
etc. that this same barrel already re-exports and uses. `noteRunStarted`
(`spend-limits.ts`) and the `GLYPH_KINDS` re-export (`icons/index.ts`) are
both live code reached through a different path than knip checked (called
internally by `spendGate`; imported directly from `./NodeGlyph` by its own
test) — flagged, not dead — and left alone.

The one real, unambiguous item: `SiteIcon.tsx`, and `viz/{BarMeter,Donut,
Gauge,Sparkline,StatTile}.tsx` each end with a bare `export default X;`
carrying no comment explaining it, alongside the SAME component's own named
export. Confirmed by hand, not by trusting the tool: grepped the whole repo
for a default-shaped import of each of the six
(`import (SiteIcon|BarMeter|Donut|Gauge|Sparkline|StatTile)\s*(,|from)`) —
zero hits, including in every test file for these six. Every real call
site (`KbOverview.tsx`, `ProductsTab.tsx`, `NoteView.tsx`, `ResultPanel.tsx`,
`FindingsPanel.tsx`, `viz/index.ts`'s own barrel, all six `.test.tsx` files)
imports the named export exclusively. Also checked whether a `next/dynamic`
call anywhere needs the default form (the one thing that would make this a
live seam rather than dead code): the only `next/dynamic` in the repo
(`GraphCanvas.tsx`) wraps `react-force-graph-2d`, an external package, not
one of these six. Removed the six dead lines; nothing else in any of the
six files changed.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3345 tests passing, 13 skipped (same gated census as
SELF-574; unchanged by a dead-code-only removal with nothing new to test).

Backlog item: SELF-575

**SELF-576 (2026-09-22 overnight fire) — `lib/kb-lookup.ts` had only ever
been mentioned in passing (grouped into a route-wiring-coverage commit), never
given its own read; a full read against its one caller class found the exact
"THREE STATES, NOT TWO" bug B4/a prior fire already found and fixed on the
human-facing page, still live on the API surface that page's own comment
sits fifteen lines above.** `app/kb/[id]/page.tsx` computes `running` and
`failed` as two distinct booleans off `run.status`, with its own comment
explaining why: "`failed` used to be 'there is a run and it has no map',
which is also true of a run that is still going," and a visitor who followed
the wait-strip's promise arrives on a run that is still running far more
often than on one that died. `lib/kb-lookup.ts` — the shared `findKb` helper
all four `/api/kb/[id]*` routes (`route.ts`, `note/route.ts`, `graph/
route.ts`, `export/route.ts`) open with — never got the same fix: its
`!isCompleted(run)` branch returned one hardcoded sentence, `` `run ${id}
failed, so it built no knowledge base` ``, for both a failed run AND a
still-running one, with only the `status` field in the body actually telling
the two apart (confirmed the existing test for the running case asserted
`status` but never `error`, matching the bug exactly).

In practice the web app itself never hits this: `KbBrowser`/`GraphCanvas`/
`NoteView` only fetch these four routes from inside a page that has already
confirmed `isCompleted`, so no click in the UI reaches a running-run refusal
today (checked every `fetch(`/api/kb/` call site — three, all inside
components mounted post-completion). But the routes are public API surface
independent of the web client — anyone polling `GET /api/kb/<id>` directly
while a sweep is mid-run (the natural thing to try, since `GET /api/run/<id>`
is the progress endpoint and `/api/kb/<id>` is the map endpoint) is told
their run "failed" while it is, in fact, still working and may produce a map
a minute later. That is a false statement from a codebase whose own header
comment two lines above calls 404 here "the honest status."

Fixed by branching on `run.status === "running"` the same way the page
already does, with its own honest sentence (`` `run ${id} is still running —
no knowledge base yet — ask /api/run/${id} for progress` ``) alongside the
unchanged failed-run sentence; `status` in the body is unchanged (it already
told the two cases apart). Updated the file's own header doctrine comment
("WHY A FAILED RUN IS STILL A 404 HERE" → "WHY A NON-COMPLETED RUN IS STILL A
404 HERE, EVEN WHILE RUNNING") to state the three-way split and point at the
page's own comment rather than assert only the failed case exists. Updated
`kb-lookup.test.ts`'s existing running-run test, which had asserted `status`
only, to pin the new `error` sentence and assert it does not contain
"failed" — the exact assertion gap that let the old bug ship untested.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3345 tests passing (same count as SELF-575 — one existing
test's assertions changed, none added or removed), 13 skipped (same gated
census as SELF-575).

Backlog item: SELF-576

**SELF-577 (2026-09-30 overnight fire) — a basename cross-reference against
the full `a7bbc57..HEAD` commit log (not just this doc, which SELF-509's own
note already flagged as reset once) found `layerMeta.tsx` untouched by name;
reading its actual importers instead turned up a real formatting bug in two
files that HAD been read before, `DecisionsStrip.tsx` and `BuildWorkflow.tsx`.**
`layerMeta.tsx` itself checked out clean — three small accessors, already with
their own dedicated `layerMeta.test.ts` covering every branch, nothing to fix.
Reading its callers for other outstanding gaps landed on `DecisionsStrip.tsx`'s
`clock(atSec)`: `const s = atSec % 60` runs on `atSec` unfloored, and
`Decision.atSec` is typed as a bare `number` — `types.test.ts`'s own test for
the shared `readProgress` parser pins `atSec: 12.5` as valid input, so the type
system and the existing test suite both already treat a fractional value as
legitimate. `atSec % 60` on a fraction is itself fractional, and once floating-
point rounding is involved the result is not even the tidy fraction it looks
like: `65.3 % 60` is `5.299999999999997` in JS, not `5.3`. `padStart(2, "0")`
only pads a string SHORTER than 2 characters, so a multi-digit float sails
through unpadded — `clock(65.3)` returns `"01:5.299999999999997"`, not a
malformed clock but a raw float dump inside what reads as a fixed-width
`mm:ss` field. Verified directly in a scratch Node REPL before touching any
file.

The identical computation, duplicated, lives in `BuildWorkflow.tsx`'s
`addFeed` call inside the `?ns=progress` handler — `p.atSec % 60` again,
unfloored, building the elapsed-marker prefix on every feed line. Same root
cause, same trigger, so both are one item: `clock()`'s local fix floors
`atSec` before splitting into minutes/seconds; the `BuildWorkflow.tsx` site
is pulled out into a new exported `clockPrefix(atSec)` (`"[mm:ss] "` or `""`),
matching the file's existing pattern of testing pure logic as exports
(`isSpendDecision`, `mergeEntities`) rather than the untestable JSX shell
around it — B1-B4 already established this app has no jsdom/RTL harness, so
the inline template-literal version could not have been pinned by a test at
all.

Not reachable today: `packages/sweep/src/sweep.ts`'s `say()` is the only
producer that ever writes `atSec` onto the `?ns=progress` stream this app
reads, and its own `sec()` (line 1777) is `Math.round(...)` — always a whole
number. `packages/swarm/src/orchestrator.ts` writes a genuinely fractional
`atSec` (`Math.round(sec() * 10) / 10`, one decimal) on its own `landings`,
but nothing wires the swarm orchestrator's timeline into this stream today.
So this is the same shape SELF-576 already argued for and the codebase's own
test suite already treats as in-scope: a value the type and the existing
tests both accept as legitimate, silently mishandled by a sibling function
that assumed it could never arrive.

Confirmed non-vacuous by mutation: stashed just the two `.tsx` fixes (kept
the new tests) and reran — both new assertions failed with the exact
predicted output (`"01:5.299999999999997"` in the rendered HTML,
`clockPrefix is not a function` before the export existed); restored the
fixes and reran clean before staging.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3350 tests passing (up from 3345, five new test cases —
one in `DecisionsStrip.test.tsx`, four in `BuildWorkflow.test.ts` including
`clockPrefix`'s existing-behaviour cases), 13 skipped (same gated census as
SELF-576). Web-only change: type-checked and unit-tested per the routine's
own limits, not visually verified in a browser.

Backlog item: SELF-577

**SELF-578 (2026-09-30 overnight fire) — a basename cross-reference found
`PlanCard.tsx` itself never literally named in this doc (two prior fires,
SELF-111/SELF-170, had read and tested it, but under commit messages this
file never quoted), and a fresh adversarial read turned up a real bug: the
survived-filter chip could claim a fact it had no data for.**
`plannedDropped(delivered, written)` returns 0 both when the filter
genuinely dropped nothing AND when `written` never rode the frame at all —
its own test in `types.test.ts` pins the second case explicitly ("is zero
when written is absent — no catalog frame to compare against"). `PlanCard.
tsx`'s dropped-queries chip gated only on `dropped > 0`, so both zeros
rendered the same emerald claim, "every written query survived the name
filter" — on a run with no written count to back that claim, not just on
one that measured zero drops. Ironic given the file's own comment two lines
above (the "THE CHIP THAT COULD ONLY EVER SAY YES" note) already narrates
retiring exactly this shape once, for the chip `dropped` replaced.

Fixed by gating the chip pair on `plan.written !== undefined`, matching the
precedent already set one chip over (`plan.requested !== undefined`, `plan.
written !== undefined` for the two chips right above it) — when written is
absent, PlanCard now shows neither chip rather than asserting a fact it
cannot back. Added a test reproducing the exact case (a plan with queries
but no `written` field); reverted just the `.tsx` fix to confirm it fails
first (the emerald chip's text was present in the markup), then restored
the fix.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3351 tests passing (up from 3350, one new), 13 skipped
(same gated census as SELF-577). Web-only change: type-checked and
unit-tested per the routine's own limits, not visually verified in a
browser.

Backlog item: SELF-578

**SELF-579 (2026-09-30 overnight fire) — a basename cross-reference against the
full commit log turned up several `prompts/`/`skills/` files never named there;
reading them against the code they describe found one stale fact in
`skills/mapping-markets/references/troubleshooting.md`.** Its "It ran, but
slowly" section reads: "A long gap before the first search is the catalog,
three concurrent calls." `sweep.ts`'s own doc comments on the catalog stage
(around line 714) say otherwise: a block headed "The three lenses the catalog
is written through, in parallel" is immediately followed by a second one
headed "The lenses are gone: the PRODUCT is the unit now" — the three-lens,
three-concurrent-call design this troubleshooting line describes was replaced
by a per-product catalog call, `CATALOG_CONC = 6` (sweep.ts:3296), run through
`runPool` over every funded product. The file's own comment even narrates why
6 and not "unleashed": `funded.length` is now the company's whole product
count, so a bare `Promise.all` would fire that many concurrent model calls at
once — a small pool, not a wide one, same fix already used elsewhere in this
file. Checked for a second copy of the "three concurrent calls" claim
elsewhere (ARCHITECTURE.md, SKILL.md, the other skills references, CHANGELOG.md)
and found none — this was the only place it survived.

The rest of that troubleshooting section held up under the same check:
"calls run 20 at a time" matches `sweep.ts`'s default `CONC = Math.floor(opts.
concurrency ?? 20)` (line 1619); "30s cap on any one page" matches the
`timeoutMs` default of `30_000` in both `brightdata.ts:147` and
`sweep.ts:666`; "the planner runs alongside the searching" matches the
"planner runs beside them" comment at sweep.ts:4228; and the dev-server port
(":3210") matches `packages/web/package.json`'s own `--port 3210`. Also read
`prompts/agents/discover.md` and `prompts/agents/drop-confirm.md` end to end
against their consuming code (`discovery.ts`'s `readPage`/`findDocs` tools,
`tools.ts`'s `RELATIONS` enum) and `prompts/doctrine/05-reading-the-web.md`'s
llms.txt hit-rate claim ("10 of 14... 12 with a docs subdomain") against
`prompts/swarm/skill.md`'s copy of the same figure — all three matched their
code and each other; no second bug found in this pass.

Fixed by rewriting the one stale line to name the current mechanism instead
of the retired one: "one model call per product, six concurrent
(`CATALOG_CONC`)."

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3351 tests passing (same as SELF-578, docs-only change),
13 skipped (same gated census).

Backlog item: SELF-579

**SELF-580 (2026-09-30 overnight fire) — `scripts/show-prompt.ts`'s own
`promptStats` re-derived the frontmatter `includes` parse `core/src/
prompts.ts`'s `composePrompt` already ran, byte-for-byte, with a third
hand-copied instance in `prompts.test.ts`.** Same shape as SELF-555's
`identityKey` and SELF-553's `isAbortError`: a private one-liner
(`(agent.frontmatter.includes ?? "").replace(/[[\]]/g, "").split(",")
.map(s => s.trim()).filter(Boolean)`) hand-copied across files that must
agree, with nothing enforcing it — real drift risk since show-prompt.ts's
whole reason to exist is reporting on the SAME prompt composePrompt sends,
and it already imports composePrompt from that module.

Fixed by exporting `parseIncludes(raw: string | undefined): string[]` from
prompts.ts, having composePrompt call it, and pointing show-prompt.ts and
the test's own assertion at the same export — no behaviour change, one copy
instead of three. Added a dedicated 3-case test block (bracketed list, the
`undefined` fallback, trailing-comma/empty-bracket handling); verified
non-vacuous by mutation (swapped the parse regex for a no-op, 7 tests failed
with the wrong output, restored the fix).

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3354 tests passing (up from 3351, three new), 13 skipped
(same gated census as SELF-579).

Backlog item: SELF-580

**SELF-581 (2026-09-30 overnight fire) — `prompts/agents/triage.md`'s
opening line told the model it always sees sixty hosts — twice the batch
size it has been handed since e2e7ba3 halved `TRIAGE_BATCH` to 30.**
`e2e7ba3` updated the constant and its doc comment after runs showed 60-row
batches timing out at the 120s call ceiling, but never the prompt text a
prior commit had written when the batch really was sixty — nothing diffs
prompt prose against the constant it describes. `drop-confirm.md`, the
sibling prompt with the same "hosts below" shape, already states no count
at all ("each of these hosts"), sensible since a batch is capped, not
fixed.

Fixed by rewording the line to "These hosts came back from searches about
one market." — no count claimed, matching drop-confirm.md's style. No code
or schema touched; checked for a second copy of "Sixty hosts" anywhere else
and found none.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3354 tests passing (same as SELF-580, prompt-text-only
change), 13 skipped (same gated census).

Backlog item: SELF-581

**SELF-582 (2026-09-30 overnight fire) — backlog file lost sync with its own
last two commits, same drift class SELF-557 already fixed once.** This
file's own stated contract is that it "carries every item with its measured
evidence and file:line pointers," but SELF-580 (4b76771, the `parseIncludes`
de-duplication) and SELF-581 (d5bed71, the `triage.md` stale host count)
each landed real work without either touching this file — confirmed by
diffing `git log a7bbc57..HEAD --oneline` against `git log a7bbc57..HEAD
--oneline -- docs/overnight-backlog.md`, whose last entry was SELF-579
(daf864a's sibling read pass) before this fire.

Appended the SELF-580 and SELF-581 entries above from their own commit
messages, cross-checked against current source (`core/src/prompts.ts`'s
`parseIncludes` export and its two call sites, `prompts/agents/triage.md`'s
current opening line). No code changed.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3354 tests passing (unchanged — same gated census as
SELF-581; this touches only prose).

Backlog item: SELF-582

**SELF-583 (2026-09-30 overnight fire) — SELF-581 fixed `triage.md`'s stale
"sixty hosts" but two comments inside `sweep.ts` itself, the file that
actually halved `TRIAGE_BATCH`, still said the same wrong thing.** A
basename cross-reference against the full commit log turned up
`prompts/agents/group.md`, `investigator.md` and `link.md` as never-quoted
prompt files; reading `group.md` end to end against its consumer
(`sweep.ts`'s `prompt("group", ...)` call and `SweepOptions.discovery`'s doc
comment describing it) found nothing wrong, but reading the surrounding
`SweepOptions` doc block turned up the real gap. `grep -rn "sixty"
packages/sweep/src/sweep.ts` found thirteen hits; twelve cite
`SECOND_LOOK_CAP`/`DROP_CONFIRM_CAP` (both still 60, confirmed by reading
both exports) or the hardcoded `.slice(0, 60)` sample size in the `assess`
prompt builder (confirmed by reading it directly) — all correct. Two, both
about `TRIAGE_BATCH`, were not:
  - The `SweepOptions.triage` field's own doc comment: "Ask a model, in
    batches of sixty and from search metadata alone, which hosts are worth a
    fetch..." — `TRIAGE_BATCH` (sweep.ts:383) is 30, and its own comment
    says why: "Was 60: ... showed timing out at the 120s call ceiling four
    times in fourteen calls ... Thirty halves the rows." The field comment
    documenting the same flag never got the update.
  - `LISTICLE_MAX_ROWS`'s doc comment cited "TRIAGE_BATCH's precedent, sixty
    rows of title and description is comfortably inside one call's input
    floor" to justify its own 60-row cap — citing a number that was true
    only while `TRIAGE_BATCH` was itself 60, before the same timeout halved
    it. `LISTICLE_MAX_ROWS` was never touched by that halving and has no
    measurement of its own on record.

Fixed the first by naming the constant instead of a bare number ("batches of
TRIAGE_BATCH hosts"), the same drift-resistant idiom the same doc block
already uses two fields down ("`TRIAGE_KEEP_SEENIN`-many distinct
queries") — a number in prose can go stale the moment the constant next
changes; a name cannot. Fixed the second by historicizing the citation
("sixty rows ... sat comfortably ... back when TRIAGE_BATCH was itself 60")
rather than asserting a false current fact, and added the honest caveat
that timeout-driven halving "has never been re-checked against this
constant" — checked `LISTICLE_MAX_ROWS`'s only call site (sweep.ts:4960,
`.slice(0, LISTICLE_MAX_ROWS)`) and no test or run measurement bounds its
own call time, so leaving the cap at 60 rather than guessing a change is the
right scope for a comment fix, not a behaviour one.

`group.md`, `investigator.md` and `link.md` themselves: read all three
against their consuming code (`prompt("group", ...)` / `prompt("link", ...)`
call sites in sweep.ts; `packages/core/src/investigator.ts`'s
`composePrompt("investigator", ...)` call against the tool set it hands the
agent — `fetch`'s `direct`/`unlocked` modes in `packages/core/src/tools.ts`
match `investigator.md`'s "free"/"slow expensive mode" claims exactly) — no
stale claims found in any of the three.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3354 tests passing (unchanged — comment-only change, same
gated census as SELF-582).

Backlog item: SELF-583

**SELF-584 (2026-09-30 overnight fire) — `normalizeDomain` was exported
twice, byte-for-byte identical over its first three lines, under the same
name in two different files.** A sweep for repeated top-level function/const
definitions across `packages/*/src` and `packages/web` (group every
declaration by name, look for more than one hit) turned up
`lib/anchor.ts:39` (the `POST /api/map` door — strip scheme/path/www, then
refuse anything failing a hostname-shape check or `isReservedHost`) and
`components/SiteIcon.tsx:21` (the favicon chip's own copy, carrying only the
first three lines — no shape or reserved-host check). Both ran the identical
scheme-strip / path-strip / www-strip in the same order with the same two
regexes. `SiteIcon`'s copy was also the one `KbBrowser.tsx` already imports
(`from "@/components/SiteIcon"`, line 133) for its own manifest-root link —
one implementation, two addresses, no test tying them together.

Checked reachability first: `SiteIcon`'s `domain` prop only ever receives an
already-classified entity's `.domain` field or `hostOf(url)`'s output
(SELF-556 already confined that to a bare hostname) — always a real
registrable business hostname, never a bare IP, single-label name, or
internal suffix, so adopting `anchor.ts`'s stricter rule changes nothing
reachable today. Same "free fix, unreachable gap" shape as SELF-556/SELF-509.

Fixed by widening `anchor.ts`'s `normalizeDomain` to accept `null` as well as
`undefined` (its `typeof input !== "string"` guard already treated both
identically) and having `SiteIcon.tsx` import and re-export that one
implementation instead of carrying its own copy. `KbBrowser.tsx` needed no
change. Every existing case in `SiteIcon.test.tsx` and `anchor.test.ts`
passes unchanged under the shared function — ran both suites rather than
adding a new test, since the two files already independently covered the
shape this merges.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3354 tests passing (unchanged — no behaviour moved for any
covered input), 13 skipped (same gated census as SELF-583).

Backlog item: SELF-584

**SELF-585 (2026-09-30 overnight fire) — a repeated coverage sweep (SELF-509's
own snapshot, re-run to check for drift since 2026-09-17) confirmed no new gap
had opened in 68 commits of activity, so this fire read `export-kb.ts`'s `fm()`
end to end instead and found the frontmatter it writes is invalid YAML the
moment a field holds a colon.** `fm()` built every value with
`JSON.stringify(String(v)).slice(1, -1)` — `JSON.stringify` quotes and escapes
the string, and the `.slice` then threw the quotes away while keeping the
escaping, on every field including `name`, which is classifier-written free
text, unlike `kind`/`relation`/`tier`'s fixed vocabulary. A colon-bearing name
(`"Salesforce: Sales Cloud"`, the shape an ordinary product tagline takes)
produced the frontmatter line `name: Salesforce: Sales Cloud` — a second,
unquoted colon. Verified directly rather than assumed: generated that exact
block and fed it to PyYAML (`yaml.safe_load`), which refused it outright —
"mapping values are not allowed here" — the same failure a real YAML reader
(js-yaml, Obsidian's own frontmatter parser, the tool this export's wikilinks
are written for) gives. An embedded quote or backslash broke the same way,
silently, for the same reason: the old code discarded `JSON.stringify`'s own
escaping along with the quotes that made it valid.

Fixed with a `yamlSafe(s)` predicate — no control character, quote or
backslash, no `": "`/trailing `:`, no leading YAML-special character — that
rides a value unquoted only when none of those apply, and wraps it in
`JSON.stringify(s)` (quotes kept this time) otherwise. Verified against
PyYAML: the fixed block for the same colon-bearing name now parses to
`{"name": "Salesforce: Sales Cloud", ...}` cleanly. Added a test asserting the
emitted line is `name: "Salesforce: Sales Cloud"`, not the old unquoted shape,
and that an untouched vocabulary field (`relation: competitor`) still rides
bare — no reformatting of what was never broken. Verified non-vacuous by
mutation: stashed just the source fix, reran — the new test failed showing the
exact broken line, restored the fix and reran clean before staging. Scope:
`fm()` has exactly one call site (`entities/`'s frontmatter block) — checked
by grep — so no other emitter needed the same fix.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3355 tests passing (up from 3354, one new), 13 skipped
(same gated census as SELF-584).

Backlog item: SELF-585

**SELF-586 (2026-10-01 overnight fire) — chasing three critical CVEs in the
pinned `next@16.2.12` turned up something worse already on this branch:
`next build --webpack`, the command every real deployment of this app runs,
has failed outright since before this fire, on the version already shipping
today, for a reason that has nothing to do with the version bump.** Started
from `pnpm audit`, a genuinely new angle no prior SELF-<n> had tried: 3
critical (Next.js RCEs, GHSA-p293-qw3h-jr36/2xp9-vwfh-vxw4/vcvr-r3jv-pc5j, all
fixed by `>=16.3.3`/`>=16.3.6`), plus `next`'s own bundled `sharp`/`postcss`
riding along at high/moderate. Bumped `packages/web/package.json`'s `next` to
`16.3.8` (latest 16.x patch) and `pnpm install`d — `pnpm audit` dropped from 22
findings to 13, all three criticals and both bundled-dependency highs gone,
the remaining 13 all transitive through `ai`/`vitest`, a different package and
a separate item. `pnpm check && pnpm test` both passed clean on the bump
alone. Then, because neither of those two gates has ever once invoked the
command `packages/web/package.json`'s own `"build"` script names, ran
`pnpm --filter @open-kb/web build` as a third check before trusting the bump —
and it failed: `UnhandledSchemeError: Reading from "node:fs" is not handled by
plugins`, tracing through `core/src/index.ts` to `components/kb/NoteView.tsx`,
a `"use client"` component.

Reverted the version bump to isolate the cause (`git stash`, reinstall) and
ran the same build against the UNCHANGED `next@16.2.12` already on this
branch: identical failure, same `UnhandledSchemeError`, same `node:fs`/
`node:path`, a different but structurally identical trace through
`lib/anchor.ts` → `components/SiteIcon.tsx`. Not a regression from the bump —
a pre-existing break neither `pnpm check` (type-checks only) nor `pnpm test`
(vitest, never shells out to `next build`) has ever been able to see, on the
version this branch has run since before night 1. `transpilePackages:
["@open-kb/core", ...]` (`next.config.ts`) means webpack compiles
`@open-kb/core` from source for every bundle it reaches, client included, and
`core/src/index.ts`'s barrel does `export * from "./prompts.js"` — a module
that imports `node:fs`/`node:path` at the top level for `loadPrompt`, used by
nothing either client file calls. Webpack has to resolve every module an
`export *` names before it can tree-shake any of them away, and resolving
`node:fs` for a browser target fails before tree-shaking ever gets a turn.
`NoteView.tsx` wanted only `receiptSource` (`export-kb.ts`, a pure string
formatter); `anchor.ts` wanted only `isReservedHost` (`url.ts`, pure, imports
nothing). Both are reachable through the same barrel as `prompts.ts`, so
importing either one made webpack choke on an import neither file's export
chain ever actually touches. Tried fixing it IN `next.config.ts` first — a
`!isServer` `resolve.fallback: { fs: false, path: false }`, then a
`resolve.alias` stripping the `node:` prefix before fallback — neither
changed the error at all, byte-for-byte identical trace both times:
`resolve.fallback`/`resolve.alias` only ever see a bare specifier, and
webpack's `node:` URI SCHEME is rejected before either gets a turn (the error
is "unhandled scheme", not "module not found"), confirmed by testing both
and watching nothing change.

Fixed at the actual boundary instead: added two narrow subpath exports to
`packages/core/package.json` (`"./export-kb"` → `src/export-kb.ts`,
`"./url"` → `src/url.ts`), the same convention this package already uses for
`"./testing"`, and pointed `NoteView.tsx`/`anchor.ts` at those subpaths
instead of the bare `@open-kb/core` root. Checked both new entry points'
full transitive closure by hand before trusting them: `export-kb.ts` imports
only `url.ts` and `judge.ts`; `judge.ts` imports `sniff.ts`, `verdict.ts`,
`url.ts`, `coverage.ts`, `grounding.ts`, `evidence.ts`, `ports.ts` — none of
those eight files has an `import` statement touching anything outside the
package, let alone a Node builtin. `url.ts` itself imports nothing. Six other
`packages/web` files import the bare `@open-kb/core` root today
(`api/kb/[id]/export/route.ts`, `api/map/route.ts`,
`api/run/[id]/stream/route.ts`, `lib/spend-limits.ts`, `lib/stream-adapter.ts`,
`lib/kb-from-run.ts`, `lib/runs.ts`, `lib/store/supabase.ts`) — left alone:
every one is either a route handler (server-only by construction) or a
`lib/` file not checked here for client reachability, a genuinely open
question for a future fire rather than this one, which fixes the two traces
an actual failing build named.

Added a regression test to each fixed file's own test file
(`NoteView.test.ts`, `anchor.test.ts`): a source-grep asserting the subpath
import is in place and the bare import is not. Verified non-vacuous by
mutation — reverted both imports to the bare specifier, both new tests
failed on the exact assertion the fix makes true, restored and reran clean.
Not a substitute for a real build check in CI (this file's own rules allow
no scope for adding `next build` to the hot `pnpm check` path from inside a
single-item fire — a legitimate next step, not this one), but it pins the
one thing a future edit could silently undo without ever running the build
that would catch it.

Re-applied the `next@16.3.8` bump on top of the import fix and reran all
three gates end to end: `pnpm check` exit 0, `pnpm test` exit 0 (3357 tests
passing, up from 3355 — the two new regression tests — 13 skipped, same
gated census as SELF-585), and `pnpm --filter @open-kb/web build` completed
with `✓ Compiled successfully`, all 16 routes generated, zero webpack errors.
`pnpm audit` after the bump: 13 findings, 0 critical, 0 high in anything this
app's own dependency tree owns (the remaining 3 high/7 moderate/3 low are
`undici` via the `ai` SDK and `nanoid`/`vitest`'s own path-traversal advisory
via `vite`'s dev server — a different package each, a future SELF-<n>, not
widened into this one).

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3357 tests passing (up from 3355, two new), 13 skipped
(same gated census as SELF-585). `pnpm --filter @open-kb/web build` also
verified green, the first time this branch's history shows that command
being run as part of landing a change.

Backlog item: SELF-586

**SELF-587 (2026-10-01 overnight fire) — closed the gap SELF-586 named by
hand as its own legitimate next step: `next build --webpack` ran nowhere
except on a human's keyboard, so a regression of the same shape it just fixed
would ship invisibly again.** SELF-586's own commit message says so directly:
its two source-grep regression tests pin the two call sites that fire found,
but "a real build check in CI... [is] a legitimate next step, not this one" —
neither `pnpm check` (type-checks only, never resolves webpack's module
graph for a browser target) nor `pnpm test` (vitest, never shells out to
`next build`) can catch a *new* client component making the same bare
`@open-kb/core` mistake, only a real build run against the whole client
bundle can.

Added `pnpm --filter @open-kb/web build` as its own step in
`.github/workflows/check.yml`, after `pnpm test`, with
`NEXT_TELEMETRY_DISABLED=1` on that step only (checked: unset, the build logs
Next's phone-home notice and the telemetry client at least attempts a
network call in the background; this repo's whole practice around outbound
calls is to be deliberate about them, and a CI job is not the place to leave
that implicit per-contributor). Deliberately NOT folded into the hot `pnpm
check` path — SELF-586 already ruled that out for the same reason this item
doesn't revisit it, and `pnpm check` is also what a contributor runs locally
before every commit, where the extra ~20s would be paid on every edit rather
than once per push.

Verified rather than assumed: ran `pnpm --filter @open-kb/web build` locally
with and without `NEXT_TELEMETRY_DISABLED=1` set — the banner
("Attention: Next.js now collects completely anonymous telemetry...")
appears only in the unset case, confirming the env var actually suppresses
the thing it's there to suppress, not just a presumed no-op. Build itself:
exit 0, 16 routes generated (`/`, `/kb`, `/kb/[id]`, `/runs`, `/runs/[id]`,
five `/api/*` routes, `/film`, `/story`, `/_not-found`, proxy middleware),
zero webpack errors, in ~23s — well inside `check.yml`'s existing 15-minute
job timeout.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3357 tests passing, 13 skipped (same
gated census as SELF-586 — a CI-workflow-only change touches no test file).

Backlog item: SELF-587

**SELF-588 (2026-10-01 overnight fire) — a genuinely new angle, static circular-
dependency analysis, never tried by any prior fire, found and fixed the only
cycle in `@open-kb/core`.** Every prior self-discovered fire in this class
either hand-read files one at a time or instrumented coverage/knip; none had
run a dependency-graph tool. Installed `madge@8.0.0` via `pnpm dlx` (never
added to `package.json`/`pnpm-lock.yaml`) and ran `madge --circular
--extensions ts` over each of the four library packages' `src/`:
`packages/sweep`, `packages/swarm` and `packages/providers` all came back
clean; `packages/core` reported exactly one cycle: `discovery.ts > index.ts`.

Traced it by hand: `discovery.ts` imported `FetchPort`/`SpanStream` with
`import type { FetchPort, SpanStream } from "./index.js"` — the package's own
barrel, which itself does `export * from "./discovery.js"` (`index.ts:49`),
closing the loop. A `grep` across `packages/core/src` confirmed this was the
only file in the package importing from its own `./index.js`. Both types are
`import type`, so the cycle is erased before anything ever runs and nothing
was actually broken — the real finding is that it is also unnecessary:
`FetchPort` is defined in `ports.ts`, `SpanStream` in `spans.ts`, and two
other files that need `SpanStream` (`spend-cap.ts`, `tools.ts`) already import
it directly from `./spans.js` rather than through the barrel. `discovery.ts`
was the one holdout, not a file with a real reason to go through `index.ts`.

Fixed by pointing the import at the two defining modules instead
(`./ports.js` for `FetchPort`, `./spans.js` for `SpanStream`), matching the
convention every sibling file already follows, and left a comment at the
import site naming the tool that found it and why the two types moved.
Re-ran `madge --circular` after the edit: zero cycles in `packages/core/src`.
No test added — this is a type-only import whose only observable effect is
on the dependency graph a tool like `madge` reads, not on any runtime
behaviour a vitest fixture could assert against; `tsc -b`, already part of
`pnpm check`, is what proves the new import paths still resolve and the
types are unchanged.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3357 tests passing, 13 skipped (same
gated census as SELF-587 — a type-only import-path change adds no test).

Backlog item: SELF-588

**SELF-589 (2026-10-01 overnight fire) — closed the two transitive vulnerabilities
SELF-586 named by hand as a future fire's job rather than widening its own
`next@16.3.8` bump to cover.** SELF-586's `pnpm audit` after that bump read
"13 findings, 0 critical, 0 high in anything this app's own dependency tree
owns (the remaining 3 high/7 moderate/3 low are `undici` via the `ai` SDK and
`nanoid`/`vitest`'s own path-traversal advisory via `vite`'s dev server — a
different package each, a future SELF-<n>, not widened into this one)." Rechecked
with a fresh `pnpm audit` before touching anything: same 13 findings, same
three sources — `undici@7.29.0` (3 high, 2 moderate, 2 low, all patched at
`>=7.29.1`) via `ai>@ai-sdk/provider-utils>undici`; `nanoid@3.3.16` (1 high,
patched at `>=3.3.18`) via `vitest>vite>postcss>nanoid`; and
`vitest@3.2.7`/`@vitest/mocker` (2 moderate, patched at `>=4.1.11`) via the
direct `vitest` devDependency itself.

The first two are one-patch-version-away transitive deps neither declared
directly nor reachable through a version bump of anything this repo owns —
`ai@^7.0.48` and `vitest@^3.0.0` both already resolve their own `undici`/
`nanoid` ranges to the vulnerable patch; only `pnpm.overrides` reaches past
them. Added two entries to a new `pnpm.overrides` block in the root
`package.json` — `"undici@<7.29.1": "7.29.1"` and `"nanoid@<3.3.18":
"3.3.18"` — pinned to the exact patched version each advisory names, not an
open `>=` range: resolving to just-released `latest` is not what either
advisory asks for and carries its own unreviewed blast radius (confirmed by
trying the open-range form first — it resolved `undici` to `8.11.2` and
`nanoid` to `6.0.1`, two major versions past what fixing the CVE needs, and
was replaced with the exact-pin form before running the real verification
below). Deliberately left the third finding alone: `vitest@4.1.11` is a
major-version bump of this repo's actual test runner, not a transitive
override, and SELF-545/549/550/561/563's own pattern of reverting or
narrowly scoping risky changes applies here too — a runner major bump needs
its own fire to read vitest 4's migration notes against this repo's test
suite, not a few paragraphs inside a dependency-audit item. Recorded here so
a future fire does not re-discover the same two closed findings: only the
`vitest@4.1.11` path-traversal advisory remains open after this fire.

Verified the override actually lands rather than trusting the manifest
change alone: `pnpm install` then `grep '^  undici@\|^  nanoid@'
pnpm-lock.yaml` shows `undici@7.29.1`/`nanoid@3.3.18` as the only resolved
versions of either package in the lockfile (both were single entries before
too — no duplicate-version split to worry about), and a second `pnpm audit`
afterward dropped from 13 findings to 2, both the `vitest` advisory left
alone on purpose. Neither package's own code is imported by anything this
repo calls directly — `undici` only fires on an actual network round-trip
through the `ai` SDK (gated behind `OPENKB_LIVE=1`, never exercised by an
offline test) and `nanoid` is `postcss`'s own build-time id generator inside
`vite`'s dev server, never loaded by code under test — so a patch-version
bump of either carries no behavioural surface this test suite could catch
regardless; `tsc -b` (already part of `pnpm check`) is what would catch an
actual type signature change, and found none.

`pnpm install` first (fresh clone, no `node_modules`, needed to re-resolve
the lockfile against the new override). `pnpm check && pnpm test` both exit
0: 3357 tests passing (unchanged — a dependency-pin change touches no test),
13 skipped (same gated census as SELF-588).

Backlog item: SELF-589

**SELF-590 (2026-10-01 overnight fire) — closed the one `pnpm audit` finding
SELF-589 left open on purpose: `vitest@3.2.7`/`@vitest/mocker`'s path-traversal
advisory, patched at `>=4.1.11`.** SELF-589 named this explicitly as "a major
version bump of this repo's actual test runner, not a transitive override...
a runner major bump needs its own fire to read vitest 4's migration notes
against this repo's test suite, not a few paragraphs inside a
dependency-audit item" — this is that fire.

Checked compatibility before touching anything: `vitest@4.1.11`'s own
`package.json` declares `"engines": { "node": "^20.0.0 || ^22.0.0 ||
>=24.0.0" }`, and this environment runs `node v22.22.0`, inside range.
`vitest.config.ts` uses only `defineConfig`, a `resolve.alias` and
`test.include` globs — none of the options vitest 4's migration notes flag
as changed (no custom `pool`, no `deps.inline`, no snapshot serializer, no
`environmentMatchGlobs`). Bumped `package.json`'s `"vitest": "^3.0.0"` to
`"^4.1.11"`, the exact patched version the advisory names, matching
SELF-589's own precedent of pinning to the advisory's fix version rather
than an open range.

`pnpm install` resolved `vitest@4.1.11` and its first-party `@vitest/*`
packages (`expect`, `mocker`, `pretty-format`, `runner`, `snapshot`, `spy`,
`utils`) to `4.1.11` throughout, `vite` itself staying at `7.3.6` (already
in range, no transitive major bump riding along). `pnpm audit` afterward:
**0 findings**, down from the 2 SELF-589 left open — the only remaining
advisory in this tree is now closed.

Verified rather than assumed: ran the full suite twice before touching the
backlog file. `pnpm check && pnpm test` both exit 0 — identical census to
SELF-589 (3357 tests passing, 13 skipped across the same 7 gated suites,
230 test files collected) — so vitest 4's runner changes (its rewritten
`@vitest/mocker`, the new `tinyrainbow` 3.x it pulls in place of 3.2.7's
own) changed nothing this suite's assertions depend on. No test added: a
devDependency version bump with an unchanged green census has no new
behavior for a vitest fixture to pin, and `pnpm audit` itself is the
regression check a future `pnpm-lock.yaml` edit could silently undo.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3357 tests passing, 13 skipped (same gated census as
SELF-589). `pnpm audit`: 0 findings (down from 2).

Backlog item: SELF-590

**SELF-591 (2026-10-01 overnight fire) — closed the client-reachability
question SELF-586 named by hand and left open: whether any of the eight
`packages/web` files still importing the bare `@open-kb/core` root (or, for
the `lib/` ones, a Node builtin directly) are pulled into the CLIENT
bundle the same way `NoteView.tsx`/`anchor.ts` were.** SELF-586's own
commit read "every one is either a route handler (server-only by
construction) or a `lib/` file not checked here for client reachability, a
genuinely open question for a future fire" — this is that check, not a
guess from reading file headers: three of the eight
(`api/kb/[id]/export/route.ts`, `api/map/route.ts`,
`api/run/[id]/stream/route.ts`) are route handlers, server-only by
construction as SELF-586 already said; the other five
(`lib/spend-limits.ts`, `lib/stream-adapter.ts`, `lib/kb-from-run.ts`,
`lib/runs.ts`, `lib/store/supabase.ts`) are plain modules a client
component could in principle import.

Grepped every `packages/web/{app,components}` file for a real (non-comment)
import of each of the five, anchored on `^import` so a prose mention like
"see lib/kb-from-run.ts's RELATION_WEIGHT" (both `GraphCanvas.tsx` and
`KbOverview.tsx` carry several) could not be mistaken for a code
dependency — an easy trap, since a first unanchored grep for the bare
string `kb-from-run` and `lib/runs` did return those two "use client"
files, `BuildWorkflow.tsx` and `DemoHome.tsx`, among its hits, and every
one of those turned out to be a comment line, not an import, once
re-checked against `^import`. With that anchor, the only real importers of
the five are `app/**/page.tsx` (Server Components — none carries a `"use
client"` directive, checked each by hand) and `app/api/**/route.ts` (server
by construction), plus other `lib/` files and `scripts/bake-layouts.ts`
(a build-time script, never shipped to the browser). The one indirect path
worth tracing further: four client components (`GraphCanvas.tsx`,
`KbOverview.tsx`, `NotesTab.tsx`, `ProductsTab.tsx`) import `lib/viewTypes.ts`,
`lib/scorecard-view.ts` or `lib/notes-view.ts`, and those three do carry
prose references to `kb-from-run.ts`. Read all three: each imports only
`import type { ... } from "./viewTypes"` (or, for `viewTypes.ts` itself,
`import type { NodeType } from "./nodeTypes"`) — type-only, erased before
webpack ever sees a module graph — so the comment trail is documentation,
not a runtime edge. `GraphCanvas.tsx` does pull one real (non-type) value
across this boundary, `RELATION_BLURB` from `viewTypes.ts`, but `viewTypes.ts`
defines it locally and has no runtime import of its own, so the value never
touches `kb-from-run.ts`, `runs.ts` or any Node builtin.

Conclusion: none of the five `lib/` files is reachable from a client
component today, so the shape of break SELF-586 fixed for `NoteView.tsx`/
`anchor.ts` cannot currently recur through any of the eight files it named.
Recording this so a future fire does not re-open the same question — the
risk instead sits one level up, at the moment any of these five files
gains a new caller: nothing in this repo's `pnpm check` (type-checks only)
would flag a new client import of a server-only module until the CI-only
`pnpm --filter @open-kb/web build` step SELF-587 added actually runs it
through webpack.

No code change — the question was reachability, not a bug in any file
touched. `pnpm install` first (fresh clone, no `node_modules`). `pnpm check
&& pnpm test` both exit 0: 3357 tests passing, 13 skipped (same gated
census as SELF-590; unchanged by a read-only fire).

Backlog item: SELF-591

**SELF-592 (2026-10-01 overnight fire) — `scripts/corroboration-arrival.ts`'s
own `hostOf` disagreed with the real engine's host identity for the exact
field the whole script exists to study.** Read every `scripts/*.ts` file's
`hostOf`-shaped helper against the real engine after noticing SELF-559 had
only checked these for BYTE duplication (`recall.ts` copied from
`query-yield.ts`), never for two helpers with the same name computing two
different things. `corroboration-arrival.ts`'s own header says `seenIn` —
"how many distinct queries returned a host" — is the field four real gates
read, one of them (`TRIAGE_KEEP_SEENIN`) irreversible, and the whole point of
this script is to price moving that gate earlier. But its `hostOf` was
`registrableHost(new URL(u).hostname.toLowerCase())` — collapsing every
subdomain of a registrable domain to one host — where the real `seenIn` the
search loop builds (`packages/sweep/src/sweep.ts:4177-4178`, and the same
exact expression again at 5186, 6305, 7510) is
`new URL(h.url).hostname.toLowerCase().replace(/^www\./, "")`, which keeps
`blog.x.com` and `shop.x.com` as two separate hosts. `query-yield.ts`'s own
`hostOf` (line 164-166) already uses the correct, narrower form — so the two
analysis scripts measuring the same `runs/` corpus were computing two
different "hosts," and only one of them matched what the triage gate
actually sees.

The direction matters: folding two distinct subdomains into one bucket means
two queries that each surface a DIFFERENT subdomain look like one host
corroborating itself twice, which can only make a host cross any
`--threshold` SOONER than the real `h.seenIn` would. That biases every
percentage this script has ever reported toward "less late" than reality —
the unsafe direction for a finding whose stated purpose is bounding how
risky an earlier gate would be. Not a theoretical path: a page site commonly
splits `blog.`, `shop.`, `docs.`, `support.` onto subdomains of one
registrable domain, and SERP results surface those as distinct URLs.

Fixed by importing `hostOf` from `query-yield.ts` (and re-exporting it, for
this file's own test's import path) instead of restating it — the same move
SELF-559 made for `recall.ts`'s copy, except that one was already
byte-identical to its source and this one was not, which is exactly why it
stood unnoticed through that pass. Removed the now-unused `registrableHost`
import. Left the header's own measured numbers (2,975 hosts, 49%/25%, the
38-69% per-run spread) in place with a caveat rather than inventing new ones
— `runs/` is gitignored and this clone has none to re-measure against, and
rewriting a measured number without a run to back it would be exactly the
"arithmetic dressed as evidence" SELF-515's own BLOCKED note already warns
against. A future fire with real runs on disk should re-run this script and
replace the caveat with the corrected figures.

Added two tests: `hostOf` keeps a subdomain distinct (`blog.example.com` stays
`blog.example.com`, not `example.com`), and `arrivalRow` on two single-
occurrence subdomains of one registrable domain returns `null` — neither
alone reaches `seenIn >= 2` — where the old registrableHost-folding code
merged them into one host that crossed the threshold at index 1. Confirmed
non-vacuous by mutation: reverted just the source file (keeping the new
tests), both new assertions failed exactly as predicted (`example.com`
instead of `blog.example.com`; a real row instead of `null`), then restored
the fix and reran clean before touching this file.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3359 tests passing (up from 3357, two new), 13 skipped
(same gated census as SELF-591).

Backlog item: SELF-592

**SELF-593 (2026-10-01 overnight fire) — own commit landed without updating
this file; appended here.** `projectHeadings` in
`packages/swarm/src/tools-free.ts` builds its HTML-heading projection with
`if (line) out.push(...)` (line 70), skipping any `<h#>` whose
`extractText()` reduces to `""`. Every test that had ever exercised this
function gave it a heading with real inner text ("Acme Scraper"), so the
skip arm — an image-only `<h2><img></h2>` with no words — had never run,
the same gap the icon-only-link test immediately below it had already
closed for `projectLinks`.

Measured with a temporary `@vitest/coverage-v8@4.1.11` devDependency
(matched this repo's vitest@4.1.11, reverted before finishing, same move
as SELF-509): `tools-free.ts` sat at 95% branch coverage with this line
named.

Added a test recording a page whose raw HTML carries one image-only `<h2>`
followed by a real `<h3>`, asserting the projected headings keep only the
real one. Verified non-vacuous by mutation: removing just the `if (line)`
guard made the new test fail (an empty "## " line ahead of "### Our
team"); restored the guard and reran clean before committing.

No source change — `tools-free.ts` already carried the loop as described;
only the test was added. `pnpm install` first (fresh clone, no
`node_modules`). `pnpm check && pnpm test` both exit 0: 3360 tests passing
(up from 3359, one new), 13 skipped (same gated census as SELF-592).

Backlog item: SELF-593

**SELF-594 (2026-10-01 overnight fire) — `packages/web/scripts/bake-layouts.ts`
sized every baked node off the wrong field: `n.relevance` unconditionally,
where the canvas it is supposed to mirror sizes off `n.prominence` by
default.** Read every file `git log --name-only` against this branch's own
history had never touched (77 of them, the same census SELF-513 used) that
still carries real logic rather than a barrel export; `bake-layouts.ts` was
one of a dozen candidates, picked because its own docstring makes the
strongest fidelity claim of any of them — "the bake cannot disagree with the
app about what the graph IS" — which is exactly the kind of claim worth
checking by hand rather than trusting.

GraphCanvas.tsx's `meta` memo and its node-building block both size a node's
drawn radius off `settings.sizeBy === "placement" ? n.relevance : n.prominence`,
and `lib/graph/settings.ts`'s `DEFAULT_SETTINGS.sizeBy` is `"prominence"` — a
count the run's own searches made (`seenIn`/`bestRank`, `kb-from-run.ts`'s
`prominenceOf`), not the classifier's placement judgement `relevance` encodes
(`RELATION_WEIGHT`). `bake-layouts.ts`'s `bakeVariant` read `n.relevance` for
both `maxRel` and each node's own `rel` with no gate at all — the `"placement"`
branch, unconditionally, on every bake, for a reader who (on a first visit,
the one case this file exists to serve) has never touched the settings panel
and is seeing the shipped default.

Measured rather than assumed: a temporary script (not committed) ran both
formulas — `4 + Math.sqrt(rel / maxRel) * 12`, byte-identical to the real
one — over all six committed demo maps' `graphOf()` output. The two metrics'
radii disagree by a mean of 7.65-8.25 units and a max of ~10.5, against the
4-16 unit range `r` is drawn in, on every one of the six maps — more than
half the node's size range, on average, with no map in the corpus landing
close. Since `r` feeds `seatRadius` (collide, link distance's seat argument,
the cluster pad) and `chargeStrength`'s non-hub branch directly, this was not
a cosmetic radius miss: the entire baked physics settle — where every node
ends up — was computed for a sizing mode nobody sees by default, which is
the opposite of what a seed file exists to provide.

Fixed by adding the same `sizeOf` gate GraphCanvas carries, keyed on
`DEFAULT_SETTINGS.sizeBy` (imported from `lib/graph/settings.ts`) rather than
a live `settings` object — there is no reader at build time, so the bake
mirrors the shipped default, the same thing "at the shipped defaults (cohesion
1, spacing 1)" already says about the lobe force two paragraphs up. Both call
sites (`maxRel` and each node's `rel`) now route through it.

`bake-layouts.test.ts` already exists for exactly this file, pinning five
other hand-copied constants against GraphCanvas.tsx as text (importing
`bake-layouts.ts` directly runs the whole bake — `readdirSync`/`mkdirSync` at
module scope — so every existing test in that file reads both source files
as strings rather than importing either). Added two more in the same style:
one asserting the fixed file reads `DEFAULT_SETTINGS.sizeBy` and contains no
unconditional `n.relevance` read, the other pinning the ternary's literal
text against GraphCanvas's own. Verified non-vacuous by mutation: reverted
just `bake-layouts.ts`, both new assertions failed (`not.toContain` tripped
on the restored `n.relevance` read; the ternary pin found no match in the
reverted file), then restored the fix and reran clean before committing.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3362 tests passing (up from 3360, two new), 13 skipped
(same gated census as SELF-593).

Backlog item: SELF-594

**SELF-595 (2026-10-01 overnight fire) — ran `madge --circular` against
`packages/web`, the one tree SELF-588's own sweep never reached, and
confirmed its single cycle is the same erased, type-only shape SELF-588
closed in core — except here there is no second file to redirect to, so
nothing was changed.** SELF-588 ran `madge --circular --extensions ts` over
`packages/sweep`, `packages/swarm`, `packages/providers` and `packages/core`
only; `packages/web` — bigger, React/Next, and the one package whose own
`tsconfig.json` defines a `@/*` path alias 65 files actually use — had never
been swept by this tool.

First pass, `madge --circular --extensions ts,tsx` over `app`, `lib`,
`components`, `middleware.ts` and `next.config.ts`: one cycle, but 48
warnings — madge cannot follow `@/...` without being told about the alias,
so most of those 65 files' edges were silently missing and the result was
not trustworthy as a completeness claim. Re-ran with `--ts-config
tsconfig.json` (the package's own file, which declares `"@/*": ["./*"]`):
same 217 files, same one cycle, warnings down to 4 — confirmed benign by
reading them (`madge.warnings()` via a one-off node script, not committed):
three workspace subpath exports outside the scanned dirs
(`@open-kb/core/testing`, `@open-kb/core/url`, `@open-kb/core/export-kb`) and
the `tailwindcss` CSS import, none of which can hide an edge inside
`packages/web` itself. One real cycle, now measured with the alias actually
resolved:

```
lib/runs.ts > lib/public-runs.ts > lib/store/supabase.ts
```

Traced by hand. `runs.ts` (1,247 lines) imports `./store/supabase` directly
(`import * as db`, a value import) and also imports `./public-runs`, which
itself imports `./store/supabase` the same way — both ordinary value edges,
both outbound from `runs.ts`'s side. The only edge pointing back, closing
the loop either through `public-runs.ts` or directly, is
`store/supabase.ts:3`: `import type { RunStatus, StoredRun } from "../runs"`
— `import type`, erased by `tsc` before anything runs, the identical shape
SELF-588 found between `discovery.ts` and `core/index.ts` ("the cycle is
erased before anything ever runs and nothing was actually broken").
`supabase.ts`'s other two imports (`Span`, `SweepResult`) are type-only too,
so no other edge contributes.

Where this stops being SELF-588's case: `FetchPort`/`SpanStream` each had a
real home outside the barrel that closed the loop (`ports.ts`, `spans.ts`),
so redirecting two import lines removed the cycle for good. `RunStatus` and
`StoredRun` have no second home — they are defined in `runs.ts` itself
(lines 31 and 35, with the multi-paragraph comment on `StoredRun.result`
and `.error` explaining what each field is for), because `runs.ts` is the
in-memory run registry and `store/supabase.ts` is its one persistence
backend, reading the registry's own types to describe what it stores. The
only way to remove this cycle at the type level too would be lifting
`RunStatus`/`StoredRun` into a third file neither `runs.ts` nor
`supabase.ts` owns — a real structural change for a graph-hygiene payoff
only, on two files with no other symptom, and the kind of drive-by
abstraction this branch's own rules single out. Left as is.

No code change. `pnpm install` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3362 tests passing, 13 skipped (same
gated census as SELF-594; unchanged by a read-only fire).

Backlog item: SELF-595 - BLOCKED

**SELF-596 (2026-10-01 overnight fire) — re-ran SELF-509's coverage sweep
rather than trusting its month-old result, and this time `packages/core/
src/audit.ts` had a gap that file didn't have back then: the errorKind
breakdown's own sort comparator had never been called.** Measured with a
temporary `@vitest/coverage-v8@4.1.11` devDependency (matched this repo's
vitest, reverted before finishing, same move as SELF-509/593): `audit.ts`'s
function coverage sat at 94.73% (18 of 19), naming line 288 —
`Object.entries(byErrorKind).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ?
-1 : 1))`, the comparator that orders the printed "wrong `<errorKind>`: N"
breakdown by count descending, alphabetical on a tie.

Every existing scoring test builds its wrong rows from `oneOfThirty`, which
carries exactly one distinct `errorKind`. `Array.prototype.sort` never
invokes its comparator on an array of 0 or 1 elements, so neither half of
that comparator — the count ordering or the alphabetical tie-break — had
ever actually run, on a function that is genuinely reachable (every
`scoreAuditPacket` call with more than one kind of mistake hits it), not a
structurally-dead branch like the other gaps this campaign has been
finding and leaving alone.

Added one test with three wrong rows across three of `AUDIT_ERROR_KINDS`,
two of them tied at count 3 (`aggregator-as-competitor`, `wrong-relation`)
and one at count 1 (`invented-capability`), asserting the sentences print
in `["aggregator-as-competitor: 3", "wrong-relation: 3",
"invented-capability: 1"]` order — count descending, alphabetical on the
tie. Verified non-vacuous by mutation: dropped just the `|| (a[0] < b[0] ?
-1 : 1)` tie-break from the comparator, reran — the new test failed
(`wrong-relation: 3` sorted ahead of `aggregator-as-competitor: 3`, the
unstable order `Array.sort` happened to produce without a tie-break);
restored the comparator and reran clean before committing. No source
change — `audit.ts` already carried the correct comparator; only the test
was missing.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3363 tests passing (up from 3362, one new), 13 skipped
(same gated census as SELF-595).

Backlog item: SELF-596

**SELF-597 (2026-10-01 overnight fire) — SELF-509's coverage sweep never
reached `packages/web`, so ran it there and found an untested branch in the
quota-eviction path that matters for a reason other coverage gaps in this
campaign have not: it shares localStorage with the rest of the app.**
Installed `@vitest/coverage-v8@4.1.11` (matched this repo's vitest, reverted
before finishing, same move as SELF-509/593/596), scoped to
`packages/web/lib/**/*.ts`. Every file there sits at 96-100% except
`useUrlView.ts` (54.76%), already explained and accepted by SELF-81's own
comment: the hook needs React's render lifecycle this repo has no jsdom/RTL
harness to drive, and the pure `readUrl`/`writeUrl` halves it exports for
testing are fully covered.

The one real gap: `lib/graph/layoutCache.ts:103`, inside `saveLayout`'s
quota-exceeded retry. On a failed write it scans every `localStorage` key and
evicts the ones matching `k.startsWith(PREFIX) && k !== key` to make room —
but the existing eviction test (`layoutCache.test.ts:124`) only ever put
other layout rows in storage, so the `startsWith(PREFIX)` guard's false arm
had never run. That guard is the only thing stopping this retry from wiping
out everything else sharing the store — concretely, `lib/graph/settings.ts`'s
own `kb-graph-settings` row sits in the exact same localStorage a quota
failure means is full.

Added a test seeding `kb-graph-settings` before arming the quota failure,
then asserting it survives the eviction that still lands the new layout and
still evicts the other map's row. Verified non-vacuous by mutation: dropped
just the `k.startsWith(PREFIX) &&` clause, reran — the new test failed
(`kb-graph-settings` read back `undefined`); restored the guard and reran
clean before committing.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3364 tests passing (up from 3363, one new), 13 skipped
(same gated census as SELF-596).

Backlog item: SELF-597

**SELF-598 (2026-10-01 overnight fire) — re-ran SELF-509's coverage sweep over
`packages/providers/src` and `packages/sweep/src`, the two packages SELF-596
and SELF-597 did not reach, and found `sweep.ts`'s whole reaction to a numeric
`opts.queries` had zero test coverage.** Installed a temporary
`@vitest/coverage-v8@4.1.11` devDependency (matched this repo's vitest,
reverted before finishing, same move as SELF-509/593/596/597).
`providers/src` is 100% lines (its remaining branch gaps are retry/backoff
arms a live network failure would hit, not a fixture-reachable one — left
alone, same shape SELF-509 already accepted for these two files).
`sweep/src` dropped from SELF-509's measured 98.3% lines to 97.3% in the
month since, naming a block this repo's tests had never touched:
sweep.ts:3858-3867's two `say()` calls, reacting to `opts.queries` — not
`opts.maxQueries` — a budget that clamps only the OPENING catalog. Every
`sweep()` call from the CLI (`scripts/sweep.ts:222`, `queries: TARGET`) sets
it; every sweep test on disk either left it unset or used `queries: [...]`
as a catalog mock's own field, never as the numeric option. Grepped every
test file for a numeric `sweepOptions: { queries: N }` and found none.

Added `a-bounded-probe-clamps-the-catalog-and-says-so.test.ts`: the default
fixture's two products write 16 queries total (`OPENING_WRITTEN`, already
pinned by `sweep-fits-the-clock-it-was-given.test.ts`), so `queries: 10`
exercises the over-budget arm ("catalog: model wrote 16 for a budget of 10 —
using the first 10") and `queries: 20` exercises the under-budget arm
("catalog: model wrote 16 of the 20 asked for"), plus a third case at
`queries: 16` confirming neither fires exactly on budget. Verified
non-vacuous by mutation: `&& false`-gating both conditions made the two new
assertions on the `say()` text fail exactly as predicted; reverted before
committing — no source change.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3367 tests passing (up from 3364, three new), 13 skipped
(same gated census as SELF-597).

Backlog item: SELF-598

**SELF-599 (2026-10-01 overnight fire) — took SELF-509/566's own advice
again, a fresh end-to-end read of files never dedicated-read rather than
another instrumented sweep. Found nothing to fix.**

Shortlisted candidates by basename-grep against this file (zero or one hit),
the same first pass SELF-566 used, then read each in full:
`packages/web/lib/graph/search.ts` (`rankMatches` — confirmed the score bands
0/1/10+/20+ are spaced at least 1 apart and the degree tie-break is capped at
0.4, so it can never cross a band or reorder two different `indexOf` hits
within one); `packages/web/lib/nodeTypes.ts` (the type/colour/icon/order maps
and `nodeTypeOf`/`groupLabel` — internally consistent, each exported const
keyed on the same four-member `NodeType` union); `packages/web/lib/graph/
cluster.ts` (`assignClusters`, `measureClusters`, `separationShoves` — the
one-hop-only rule, the RMS-not-max radius, and the pinned/pinned,
pinned/free, exact-overlap-tie branches in the separation shove all match
their own comments and `cluster.test.ts` already exercises every branch
named above, args-swapped included); `packages/core/src/alias.ts`
(`aliasSignals`/`aliasSets`/`anchorAliasSet` — traced the first-canonical-
wins rule through an unparseable first tag, which locks out a later valid
cross-host canonical too; conservative-by-design for a module whose whole
job is precision over recall, not a bug); `packages/core/src/clock.ts`
(re-derived `rankSeconds`'s rescale arithmetic by hand — `hosts ×
rankSecondsPerHost × rankPoolWidth / width` — against the file's own worked
example, 0.63 × 8 / 24 = 0.21s/host, and it matches exactly).

One near-miss, checked and ruled out: `packages/swarm/src/serialize.ts`
hardcodes `stats.tokReasoning: 0` while `packages/sweep/src/sweep.ts` tracks
a real per-call `reasoningTokens` figure for reporting (the comment at
sweep.ts:2252 — "recorded so the reasoning share stops being inferred from
arithmetic"). Looked like the same shape as a genuine gap, but
`packages/swarm/src/agent.ts`'s `oneTurn` only ever reads
`result.usage.inputTokens`/`outputTokens` — it has no reasoning-token read to
wire up, so `tokReasoning: 0` is not a dropped value, it is the honest
absence of one. And the one current reader of `stats.tokReasoning`,
`scripts/experiment.ts:112`, only ever processes sweep-shaped run files
(its `Arm`s shell out to `scripts/sweep.ts`); it never sees a swarm run,
whose `decomposition` is a different, explicitly-empty shape (serialize.ts's
own comment: "shape-compatible and honestly empty"). So today nothing reads
a swarm run's `tokReasoning` at all — wiring it up would be a speculative
addition with no reader to fix, not a bug with an observable symptom, the
same reasoning this file's own rules use to decline work with no
reachable failure.

No code change. `pnpm install` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3367 tests passing, 13 skipped (same
gated census as SELF-598; unchanged by a read-only fire).

Backlog item: SELF-599 - BLOCKED

**SELF-600 (2026-10-02 overnight fire) — a fresh end-to-end read of
`packages/core/src/drift.ts` and `scripts/diff-runs.ts` (the two files
SELF-517's own fix touched, re-read as primary targets rather than as a side
effect of that fix) plus one near-miss chased to ground. Found nothing to
fix.**

`drift.ts`: traced `entityKey`, `indexByKey`, `edgeEndpointKey`, `diffMaps`
and `driftSentences` by hand against the module's own header rules (first-row-
wins on a repeated key, a field absent on either side never counts as
changed, display names never key). `changed`'s sort order (by key, built from
`[...ia.keys()].filter(...).sort()`) survives into the `byKey` Map
`driftSentences` folds it through — `Map` iteration order is insertion order,
so `driftSentences`' per-key loop prints in the same sorted order `MapDrift`'s
own doc comment promises, not a separate claim to go stale. `tierDirection`'s
`TIER_RANK` lookup and the kind/relation/tier clause-assembly in
`changedSentence` each matched their own worked example in the surrounding
comments. `diff-runs.ts`: `parseRun`'s sweep/swarm/kernel shape-sniff,
`denoise`'s noise-row exclusion, and `driftRows` (the function SELF-517 added)
all read correctly against `drift.ts`'s exported `indexByKey` — confirmed
`driftRows` shares that exact first-wins index rather than building a second
one, which is the gap SELF-517 closed and the one most likely to have
regressed since.

One near-miss, chased and ruled out: re-reading the listicle harvest's
vendor-dedup comment (`packages/sweep/src/sweep.ts:5013-5029`, "left
case-sensitive, two spellings of one vendor both survive into `fresh`") against
the code it sits directly above looked, on a first pass, like a comment
describing a bug the code no longer has — the `seenLabel` Set below it keys
on `v.toLowerCase()`, which already collapses a case-variant duplicate before
`rivalHand` ever sees it. Checked the git history (`git log -L` on that
hunk): both the comment and the lowercase key landed in the SAME commit
(`6b776e0`), the comment explaining the bug that commit's own fix prevents,
not a bug the current code still has. `listicle-harvest.test.ts`'s own
"two case-variant spellings of one vendor collapse to a single query, never
a self-pair" test (added by that same commit) already pins this. Recorded
here only so a future fire reading that comment in isolation does not
mistake past-tense rationale for a live gap.

Also re-ran `pnpm audit --audit-level=moderate` (no known vulnerabilities,
unchanged since SELF-595's dependency work) and read `packages/web/app/
error.tsx` and `global-error.tsx` fresh — both carry their own dedicated
tests (`error.test.tsx`, `global-error.test.tsx`) and neither's basename had
ever matched a grep of this file before, which turned out to mean they were
simply never cited by name in a past entry, not that they were unread: both
files' own header comments already document the exact measurements (redaction
text, digest plumbing, the no-stylesheet/no-pre-paint constraints) a fresh
read would otherwise have had to re-derive.

No code change. `pnpm install` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3367 tests passing, 13 skipped (same
gated census as SELF-599; unchanged by a read-only fire).

Backlog item: SELF-600 - BLOCKED

**SELF-601 (2026-10-02 overnight fire) — the one file never hand-read in
this whole campaign, `packages/sweep/tests/fixture.ts` (zero basename hits
anywhere in this document, the one genuine miss besides the out-of-scope
`next-env.d.ts`), carried a comment misnaming which of its own six hosts
ends up the fixture's orphan — and the same wrong name had been copied into
a second file's comment too.** `fixture.ts`'s `SERP` doc comment claims
"`grepstack`+`tailwatch` co-occur in three different queries and
`grepstack`+`loglens` in two (the selector's floor), while every other pair
co-occurs once and is dropped." Instrumented a real run (`runFixture({})`,
default script, reading `h.calls` back through the exported `pairsOf()`)
rather than trusting the hand count: the link call's prompt actually carries
**three** pairs, not two — `forum.example`+`tailwatch.example` also co-occurs
twice (`"uptime monitoring"` and `"synthetic checks from more than one
region"` both list the pair), clearing the exact same floor
`grepstack`+`loglens` does. `sweep.ts`'s own selector (`coPairs`, ~line 6327)
confirms the floor is `n >= 2` with no further filter by entity kind — a
`community`-kind host pairs exactly like a `company`-kind one.

That is not a harmless undercount: `sweep-bills-what-it-spent.test.ts`'s
"takes the total AFTER the linking phase" test carries a comment built on
the same wrong premise — "the fixture's forum co-occurs with nothing twice,
so it is asked [via the orphan pass]." Instrumenting the orphan call's own
prompt (same run) shows exactly one orphan, and it is `walled.example`, not
`forum.example`: `walled` has no `FETCH_TABLE` row (its front page 404s), and
the only query that lists it (`"log search"`, alongside `grepstack` and
`tailwatch`) pairs it with each just once — one below the floor — so it
never reaches `coPairs` at all. `forum` clears the floor with `tailwatch`,
gets a real link edge from the default script
(`from: forum, to: tailwatch, relation: "competitor"`), and is never asked
where it stands. The test's own assertions (`lineOf(byAgent,
"link").calls` = 2, one link call + one orphan call) were already correct —
only the prose explaining WHY was wrong, attributing the orphan ask to the
wrong host.

Fixed both comments: `fixture.ts`'s `SERP` doc now names all three
qualifying pairs and says which single host (`walled`) is the actual orphan
and why; `sweep-bills-what-it-spent.test.ts`'s comment now says the same,
verified rather than asserted. No test added — this is a doc-only fix with
no behavioural claim to pin; the existing `.toHaveLength(1)` /
`.calls).toBe(2)` assertions already lock in the real shape (one link call
carrying three pairs, one orphan call carrying one host) and would fail if
either count ever drifted. Probe script (a throwaway `.test.ts` overriding
nothing, reading `h.calls` through `pairsOf()`) deleted before committing —
`git status` clean.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3367 tests passing (unchanged — comment-only), 13 skipped
(same gated census as SELF-600).

Backlog item: SELF-601

**SELF-602 (2026-10-02 overnight fire) — a fresh end-to-end read of
`sweep.ts`'s link phase (second-look through the orphan ask, lines
5718-7173, never the subject of its own dedicated entry — only cited
before by single-line coverage-tool hits) found one real "first writer
wins, except not" bug in the declared-integration matcher.** The doc
comment directly above `byKey` (~line 7128) promises "first writer wins" —
and the label tier right below it actually keeps that promise, with an
explicit `!byKey.has(label)` guard. The name tier two lines later does not:
`if (nk) byKey.set(nk, e)` is unconditional, so whichever of two kept
entities sharing one name's `idKey` happened to be LAST in `keep` took the
key, the opposite of the comment and of the label tier's own rule sitting
right above it. Not a hypothetical collision: the naming pass's own "ONE
SPELLING, ONE OWNER" measurement a few hundred lines earlier in this same
file found 4-16 such same-name collisions per map on the ten biggest runs
on disk (`react.dev`/`legacy.reactjs.org` both "React", for one) — this
`byKey` map hits the identical shape, just for matching a declared
integration's name against the map instead of for matching a mention.

Fixed by tracking which keys are still holding a label-tier placeholder
(`fromLabel`): the first name writer for a key still evicts a label
placeholder (preserving "name outranks a label coincidence"), but a second
name writer for an already-name-claimed key is turned away, matching the
label tier's own first-wins rule. Added a test overriding `classify` so
`tailwatch.example` answers to "Grepstack" too (the same name
`grepstack.example` already carries in the fixture) and declaring an
agent-mode integration named "Grepstack": asserts exactly one integration
edge lands, and that it lands on whichever of the two is actually first
into `keep` on this fixture (`tailwatch.example` — checked by running it,
not assumed from `HOSTS`'s declaration order). Verified non-vacuous by
mutation: stashed just the `sweep.ts` fix and reran — the new test failed,
resolving to `grepstack.example` (the last-writer, the pre-fix bug) instead
of `tailwatch.example`; restored the fix and reran clean before committing.

Read the rest of the range adversarially and found nothing else: the
second-look and drop-confirm stages' own "counted before the attempt"
convention (each incrementing its `Asked` counter before the try, so a
thrown call still counts as asked) holds in both; the orphan ask's own
`stats.asked` deliberately does NOT follow that convention (incremented
only after `call()` returns) but that asymmetry is already named in its
own doc comment and pinned by `an-orphan-is-asked-where-it-stands.test.ts`
("Unlike second-look's own fail-open catch, this one does NOT count the
attempt") — read first, mistaken for a fresh find, then traced to that
existing test and ruled out. The free naming pass's `isRival` dead-branch
proof (the "THIS BRANCH DOES NOT FIRE TODAY" block, SELF-480) re-read
clean on its own terms, just not findable by a basename grep of this file
— SELF-480 itself is not retained in this document's text, confirmed via
`git log --oneline --grep="SELF-480"` finding commit `e470c16`, which is
why coverage claims from a basename count alone undercount what has
actually been read; noted here so the next fire does not take this file's
own grep-based coverage check at face value either.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3368 tests passing (up from 3367, one new), 13 skipped
(same gated census as SELF-601).

Backlog item: SELF-602

**SELF-603 (2026-10-02 overnight fire) — ran SELF-509's coverage-sweep tool
one more time, scoped to `scripts/*.ts` specifically rather than trusting
its own category-wide dismissal of that whole directory, and found one
real zero-coverage marker in `scripts/export-target.ts`.** Installed a
temporary `@vitest/coverage-v8@4.1.11` devDependency (matched this repo's
vitest, reverted before finishing, same move as SELF-509/593/596/597/598)
and ran `vitest run --coverage --coverage.include="scripts/**/*.ts"`.
Every file came back low, as SELF-509 already explained for this directory
category-wide (`invokedDirectly`-guarded CLI bodies a wiring test already
covers by source-grep) — except `export-target.ts`, at 94.73%/95.74%
stmts/lines, the one file in `scripts/` whose exported functions are pure
and already heavily tested (`tests/export-target.test.ts`, 23 cases before
this fire). Its two uncovered lines (118, 182) were worth reading rather
than waved through on the same category argument.

Line 118 is `MARKERS`' `llms.txt` opener, one of four marker regexes
`judgeExportTarget` checks in array order (`AGENTS.md`, `SKILL.md`,
`llms.txt`, `manifest.json`) to decide whether a folder is a prior export
safe to erase and rewrite. `Array.prototype.some` short-circuits on the
first true, and every existing "prior-export" fixture in the test file
either used the real `exportKbFiles()` output (which always writes
`AGENTS.md` first) or hand-built a folder that still included `AGENTS.md`
— so `AGENTS.md`'s own opener (line 116) had already returned `true` before
`.some()` ever reached `llms.txt`'s on line 118. The one existing test that
removes `llms.txt` ("clears an export written before SKILL.md and llms.txt
existed") removes it FROM a fixture, so it is absent (`entries.includes`
false, short-circuits at line 178) rather than present and read — never the
`true` path, never even the `false` path. Confirmed by reading the coverage
tool's own function-count (14 of 15 marker-array functions invoked; `llms.txt`'s
is the 15th) rather than trusting the line-number list alone.

Not a hypothetical gap: this is the one marker among the four that, unlike
`AGENTS.md`/`SKILL.md`, never got its own dedicated "vouches alone" test
the way the file's leading comment claims every marker can ("Any one of the
four markers vouches for the folder"). Added a test building a folder that
holds nothing but a real `llms.txt` (sliced from the same `exportKbFiles()`
fixture every other test in the file already shares) and asserting
`judgeExportTarget` still reads it as `"prior-export"` — the claim the file's
own header comment makes and no test had exercised. Verified non-vacuous by
mutation: changed line 118's regex from `market map` to `markett map`
(breaking only the `llms.txt` opener), reran — the new test failed
(`"unmarked"` instead of `"prior-export"`), every other test in the file
still passed; restored the regex and reran clean before committing.

Line 182 (the outer `catch { return false }` around `readFileSync` inside
the same `.some()` callback) stays uncovered and was left alone: by the
time that line can run, `foreignInside` has already `statSync`'d every
`FILE_ENTRIES` name present (including all four markers) and would have
already returned `foreign-contents` if any of them were a directory, so the
only way `readFileSync` can still throw on one is a TOCTOU race (deleted or
permission-changed between the two syscalls) — not reproducible
deterministically, and (checked directly: `chmod 000` on a file then
`readFileSync` it, as this container runs) root bypasses file-permission
checks outright, the same reason `packages/web/lib/runs.test.ts`'s own
EACCES fixture is gated dark in this environment. Defensive-only, the same
shape as the structurally-dead branches SELF-509 catalogued and declined to
chase with a test that cannot mean anything.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3369 tests passing (up from 3368, one new), 13 skipped
(same gated census as SELF-602).

Backlog item: SELF-603

**SELF-604 (2026-10-02 overnight fire) — read five low-attention files end
to end looking for SELF-602's exact bug shape (a stated invariant an
unconditional write quietly breaks) and a reachable version of it;
found nothing real.** Shortlisted by the same two-pass method SELF-566/599
established (basename-grep against this document, then checked each
survivor's actual exported names rather than trusting a zero/one hit
alone): `packages/core/src/breaker.ts`, `packages/providers/src/
safe-fetch.ts`, `packages/swarm/src/family-ledger.ts`,
`packages/web/components/viz/polar.ts`. `packages/core/src/catalog.ts`
looked like a fourth candidate (4 hits, all line-citations from a coverage
sweep) but turned out to already carry its own full dedicated read —
SELF-569, found by searching this document for the filename rather than
trusting the grep count, same miss-class SELF-561/570 already named.

`breaker.ts` (64 lines, `BreakerTable`): read against its own 11-case test
suite and its one caller (`tools-paid.ts:373,437`) — `strike()` and
`open()` both key on `originKey(url)` + `input.mode`, the same two values,
so there is no derivation mismatch between the write side and the read
side to find. `COUNT_WORDS[reasons.length]` indexes a 7-entry array that
`#history` only ever reaches once `reasons.length >= OPEN_AT (2)`, and the
`?? String(reasons.length)` fallback is exercised by the suite's own
7-strike case — nothing unguarded.

`safe-fetch.ts` (248 lines, the SSRF-guarding `publicOnlyFetch`): re-derived
the redirect-hop arithmetic by hand independently of the prior fire that
verified it (line 1208 of this document) rather than taking that citation
on faith — traced hop 0 through hop 4 each following a redirect
(`hop >= maxRedirects` false all five times) and hop 5 throwing on the
sixth 3xx, confirming "5" really does mean 5 redirects followed, not 5
requests. `assertPublic` runs again on every hop before the next fetch,
closing the exact TOCTOU-shaped door the file's own header names as the one
thing it does NOT cover (DNS rebinding between the check and the real
resolve) without silently also leaving a redirect-time gap.

`family-ledger.ts` (92 lines, `FamilyLedger`): `opened()` resets
`existing.status` to `"queued"` unconditionally on any re-open, with no
branch for `existing.status` already being `"claimed"` or `"landed"` — on
its face the same shape as SELF-602's bug (a later write ignoring an
earlier state it should defer to). Traced every call site that can reach
it: `tools-control.ts`'s push handler (~438) and promote handler (~579)
both gate on `Board.push`/`Board.promote` succeeding first, and
`core/src/board.ts`'s `push` (:89-91), `promote` (:155-157) and `kill`
(:172-174) each explicitly return `{ ok: false }` for any `dedupeKey`
already in `#claimed` — and `release`'s own comment (:135-136) states a
landed mission "is never released: it stays claimed... for the rest of the
run." `#claimed` is therefore monotonic once a key lands, so none of the
three paths that can trigger `FamilyLedger.opened()` can ever fire for a
dedupeKey whose ledger row already reads `"claimed"` or `"landed"` — the
same "looks reachable, traced to a sibling file's own guard, ruled out"
shape SELF-602 itself hit with the orphan-ask counting convention. Not
fixed; nothing to fix.

`polar.ts` (SELF-559's own dedup of the `Gauge.tsx`/`Donut.tsx` arc-point
formula): four lines, already deduplicated, matches both callers' own
path-string tests.

No code change. `pnpm install` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3369 tests passing (unchanged — a
read-only fire), 13 skipped (same gated census as SELF-603).

Backlog item: SELF-604 - BLOCKED

**SELF-605 (2026-10-02 overnight fire) — re-ran SELF-509's coverage sweep
over `packages/swarm/src`, the one D-named package it originally covered
but no later fire had re-measured since (SELF-596/597/598 already redid
core/web/providers/sweep), and found one genuinely untested reachable
branch among several that just looked new from shifted line numbers.**
Installed a temporary `@vitest/coverage-v8@4.1.11` devDependency (matched
this repo's vitest, reverted before finishing, same move as
SELF-509/593/596/597/598/603), scoped to `packages/swarm/src/**/*.ts`.
Lines sat at 99.41%, identical to SELF-509's figure, but the uncovered
line numbers differed — not drift, just insertions earlier in each file
pushing later lines down. Checked every one against SELF-509's original
citations rather than trusting the new numbers at face value:
`tools-control.ts:579` (the `if (row)` after a successful `promote` —
`Board.promote` mutates the held item in place and never removes it from
`#queued`, so `residue().find` in the very next statement can't miss it;
structurally dead, same shape as SELF-509's own catalogue), `run-evidence.ts:293`
(`land()`'s `if (slot)` — both call sites in `tools-paid.ts` always pass a
handle freshly minted by `pending()` in the same closure, and `#pending`
has no delete, so the slot always exists), and `tools-paid.ts:317,847`
(both already carry their own "dead by construction" comment from a prior
fire — just shifted lines, not new gaps).

The one real gap: `tools-free.ts:744`, inside `rememberTool`'s edge-merge
branch. `if (confidence === "measured") existing.confidence = "measured"`
only ever fires on its true arm — every existing test that re-submits a
duplicate edge does so with evidence attached, so `confidence` computes to
`"measured"` every time (`tools-free.ts:714`, `e.confidence ?? (refs.length
? "measured" : "inferred")`). The false arm (a later, evidence-free
re-mention of an edge already proved) is a deliberate no-op — it leaves
`existing.confidence` exactly as it was — and that no-op had never run: no
test re-submits an existing edge WITHOUT evidence to check it doesn't slide
a "measured" edge back down to "inferred". Not a structurally-dead branch
like the others above: dropping the guard (tested directly, see below)
silently downgrades a proven edge the moment a second, weaker account of
the same relation arrives, which `tools-free.ts`'s own node-merge code
(the `incomingStronger`/`downgradeIntoSupported` logic a few lines above,
lines 641-672) goes out of its way to prevent for nodes — edges had no
equivalent test proving the same discipline holds.

Added a test: seed an edge with evidence (lands "measured", matching the
existing "an edge without evidence is inferred" test's own shape), then
re-submit the same `{from, to, relation}` with no evidence at all, and
assert it still merges (`merged.edges === 1`) with `confidence` still
`"measured"`. Verified non-vacuous by mutation: changed the guarded
assignment to an unconditional `existing.confidence = confidence`, reran —
the new test failed (`"inferred"` instead of `"measured"`); restored the
guard and reran clean before committing. No source change — the guard was
already correct; only the test was missing.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3370 tests passing (up from 3369, one new), 13 skipped
(same gated census as SELF-604).

Backlog item: SELF-605

**SELF-606 (2026-10-02 overnight fire) — tried `noPropertyAccessFromIndexSignature`
as the next flag-as-detector (the angle SELF-545/549/561/563/570/571 used for
every other unadopted strict flag), and found a real but out-of-scope pattern,
the same shape SELF-561 hit with `exactOptionalPropertyTypes`.** Enabling it in
`tsconfig.base.json` and running `npx tsc -b --force` (TS 5.9.3, `node_modules`
installed fresh — absent again on this clone) surfaced 25 errors in only 3
source files: `core/src/prompts.ts` (`frontmatter.agent`/`.doctrine`/`.includes`
on a `Record<string, string>`), `sweep/src/sweep.ts` (12 `process.env.OPENKB_*`
reads plus two `(linkingStats as Record<string, unknown>).orphans`/`.integrations`
writes) and `swarm/src/from-sweep.ts` (a `Record<string, unknown>` cast of
parsed JSON in `validateSweepRun`). That part looked exactly like the small,
mechanical, adoptable case `noImplicitOverride`/`erasableSyntaxOnly` were —
fixed all 25 with bracket notation, `tsc -b --force` came back clean. But
`pnpm check` then ran the test projects and surfaced 5 more (identical shape,
tests reading the same `frontmatter`/`skill` bags) — fixed those too — and
then **108 more across 21 files in `packages/sweep/tests/`**, every one a test
reading `h.result.report.<field>` or similar off a loosely-typed instrumentation
bag (`queries`, `opening`, `budget`, `entities`, `kernel`, `families`, `triage`,
etc.) that sweep's own tests treat as a free-form telemetry object by
convention, not a handful of isolated call sites. Same conclusion SELF-561
reached for `exactOptionalPropertyTypes`: a dozen source sites is adoptable,
but the real size of the change is "`packages/sweep/tests/`'s entire
convention for reading run telemetry," which is a test-suite-wide style
migration, not "one item, small, real, tested." Reverted every edit
(`tsconfig.base.json` and all six touched source/test files — `git status`
confirmed clean, `git diff --stat` empty) rather than land a partial flag
flip with 100+ sites still failing the build.

`pnpm install` first (fresh clone, no `node_modules`). On the unmodified tree,
`pnpm check && pnpm test` both exit 0: 3370 tests passing, 13 skipped (same
gated census as SELF-605) — unchanged, since nothing was kept.

Backlog item: SELF-606 - BLOCKED

**SELF-607 (2026-10-02 overnight fire) — a genuinely new angle, auditing every
fire-and-forget promise in the engine and web packages for an unhandled
rejection, never tried by any prior fire. Every single one traced out safe by
construction; found nothing to fix.** Grepped this document for "floating
promise"/"unhandled rejection" first (zero hits) before starting, then
grepped the source tree itself for every `void <expr>.then(`/`void (async ()
=> …)()` and every bare `.then(` chain not immediately followed by its own
`.catch(` on the same statement, across `packages/*/src`,
`packages/web/{app,lib,components}` and `scripts/`. A `.then`/`void` pair is
exactly the shape that silently drops an error if anything downstream of it
can still throw — the class of bug that shows up as a crashed run or a
console "UnhandledPromiseRejection" with no code-path evidence, not as a
wrong answer a fixture would catch.

Ten call sites matched. Traced each one's full downstream chain by hand
rather than trusting that the author's own comment already covers the
question (most of these comments justify a DIFFERENT invariant):

- `packages/providers/src/safe-fetch.ts:117` — `void work.then(resolve,
  reject).finally(...)`. Both arms hand off to the enclosing `Promise`'s own
  `resolve`/`reject`, which the spec guarantees never throw; `.finally`'s
  callback is a plain `removeEventListener`. The settled promise this `void`s
  can only ever be already-resolved.
- `packages/swarm/src/orchestrator.ts:700` — `void
  Promise.allSettled(ps).then(finish)`. `allSettled` never rejects by
  definition; `finish` (:690-696) clears a timer, removes a listener, and
  calls the enclosing `resolve` — none of which can throw.
- `packages/swarm/src/orchestrator.ts:773-832` — `launch()`'s mission promise
  `p`, stored in `inflight` and raced against in the main loop
  (`Promise.race(waiters)` at :1321) with no further `.catch` anywhere on
  this chain. The existing comment at :738-753 only proves `runInvestigator`
  itself throw-free before its own `.catch()`; it says nothing about the
  `.then(async (digest) => {...})` stage chained AFTER that catch, which is
  the one that actually lands in `inflight`. Traced every statement in that
  stage: `settleWithin` (:686, `Promise.allSettled` again), `ledger.draw`/
  `.settle` (`core/src/ledger.ts:136-162`, both return `{ok:false,...}` on
  any bad claim id rather than throw), `families.landed`
  (`family-ledger.ts:65-69`, plain `Map` reads/writes), and `say()`
  (`orchestrator.ts:305`, `opts.onLog?.(...)`) — whose only three callers
  (`scripts/swarm.ts:318`, `scripts/sweep.ts:286`, `web/app/api/map/
  route.ts:587`) all pass a bare `console.log`. Every statement is
  throw-free for any input this orchestrator can construct; the chain simply
  had no comment saying so the way the `runInvestigator` half does.
- `packages/swarm/src/agent.ts:963` — `void
  Promise.allSettled(landings).then(() => deps.ledger.settle(claimId,
  r.usd + drawnOn(claimId)))`. `drawnOn` (:954-957) only calls
  `ledger.draw`, already shown non-throwing above; `ledger.settle` the same.
- `packages/swarm/src/tools-paid.ts:442-466` — `attempt` is built as
  `ctx.fetch.get(...).then((raw) => ({raw}), (err) => ({err}))`, a
  Result-wrapping `.then` that converts both the resolve and the reject arm
  into an ordinary resolved value, so `attempt` itself can never reject;
  `landing = attempt.then((outcome) => {...})` therefore has nothing to
  reject from, whatever `ctx.evidence.land`/`settle` do internally.
- `packages/sweep/src/sweep.ts:2855-2861` — each per-ask promise inside
  `understandByCall`'s `Promise.all` carries its own `.then((d) => d, () =>
  null)`, turning a refusal into `null` rather than a rejection; this is
  already inside an `await`ed `Promise.all`, not a floating promise at all.
- `packages/web/app/api/map/route.ts:714-730` — the deadline timer's `void
  (async () => { ...; await failRun(...) ; ... })()`. `failRun`
  (`lib/runs.ts:418-488`) is the one call here actually worth doubting: it
  awaits `settle()` (:311-319), a `Promise.all` over three slots, and the
  file's own header comment at :301-309 states the invariant plainly
  — "every slot has to be non-rejecting." Checked that this is actually true
  today rather than taking the comment on faith: `persist(r)` carries its
  own inline `.catch` (:313-315), `r.pumped` is a tracked promise with no
  independent throw site, and `db.upsertRun` (`store/supabase.ts:87-99`)
  routes through `quiet()` (:76-83), whose own comment says "Never throws"
  and whose body is a plain try/catch. `isFirstEnding` (`lib/runs.ts:377-381`)
  only logs. So `failRun` cannot reject today, and this `void` is safe — but
  the proof lives in a different file's comment than the `void` call site,
  which is the one thing worth recording for a future fire that changes
  `settle`'s contract without re-checking this caller.
- `packages/web/app/api/map/route.ts:741-747` — `void task.then(() =>
  {...}, () => {...})`, a two-arm `.then` whose callbacks only call
  `clearTimeout`/`resolve`; neither can throw.
- `packages/web/components/build/BuildWorkflow.tsx:473,504,535,547,561` — all
  five `void readNdjson(...)` calls do carry their own `.catch(() => {})`
  chained on the next line (`:474`, `:533`, `:545`, `:559`, `:578`) — missed
  on the first single-line grep pass because the `.catch` sits on a wrapped
  continuation line; re-grepped with the call's full multi-line span before
  concluding these were a gap, and they are not.

No case where an actually-reachable throw escapes a `void`'d or
uncaught-chained promise. This codebase's own discipline (every ledger/board
method returns `{ok, reason}` instead of throwing, every store write is
wrapped in its own `quiet`/`.catch`) is exactly what makes every one of these
fire-and-forget sites safe — the pattern this fire set out to audit turns out
to be a consequence of a different, already-established house rule, not an
accident. Recorded so a future fire does not re-run this same grep from
scratch: the one soft spot worth re-checking after any change to
`settle()`/`quiet()`/`ledger.draw`/`ledger.settle` is whether they are still
non-throwing, since several `void`/uncaught `.then` sites depend on that
without saying so locally.

No code change. `pnpm install` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3370 tests passing, 13 skipped (same
gated census as SELF-606; unchanged — a read-only fire).

Backlog item: SELF-607 - BLOCKED

**SELF-608 (2026-10-02 overnight fire) — re-ran SELF-509's coverage-sweep
tool over `packages/core/src` and `packages/sweep/src` once more, since
both were last re-measured a day or more ago (core at SELF-596, sweep at
SELF-598) and the branch has kept moving since; `core/src` turned up
nothing new (both of its two uncovered lines are SELF-596's own already-
documented hits, shifted a few lines by intervening edits), but
`sweep.ts` named one real, never-exercised catch arm.** Installed a
temporary `@vitest/coverage-v8@4.1.11` devDependency (matched this repo's
vitest, reverted before finishing, same move as SELF-509/593/596/597/598/
603/605) and ran it scoped to each package in turn.

`core/src` sat at 99.78% statements, 97.81% branches — audit.ts:163 and
judge.ts:966-968 are SELF-509's and the audit/judge comments' own already-
traced dead arms (the `if (best === null) break` backstop and the twice-
proven-impossible `admit()` gate respectively), just renumbered; every
other file matched a prior citation exactly (catalog.ts:363-364,
alias.ts:68,212, url.ts:162, export-kb.ts's six lines). No new ground.

`packages/sweep/src` (one file, `sweep.ts`) had dropped further since
SELF-598's 97.3%: 96.17% statements, 87.18% branches, 60 uncovered
statement lines. Most matched the same shifted-citation pattern (SELF-509's
`sweep.ts:5755,6878-6880` now reads 5781,6903-6904, a uniform +26 shift from
intervening insertions) or are abort-signal/defensive-timeout checks no
offline fixture can trigger without a real clock. One stood out as
genuinely new and genuinely closeable: the `try { sameHost =
registrableHost(new URL(named).hostname) === registrableHost(anchor) }
catch { sameHost = false }` guard at sweep.ts:2566-2570, inside the
robots.txt `Sitemap:` fallback. `a-company-names-its-own-rivals.test.ts`
already has a dedicated test for a `Sitemap:` line pointing at a different
host (`sameHost` computed `false` the ordinary way) but none for a line
that is not a valid absolute URL at all — a relative path, which robots.txt
being free text can and does contain — the one shape that reaches `new
URL()`'s own throw rather than its ordinary comparison.

Added one test: a `Sitemap: /sitemap/sitemap.xml` line (no scheme, no
host) and asserted the run finishes normally, reading exactly like the
off-host case (`rivals.found: 0`, `rivals.urlsScanned: 0`) rather than
throwing out of `sweep()` entirely. Verified non-vacuous by mutation:
temporarily removed the `try`/`catch` (letting `new URL()`'s throw
propagate), reran — the new test failed with `TypeError: Invalid URL` at
the exact line, every other test in the file still green; restored the
guard and reran clean before committing. No source change — the catch was
already correct; only the test was missing.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3371 tests passing (up from 3370, one new), 13 skipped
(same gated census as SELF-607).

Backlog item: SELF-608

**SELF-609 (2026-10-02 overnight fire) — SELF-597's coverage sweep scoped
`packages/web` to `lib/` only; ran it over `packages/web/components` as
well (never done before) and found one real untested branch that needed
no jsdom/RTL harness to close.** Installed a temporary
`@vitest/coverage-v8@4.1.11` devDependency (matched this repo's vitest,
reverted before finishing, same move as every prior coverage-sweep fire)
and ran it scoped to `packages/web/components/**/*.{ts,tsx}`.

Most of the gaps are the same structural wall SELF-597 already named for
`useUrlView.ts`: a component whose only untested lines are inside a
`useEffect`, an event handler that needs a real DOM event + rerender
(`SiteIcon.tsx`'s `onError`), or a hook like `usePathname` that needs a
router context (`HeaderNav.tsx`) — this repo's tests render with
`react-dom/server`'s `renderToStaticMarkup`, which never runs effects or
handlers, and there is still no jsdom/RTL harness to drive them. Checked
each of `HeaderNav.tsx`, `ThemeToggle.tsx` and `SiteIcon.tsx`'s uncovered
lines by hand to confirm they are this same wall, not a new one, before
moving on; `KbCard.tsx` and `DemoHome.tsx`'s gaps are the demo gallery,
out of scope by this file's own header.

`ui.tsx` was the one file with a gap that is plain server-rendered JSX, no
hook involved: `SectionHead`'s `{blurb && <p>...}` line (:130). The
existing `ui.test.tsx` already tests the sibling `count` prop's
present/absent split (`"SectionHead and MicroHead omit the count span
entirely rather than rendering an empty one"`) but never exercises
`blurb` at all — grepped every `SectionHead` call site
(`ProductsTab.tsx`'s four) and confirmed none of them actually passes
`blurb` today (each writes its own `<p>` next to `SectionHead` instead),
so the branch had literally never run, on a fixture or in production.

Added one test, same `renderToStaticMarkup` style as its neighbours:
asserts the `<p>` renders with the given text when `blurb` is passed, and
that no `<p>` renders at all when it is omitted. Verified non-vacuous by
mutation: temporarily dropped the `blurb &&` guard so the `<p>` always
rendered, reran — the new test failed (`withNone` now contained `<p
class="mt-0.5…"></p>`); restored the guard and reran clean before
committing.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3372 tests passing (up from 3371, one new), 13 skipped
(same gated census as SELF-608).

Backlog item: SELF-609

**SELF-610 (2026-10-02 overnight fire) — SELF-608/609's coverage sweep had
reached `packages/web/lib` and `packages/web/components` but never
`packages/web/app`; ran it there and found a comparator that had never
actually been invoked.** Installed a temporary `@vitest/coverage-v8@4.1.11`
devDependency (matched this repo's vitest, reverted before finishing, same
move as every prior coverage-sweep fire) and ran it scoped to
`packages/web/app/**/*.{ts,tsx}`. Most gaps are the same two walls this
campaign already accepted: `app/error.tsx:125` and `app/global-error.tsx:212`
both need a real click event to reach their `onClick`, and `app/layout.tsx`
needs `next/font/google` plus a real render pass neither this repo's
`renderToStaticMarkup`-only harness nor a fixture can give it. `app/page.tsx`'s
one gap is inside the demo-gallery's own catch arm, out of scope by this
file's own header.

`app/kb/[id]/page.tsx` had a real one: `sortNear`'s comparator at line 66,
`all.sort((a, b) => (b.built ?? "").localeCompare(a.built ?? ""))`, had never
actually run — the exact pattern SELF-596 already found in
`core/src/audit.ts`'s own `errorKind` sort. `Array.prototype.sort` never
calls its comparator on an array of fewer than two elements, and this file's
own `page.test.tsx` only ever renders against a registry holding at most one
completed run by the time any near-match test reaches it (the whole file
shares one on-disk `OPENKB_RUNS_DIR` tempdir across its `it`s, and no two
completed runs had ever coexisted in it at once).

Added one test, using `vi.useFakeTimers()`/`advanceTimersByTimeAsync` (the
same idiom `app/api/map/route.test.ts` already uses) to give two completed
runs distinct, deterministic build times, then asserting the newer one's
link precedes the older one's in the rendered "Did you mean" list. Verified
non-vacuous by mutation: flipped the comparator's two operands
(`(a.built ?? "").localeCompare(b.built ?? "")`), reran — the new test
failed asserting `793` less than `484` (older printing first); restored the
original and reran clean before committing.

The `?? ""` fallback on each side of that same comparator, and the sibling
fallback at `k.built ? … : k.slug.slice(0, 8)` a few lines down, stay
unclosed on purpose: `builtAt` is computed in `lib/kb-from-run.ts` as
`new Date(run.endedAt ?? run.startedAt).toISOString()`, which is a string for
every run `createRun`/`finishRun` can produce — there is no reachable
completed run whose `built` is ever absent, so the fallback side of either
`??` is structurally dead, the same class of gap this campaign has
repeatedly read and left alone rather than fixture its way past.

One flake worth recording so a future fire does not mistake it for this
test's fault: a full-suite `pnpm test` run failed once with
`tests/run-doctor.test.ts`'s gated `it` running instead of skipping
(`files.length` nonzero but under its own `>20` floor). Root cause has
nothing to do with this change — `tests/check-skips.test.ts` writes 25 real
`runs/sweep-probe-<pid>-*.json` fixtures directly into the actual,
un-sandboxed `runs/` directory at the repo root for the ~30-70s its own
`vitest list --json` subprocess call takes (see that file's own comment),
and `run-doctor.test.ts`'s `files` is a module-top-level `readdirSync` of
that same real directory. Any test-file collection that lands inside that
window sees a partially-populated or differently-sized `runs/` and reacts.
Reran the full suite three more times with this fire's change in place: 3 of
4 total runs came back clean (3373 tests passing, 13 skipped); the one
failure matches this race exactly, not a logic error in `page.tsx` or its
test. Not this fire's to fix — scoped narrower than one item, and the
gate's own module-load-time `readdirSync` against an un-overridable relative
`"runs"` path is deliberate (it is testing the real on-disk directory
production also reads), not an oversight.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0 (confirmed clean 3/4 runs, the 1/4 explained above): 3373
tests passing (up from 3372, one new), 13 skipped (same gated census as
SELF-609).

Backlog item: SELF-610

**SELF-611 (2026-10-02 overnight fire) — re-ran SELF-610's own coverage sweep
one package further, `packages/web/lib`, and found one real crash-on-malformed-
disk-data gap in `kb-from-run.ts`'s `lanesOf`.** Installed a temporary
`@vitest/coverage-v8@4.1.11` devDependency (matched this repo's vitest,
reverted before finishing, same move as every coverage-sweep fire since
SELF-509), scoped to `packages/web/lib/kb-from-run.ts`. The JSON report (the
text reporter's "Uncovered Line #s" column truncates wide ranges with `...`
and, read carelessly, names the wrong lines entirely — confirmed by cross-
checking both outputs on this exact file) named lines 500 and 502: the two
guards inside `lanesOf` (`if (typeof raw !== "string") continue` and
`if (!label) continue`, reacting to each `e.foundBy` entry) had never run
their true arm.

Traced whether that is reachable rather than assuming a typed field means
clean data: `Entity["foundBy"]` is `string[]` only at the type level
(sweep.ts:977, added by intersection, never zod-parsed on this path).
`packages/web/lib/runs.ts`'s `isStoredRun` and `adoptCliRun` — the only two
gates between a `runs/*.json` file on disk and this code — each check
exactly `typeof result.anchor === "string"` and `Array.isArray(result.entities)`
and nothing deeper; every entity, and every element of its `foundBy` array,
reaches `kb-from-run.ts` exactly as the file on disk wrote it. Today's one
producer (`sweep.ts:6037`) only ever pushes real market names, so this
never fires against a run this engine just wrote — but `lanesOf`'s own doc
comment ("entries trimmed, blanks dropped") is a promise about ANY run file
on disk, including a hand-edited or legacy-engine one, which is exactly the
class of input `runs.ts`'s surrounding comments already treat as untrusted.
Without the first guard, a non-string element (`null`, a number — valid JSON,
invalid against the TS type nothing enforces at this boundary) throws
`TypeError: ….trim is not a function` out of `segmentsOf` and takes the whole
KB summary/view down with it, for one bad array element in one entity.

Added a test: a run whose one kept entity's `foundBy` carries a real market
name alongside `null`, `"   "` and `7`, asserting the summary still derives
the one real segment instead of crashing. Verified non-vacuous by mutation:
stripped both guards down to a bare `const label = (raw as string).trim()`,
reran — the new test failed with the exact predicted `TypeError` out of
`lanesOf` (`kb-from-run.ts:500`); restored the guards and reran clean before
committing. No source change — both guards were already correct; only the
test was missing.

`pnpm install` first (fresh clone, no `node_modules`). `pnpm check && pnpm
test` both exit 0: 3374 tests passing (up from 3373, one new), 13 skipped
(same gated census as SELF-610).

Backlog item: SELF-611

**SELF-612 (2026-10-02 overnight fire) — re-ran the coverage-sweep tool one
package further still, `packages/swarm/src`, last measured at SELF-509 and
never since; found one real untested method, `MapState.liveKeys()`.**
Installed a temporary `@vitest/coverage-v8@4.1.11` devDependency (matched
this repo's vitest, reverted before finishing, same move as every prior
coverage-sweep fire) and ran it scoped to `packages/swarm/src/**/*.ts`.

Most of the package's uncovered lines are SELF-509's own citations, just
renumbered by intervening edits (`tools-control.ts`'s three retry-exhausted
arms, `run-evidence.ts:383-393`'s two pending-handle guards, `tools-free.ts`'s
four) or newly-added dead-by-construction lines that already carry their own
proving comment (`tools-paid.ts:317`'s `hintFor` fallback, `:847`'s
unreachable-abort-rethrow branch — both read end to end and confirmed
unreachable before moving on, not just pattern-matched by line shift).

`map.ts:268` was the one new real gap: `liveKeys()`'s `for (const [key, n] of
this.nodes) if (!n.retracted) out.add(key)` had never run its loop body at
all. Traced why: `landedBy` is the method's own doc comment's named consumer
("so `landedBy` can tell what it FOUND from what was already here"), but
`landedBy` takes `liveBefore` as a plain `ReadonlySet<string>` parameter —
every one of `map.test.ts`'s six `landedBy` fixtures builds that set by hand
(`new Set()`, `new Set(["old.com"])`), never by calling `liveKeys()` itself.
The other call site, `agent.ts:1083`'s `deps.map.liveKeys()` at mission
start, only ever runs against a freshly-constructed, still-empty `MapState`
in every fixture in `agent.test.ts` — so in both places the method's `this.
nodes` was always empty, and a `for...of` over an empty `Map` runs its body
zero times regardless of what the guard inside says. Not reachable-only-in-
theory: a real run calls `liveKeys()` after earlier missions have already
landed retracted nodes on the shared map, which is exactly the shape neither
fixture builds.

Added two tests to a new `describe("MapState.liveKeys")` block in
`map.test.ts`: one with a live node and a retracted one, asserting the
retracted key is dropped; one on an empty map, asserting an empty set (the
one shape every existing fixture already exercised, kept as the baseline).
Verified non-vacuous by mutation: dropped the `if (!n.retracted)` guard
entirely, reran — the new test failed, `liveKeys()` returning both keys
instead of one; restored the guard and reran clean before committing. No
source change — the guard was already correct; only the test was missing.

`pnpm check && pnpm test` both exit 0: 3376 tests passing (up from 3374, two
new), 13 skipped (same gated census as SELF-611).

Backlog item: SELF-612

**SELF-613 (2026-10-02 overnight fire) — re-ran the coverage-sweep tool over
`packages/providers/src`, the one D-named package stalest since its last
measurement (SELF-598, a day earlier than every other package's SELF-608
through SELF-612 re-check), then widened to a basename cross-reference
against this whole document when it came back with nothing new; found
nothing fixable either way.** Installed a temporary
`@vitest/coverage-v8@4.1.11` devDependency (matched this repo's vitest,
reverted before finishing, same move as every prior coverage-sweep fire)
and ran `vitest run --coverage --coverage.include="packages/providers/src/
**/*.ts"`. Lines sat at 100%, identical to SELF-598's figure; the two
uncovered branch spans (`brightdata.ts:504-533,545,609` and
`safe-fetch.ts:113-115`) are the exact citations SELF-509/598 already
traced and left alone, re-read end to end here rather than waved through on
a stale citation alone — both are still the `signal.reason ?? new
Error(...)` and `once()`'s four-`ok:false`-returns dead fallbacks their own
inline comments already prove unreachable; nothing changed in either file
since SELF-598.

Widened to a basename cross-reference (the SELF-566/599/604 method) against
every file this document's own low-attention-list named with two or fewer
hits, to find a genuinely never-dedicated-read candidate rather than
another instrumented sweep. Checked `GraphSettings.tsx` (427 lines, one
hit) end to end — its `PRESETS` table and the slider/toggle chrome around
it are already pinned by `GraphSettings.test.ts`'s two describe blocks
(every preset's numeric fields fall inside their own `RANGES` bounds,
every preset key is a real `GraphSettings` field); `GraphSearch.tsx` (145
lines, one hit as a basename but previously touched only for a dead
`type NodeType` import, SELF-549) — traced the keyboard-nav arithmetic
(`Math.min`/`Math.max` clamps on `cursor`, the cursor-reset effect on `q`
changing, the blur-delay-for-click-through) by hand and found it sound,
matching `GraphSearch.test.tsx`'s own documented SSR-only ceiling;
`PlanCard.tsx` and its `build/types.ts` wire contract (one and two hits
respectively) both turned out to already carry a full dedicated read and
fix (SELF-578's `plannedDropped`/chip-gating bug, and the full-file read
SELF-528's "eight files" fire recorded) — a basename-hit count alone
undercounts prior coverage the same way SELF-602 already warned about
`SELF-480`, so each was confirmed by a targeted grep for the file's own
path rather than trusted on the hit count.

Re-verified `core/src/ledger.ts` and `spend-cap.ts` (this file's own D
section still names them by hand as "nobody has swept") were in fact both
already fully read, with every method traced, at SELF-529.

Also confirmed structurally: every non-test `.tsx`/`.ts` file under
`packages/web/components/` and `packages/web/lib/` has a colocated test
file (`find … ! -name "*.test.*"` against `-f "${base}.test.ts"` / `.tsx`,
zero misses) — so no component or lib module is silently invisible to
every prior coverage-sweep fire the way an unimported file would be.
`verbatimModuleSyntax`/`isolatedDeclarations` as a next flag-as-detector
were already tried and declined at SELF-571; not retried. README.md's own
measured-run numbers (the 17/28-sweep percentages, the per-host dollar
figures) cite `runs/`, which is gitignored
and absent from this checkout — the same live-data limitation every
gated test in `pnpm check`'s own dark-suite list already states, so they
are not independently re-checkable here either.

No code change. `pnpm install` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3376 tests passing, 13 skipped (same
gated census as SELF-612; unchanged — a read-only fire).

Backlog item: SELF-613 - BLOCKED

**SELF-614 (2026-10-03 overnight fire) — a genuinely new angle: checked
whether eslint actually runs anywhere in this repo, then manually
re-verified by hand the two correctness-relevant suppressions its four
`eslint-disable` comments name, since the tool that would normally guard
them turns out not to exist here; found nothing to fix.** `grep -rn eslint`
over `package.json`, every `packages/*/package.json`, `pnpm-lock.yaml` and
the whole tree for a config file (`.eslintrc*`, `eslint.config.*`) came back
empty — no eslint devDependency is installed, no config exists, and
`package.json`'s own `check` script (`node scripts/check-core-purity.mjs &&
… && tsc -b && …`) and `.github/workflows/check.yml` run `tsc` and this
repo's own check scripts, never eslint. Yet four source comments read
`eslint-disable-next-line <rule>`, naming rules from Next.js's default
scaffold config: `packages/web/components/KbCard.tsx:179` and
`packages/web/components/SiteIcon.tsx:105` suppress
`@next/next/no-img-element` (both already explained by an adjacent comment —
a plain `<img>` is deliberate because the target is an unconfigured
favicon/external host, not an oversight), and `packages/web/components/kb/
GraphCanvas.tsx:955` and `packages/web/lib/useUrlView.ts:74` suppress
`react-hooks/exhaustive-deps`.

The `no-img-element` pair is a Next.js image-optimizer perf hint, not a
correctness rule — nothing to re-verify by hand. `exhaustive-deps` is
different: it exists to catch a real bug class (a hook reading a value from
closure that is missing from its dependency array, so the hook keeps acting
on a stale value after that value changes) — exactly the kind of thing a
"found nothing" coverage sweep cannot see, since the code runs correctly on
every fixture regardless of which prior render's closure it is reading.
Because no linter ever checks these two sites in this repo, traced each by
hand against the actual rule it suppresses, rather than trusting the
suppression as proof it was once validated by a tool that is not there
anymore:

- `useUrlView.ts:74` — the mount-only `useEffect(() => {...}, [])` inside
  `useUrlView`. Body reads `initial.tab` (closed-over prop, intentionally
  read once — the adjacent comment says so: "Sync once on mount, then never
  again from this effect") and `ref.current`/`setView`, both stable across
  renders (a ref and a setState setter). No value that changes between
  renders and should retrigger this effect is read here; `[]` is correct,
  confirmed by this fire rather than carried over from SELF-56x's read of
  the same file (which traced the mount-sync/popstate/`go()` logic but not
  this specific suppression by name).
- `GraphCanvas.tsx:955` — the `data` `useMemo` closing over `graph`, `meta`,
  `slug`, `resetSeed`, `showUnplaced`, `bakedSeed` and `settings.sizeBy`.
  Read every external reference in the ~110-line body
  (`graph?.nodes`/`graph?.edges`, `meta.degById`/`.hubId`/`.maxDeg`/`.maxRel`/
  `.adj`, `slug`, `resetSeed`, `showUnplaced`, `settings.sizeBy` via
  `sizeMetric`) against the dependency array at line 956 one at a time — all
  seven are present; the imported helpers it calls (`nodeTypeOf`,
  `seedPosition`, `isHubDegree`, `assignClusters`, `loadLayout`,
  `layoutKey`) are module-level functions, not hook state, so they need no
  entry. `bakedSeed` is the one array member the memo body never reads, and
  the comment directly above the disable already explains why it is there
  anyway (to force a re-run once a baked layout lands in storage) — an
  extra, deliberate dependency, not a missing one, and `exhaustive-deps`
  only ever flags missing deps, so there was no actual lint violation left
  for the disable comment to suppress once every used value is accounted
  for. Nothing stale-closure-shaped found in either file.

No code change — both hook suppressions are correct as written, and the
`no-img-element` pair is not a correctness concern. Left the four comments
in place: they are accurate (if currently unenforced) documentation of
intent, and removing dead lint-suppression comments on the strength of "the
tool isn't installed" is a drive-by this fire has no evidence-backed reason
to make. `pnpm install` first (fresh clone, no `node_modules`). `pnpm check
&& pnpm test` both exit 0: 3376 tests passing, 13 skipped (same gated
census as SELF-613; unchanged — a read-only fire).

Backlog item: SELF-614

**SELF-615 (2026-10-03 overnight fire) — a genuinely new angle, copy-paste
clone detection, never tried by any prior fire, found and fixed one real
duplicate the file's own comments had already half-noticed.** Every prior
self-discovered fire in this class used hand-reading, coverage, knip, or
madge; none had run a clone detector. Installed `jscpd@5.4.0` via `pnpm dlx`
(never added to `package.json`/`pnpm-lock.yaml`) and ran it with
`--min-lines 10 --min-tokens 50` over the four library packages'
`src/` (`core`, `sweep`, `swarm`, `providers`), excluding tests and
generated output. It reported exactly two clone pairs, both in
`packages/sweep/src/sweep.ts`.

The first (lines 2248-2259 vs. 2348-2358 before this fire's edit, now
2274-2285 vs. 2374-2384) is the token-accounting/billing block repeated
between a model call's first attempt and its retry. Read both copies in
full: they are deliberately parallel (the success path and the
`catch`-then-retry path of the same `call()` closure), differ only in the
`spans.emit` `argsDigest`/`servedBy` fields the surrounding code already
needs distinct, and are not two independent descriptions of one invariant —
a retry is structurally a second attempt, not a fact that could drift out of
sync the way a copied constant could. Left alone.

The second (lines 3528-3539 vs. 5100-5109) was a real instance of exactly
the risk this file already names out loud two thousand lines earlier: the
`rail` comment at (then) line 2316 reads "ONE COPY... a closed set with two
mappings is a closed set that will disagree with itself." Both the
sitemap-sourced rival hand and the listicle harvest built an identical
`SweptQuery` from a `FamilyQuery` — same eight fields, same `" vs "` intent
check, same `market: ""`/`product: undefined` — as two separately-typed-out
object literals, and the listicle-harvest call site even carried a comment
saying so ("the SAME machinery... not a second query-shape generator for a
second kind of third-party name") without the code actually being one
function. Confirmed both were byte-identical in every field before touching
either.

Fixed by lifting the shared shape into one module-level function,
`sweptFromRival(fq: FamilyQuery): SweptQuery`, placed next to the
`SweptQuery` type definition with a doc comment citing the `rail` precedent
and naming `jscpd` as the tool that found it; both call sites now read
`.map(sweptFromRival)`. Preserved the inline comment explaining the `" vs "`
intent reasoning (moved onto the one line that now contains it, inside the
helper). Deliberately left the two OTHER similar-looking mappings in this
same file alone — `asFired` (~line 3393, per-product hands: `market` is the
product's own market name, `product`/`term` are the product's own, `intent`
keys off `fq.family === "plain"` not `" vs "`) and the `company` hand
(~line 3415: `intent` is always `"switching"`, `term` is always
`undefined`) — both read field-by-field against this one before deciding:
neither is byte-identical to the rival mapping or to each other, and
`jscpd` itself did not flag either, so merging them would be inventing a
shared abstraction across genuinely different shapes rather than removing a
real duplicate.

Re-ran `jscpd` after the edit: the rival-mapping clone is gone; one clone
remains (the token-accounting pair above, confirmed intentional, not
touched). No behavior change — `sweptFromRival`'s body is a verbatim merge
of the two prior object literals, which the existing test suite (`sweep.ts`
has dedicated tests for both the rival-hand and listicle-harvest query
shapes) already exercises as-is; `tsc`, already part of `pnpm check`, is
what proves the extracted function's return type still satisfies
`SweptQuery` at both call sites.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3376 tests passing, 13 skipped (same
gated census as SELF-614 — a same-package refactor with no new test
surface).

Backlog item: SELF-615

**SELF-616 (2026-10-03 overnight fire) — a genuinely new angle, auditing
every `new RegExp` for an untrusted pattern over untrusted text, found one
real catastrophic-backtracking DoS and bounded it.** Of the eight
`new RegExp(...)` call sites in `packages/{core,swarm,sweep}/src`
(`sweep.ts:6442`, `run-evidence.ts:187`, `tools-free.ts:162,164`,
`alias.ts:62`, `sniff.ts:148,150,152`, `tools.ts:183`), seven build their
pattern from a constant string or from text the SAME code already escapes
with `.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` before it reaches `RegExp` —
so none of those can express backtracking at all. `tools-free.ts:162`
(`readTool`'s `grep` param, `re = new RegExp(input.grep, "i")`) is the one
exception: the pattern is whatever the model's tool call supplies, tested
against `rec.text` — the extracted text of a page this run fetched, and
`run-evidence.ts`'s own `MAX_STORED_BYTES` comment says plainly "4MB is the
ceiling on hostile ones." That is a model-chosen pattern over
attacker-reachable text, and the existing `try { new RegExp(...) } catch`
two lines down only guards a MALFORMED pattern (a `SyntaxError` at
construction) — it does nothing for a pattern that parses fine and then
backtracks forever.

Verified directly, not assumed: `/(a+)+$/.test("a".repeat(25) + "!")` — a
26-character string against an 11-character pattern — was still running
after two minutes (killed by hand rather than waited out). Traced every
caller of `readTool` (`agent.ts:380`, the one call site) and confirmed it
runs fully synchronously inside the tool's `execute`, with no
`Promise.race`/deadline wrapper the way model calls get from `withDeadline`
(P0-4's own fix) — and nothing in this engine runs tool execution off the
main thread (grepped for `worker_threads`/`new Worker(` across every
package: zero hits). So a single bad `grep` does not just fail that one
`read` call; it freezes the entire swarm, including the wall-clock budget
every other part of the engine is priced against, because that budget can
only fire from the same event loop the stuck regex has blocked. Not
hypothetical and not rare-input-shaped: the model picks the pattern on every
`read` call with `grep` set, over text a hostile site fully controls.

Fixed by running the match inside a `node:vm` context with a timeout,
rather than calling `.test()` directly. Confirmed first that this actually
works for THIS failure mode, not assumed from the API's name: the exact
pattern above, given a 50ms vm timeout, throws `"Script execution timed out
after 50ms"` at 50ms rather than hanging — V8's own loop-interrupt check
inside the generated regex bytecode is what a `vm` timeout can actually
reach, which is why this works where a `Promise.race` timeout structurally
cannot (nothing can run concurrently with a blocked single thread to race
against it). On a timeout, `safeGrepLines` returns `null` and the caller
falls back to literal-escaped matching of the same pattern string — the
same degrade the existing `SyntaxError` catch already uses for a malformed
pattern, just reached from a different failure (a timeout instead of a
parse error), so a catastrophic `grep` now degrades to a literal string
search instead of hanging, the same way a broken one already degrades
instead of being refused.

`GREP_TIMEOUT_MS = 200` is measured, not guessed: a benign pattern run
through the same `vm` path over 50,000 lines / 4.2MB of text — `grep`'s own
worst case, `MAX_STORED_BYTES`'s 4MB ceiling — completed in 15ms here, so
200ms leaves over 13x headroom for the honest case while still bounding the
dishonest one tightly. Added a test with the exact `/(a+)+$/`-shaped
pattern against a 31-character line mixed into a 3-line page, asserting the
call returns (rather than hanging the suite) and correctly falls back to
literal matching — matching the one line that quotes the pattern verbatim
and no others; it runs in 202ms, confirming the timeout path is actually
exercised rather than the pattern happening to resolve fast. Did not re-run
the un-fixed code to confirm it hangs (that would mean deliberately hanging
a test run); the two-minutes-and-killed-by-hand measurement above, done
before writing the fix, already established that this exact shape does not
return in any reasonable time without it.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3377 tests passing (up from 3376, one
new), 13 skipped (same gated census as SELF-615).

Backlog item: SELF-616

**SELF-617 (2026-10-03 overnight fire) — four angles none of SELF-1 through
SELF-616 had tried by name, plus a coverage re-check of the two files
SELF-615/616 just changed; all came back clean.** Every section (P0, P1, B,
C, D) in this document is `[x]`; the only open work left is this
self-discovered tail, so the fire's job was finding a shape of bug the prior
616 entries had not already looked for, not re-walking ground the
`jscpd`/`eslint`/coverage/basename-cross-reference passes already covered.

1. **Untrusted-`JSON.parse` audit.** Grepped every `JSON.parse` call in
   `packages/*/src` (excluding tests): `packages/sweep/src/ui.ts:65` (an
   `argsDigest` this process wrote itself earlier in the same run — not
   external input) and `packages/providers/src/brightdata.ts:391` (the SERP
   response body) are the only two production call sites. The second is the
   one that parses genuinely hostile bytes, and it is already wrapped in its
   own `try`/`catch` with a named fallback (`"serp returned unparseable
   body"`) three lines below. `packages/web/lib/runs.ts:1076,1211,1232`
   (disk-read run files) and `packages/web/lib/graph/layoutCache.ts:50` /
   `settings.ts:218` (localStorage) are each inside their own `try`/`catch`
   too, the last two further validating every field by hand before use
   (`settings.ts`'s `clampNum`, confirmed field-by-field against
   `GraphSettings.test.ts` rather than assumed). No unguarded parse of
   external or disk data exists in this codebase.

2. **Shell/argument-injection audit.** Grepped for `child_process` imports
   across `packages/*/src` and root `scripts/`: every production call
   (`scripts/overnight.ts`, `scripts/bakeoff.ts`, `scripts/batch.ts`) uses
   `execFile`/`spawn` with an argument array and no `shell: true` — none of
   them interpolate a string into a shell. `scripts/batch.ts:393`'s
   `spawn("npx", args, ...)` passes the sweep's `anchor` string as one argv
   element, not through a shell, so a domain containing shell metacharacters
   cannot inject a second command; this is an operator-run dev script fed
   from a local file, not reachable from any network input. Nothing to fix.

3. **Coverage re-check of SELF-615/616's own new code**, since those are the
   only two source files this branch has touched since SELF-613's
   package-wide sweep and a prior fire's own new code is exactly the part of
   a coverage report least likely to have been looked at yet. Installed the
   same temporary `@vitest/coverage-v8@4.1.11` devDependency (reverted
   before finishing), scoped to `packages/swarm/src/tools-free.ts` and
   `packages/sweep/src/sweep.ts`. `sweptFromRival` (`sweep.ts:975`) and both
   its call sites (`:3554`, `:5117`) are fully covered — not in the
   uncovered-branch list. `tools-free.ts`'s `safeGrepLines` and its caller
   (the `vm`-timeout path SELF-616 added) are fully covered too. The
   branches the report does flag in both files (`tools-free.ts:182`'s
   `rec.reason ? ... : ""`, `sweep.ts`'s long tail of defensive `if`/
   `cond-expr` arms) are pre-existing and, where checked against this
   document, already traced and left alone by name (`tools-free.ts:182` is
   the exact dead branch SELF-509/604's "`RecordInput.reason?: string` has
   no real producer that ever omits it" already covers) — not a fresh find.

4. **React timer-cleanup audit** (a leaked `setInterval`/`setTimeout`
   outliving its component — a class no prior SELF entry names). Read every
   `setInterval`/`setTimeout` call under `packages/web/components` end to
   end against its enclosing effect: `BuildWorkflow.tsx:320`'s elapsed-clock
   `setInterval` and `GraphCanvas.tsx:1077`'s force-recipe retry `setTimeout`
   both return a cleanup that clears them. `GraphCanvas.tsx:2005`'s
   `peekTimer` is cleared on the next hover but not on unmount while a timer
   is in flight — traced the consequence rather than stopping at "no
   cleanup": the pending callback is only `setPeekId(id)`, and React 18
   silently no-ops a `setState` call on an unmounted component (the
   dev-mode warning for this was removed from React itself, not a project
   choice) — not a crash, not a leak beyond one scheduled macrotask already
   due to fire within `HOVER_PEEK_MS`. Not worth a change: the fix would add
   an unmount-tracking ref for a callback whose only failure mode is already
   a no-op.

No code change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`). `pnpm check && pnpm test` both exit 0: 3377 tests passing,
13 skipped (same gated census as SELF-616; unchanged — a read-only fire).

Backlog item: SELF-617 - BLOCKED

**SELF-618 (2026-10-03 overnight fire) — four fresh leads, each run down and
ruled out rather than taken on faith; no gap survived inspection.**

1. **Sort-mutation aliasing audit.** The classic shape: `arr.sort()` mutates
   and returns the same reference, so if a caller still holds `arr` after
   handing it to a function that sorts it, the caller's own copy silently
   reorders. Grepped every direct (non-`[...x]`-copied) `.sort(` call across
   `packages/{core,swarm,sweep}/src` and `packages/web/{lib,components}`
   (`catalog.ts:205,485`, `audit.ts:135,169`, `from-sweep.ts:285`,
   `sweep.ts:2892,5110`, `agent.ts:1045`, `KbGallery.tsx:50`, among others)
   and traced each array back to where it was built. Every one is
   constructed locally in the same function that sorts it (`catalog.ts`'s
   `pool` is `[...kept, ...rooted]` or `kept`, both function-local;
   `KbGallery.tsx`'s `rows` is `kbs.filter(...)` or `kbs.slice()`, never
   `kbs` itself) — no case where a parameter or a value the caller still
   reads afterward gets sorted in place. Nothing to fix.

2. **Re-ran SELF-616's own `node:vm` regex-timeout fix by direct
   measurement**, rather than trusting its commit message, because it is
   the most recent and most security-sensitive change on this branch and
   exactly what a fresh fire should re-check rather than re-derive from
   scratch elsewhere. Built the exact shape `tools-free.ts`'s
   `safeGrepLines` uses (`new Script(...).runInContext(createContext({text,
   re}), {timeout: 200})`) in a scratch script and ran it against
   `/(a+)+$/` over a 30-character string: threw `"Script execution timed
   out after 200ms"` at 203ms, matching the prior fire's own measurement.
   The mitigation still holds; no regression.

3. **`GraphCanvas.tsx`'s `linkLabel` (:1493-1514) looked like a bug on
   first read** — it resolves both `s` (`asNode(l.source)`) and `t`
   (`asNode(l.target)`), guards `if (!s || !t) return ""`, then renders
   only `t.title`; `s` is otherwise unused, and the adjacent "how" text for
   a provenance edge reads "not a measured relation between these two
   ends," which sounds like it presupposes two named ends. Traced before
   touching anything: `FLink`'s own doc comment (:134-141) says the
   relation label on a provenance edge "is the entity's relation to the
   ANCHOR, not a claim about the two ends it joins — which is what the
   link tooltip says out loud." The tooltip's job is to name the one
   entity whose relation is shown and disclaim the edge itself, not to
   restate both endpoints the canvas already draws as two connected dots
   under the reader's cursor. Adding `s.title` would duplicate what the
   line on screen already shows and blur the one thing the tooltip exists
   to say. The asymmetry is the documented design, not a gap.

4. **`FLink.hubLink` (:124, set at :943) looked like dead code** — grepped
   `GraphCanvas.tsx` alone and found no reader beyond its own assignment.
   Widened the grep before concluding anything: it is read by
   `lib/graph/layout.ts`'s `linkDistance`/`linkStrength` (`layout.ts:191,
   214`), both called with the live `FLink` object at `GraphCanvas.tsx
   :1108,1110`, and exercised directly by `layout.test.ts:94-118`. Not
   dead — the field simply has no reader inside the file that defines it.

No code change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`). `pnpm check && pnpm test` both exit 0: 3377 tests passing,
13 skipped (same gated census as SELF-617; unchanged — a read-only fire).

Backlog item: SELF-618 - BLOCKED

**SELF-619 (2026-10-03 overnight fire) — four more fresh leads (client/server
stream framing, the P0-2 pool's error semantics, a dormant rounding-bug class,
and an accessibility/XSS sweep neither named by keyword before), all traced
to a real explanation rather than a gap.**

1. **Client-side NDJSON reconnect, `BuildWorkflow.tsx`'s `readOnce` (:104-137).**
   Looked for the classic shape of this bug: a partial, unterminated final
   line sitting in `buf` when the reader hits `done` and getting silently
   dropped rather than carried into the next reconnect. Traced whether it is
   reachable rather than assuming the shape implies it: both frame producers
   in `app/api/run/[id]/stream/route.ts` — the live `ReadableStream` (:159,
   `` `${JSON.stringify(frame)}\n` ``) and `replay()` (:51,
   `` lines.push(`${JSON.stringify(frame)}\n`) `` then `lines.join("")`) —
   terminate every single frame with `\n`, including the last one before the
   stream closes. So `buf.split("\n")` on a complete response always leaves
   an empty string as the final element after `lines.pop()`, never a torn
   line. Not reachable from this server's own output; the `buf` carry-over
   exists correctly for the case that matters (a chunk boundary landing
   mid-frame), which a mutation check confirmed: a throwaway edit dropping
   one trailing `\n` from `replay()`'s push made the existing
   `stream.test.ts`/`BuildWorkflow` fixtures that round-trip a multi-frame
   response fail immediately, confirming the two ends are actually coupled
   and not coincidentally compatible.

2. **`runPool`'s error semantics after the P0-2 chunked-barrier → continuous-
   pool rewrite** (`sweep.ts:1553-1569`, the function both link dispatch
   sites now call). Compared against the shape it replaced
   (`for (i += LINK_CONC) { await Promise.all(slice) }`): a throw from one
   item there rejects that slice's `Promise.all` immediately, stopping the
   loop — later slices never start, and slice-mates already in flight keep
   running to completion but their results are discarded by the caller's own
   unwind. `runPool`'s `Promise.all(workers)` rejects the same way on the
   first worker's `fn` throw — the other workers already inside their own
   `await fn(...)` keep running until that call settles (nothing cancels
   them), and the pool as a whole still rejects once the first failure
   surfaces. Same propagation, same "in-flight work finishes, its result is
   discarded" shape, same number of items left completely undispatched
   relative to a mid-run abort. P0-2 changed the scheduling, not the failure
   contract — not a regression.

3. **Re-checked `StatTile.tsx`'s `compact()` K→M rollover** (the
   `Math.abs(parseFloat(k)) >= 1000` reroute at :24, already fixed and
   logged against SELF-535) for a sibling gap one level up: does the M
   branch itself need an equivalent "rounds up past its own ceiling" guard?
   It does not, by construction — `compact()` has no unit past `M`, so
   `scaled(v, 1e6, "M")` rounding a value like 999,999,950 up to `"1000.0M"`
   has nowhere further to reroute to, and nothing downstream
   (`KbOverview.tsx`'s only caller, `grep`-confirmed) treats `"1000.0M"` as
   wrong — it is the honest rendering of a number that large. The K-branch
   fix closed the one case where a smaller unit's rounding crossed into a
   bigger unit's range that already existed; there is no next rung for M to
   cross into.

4. **Accessibility / innerHTML-injection sweep** — a class no prior SELF
   entry names by these words, run to close that gap rather than because a
   specific line looked wrong. Grepped every `dangerouslySetInnerHTML`/
   `innerHTML` use in `packages/web`: the one production
   `dangerouslySetInnerHTML` (`app/layout.tsx:106`) is the no-flash theme
   script, a static string literal with no interpolated data (confirmed
   against `lib/theme.test.ts`'s own pinned `__html` snapshot); the other
   two hits are a comment (`ThemeToggle.tsx:31`, describing a browser API
   quirk, not code) and a test file (`GraphCanvas.test.ts`) that already
   exists specifically to prove entity title/kind/relation/notes are
   HTML-escaped wherever the canvas renders them as text, not markup — i.e.
   the one place user- and model-derived strings reach the DOM already has
   a dedicated regression test for this exact class. A broader `aria-`/
   `role=` grep across `packages/web/components` and `app` found 42 files
   already carrying one or the other; spot-checked `GraphCanvas.tsx`,
   `KbOverview.tsx` and `NoteView.tsx` (the three richest views) by hand and
   found labelled interactive controls throughout, consistent with the
   file count rather than a thin pass. No gap found worth a diff this fire
   could verify — the no-jsdom/RTL-harness limitation B1-B4 and SELF-528
   already name means any further a11y claim here would be an unverified
   visual read, not something `pnpm test` can pin.

No code change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`). `pnpm check && pnpm test` both exit 0: 3377 tests passing,
13 skipped (same gated census as SELF-618; unchanged — a read-only fire).

Backlog item: SELF-619 - BLOCKED

**SELF-620 (2026-10-03 overnight fire) — a coverage sweep of `packages/web/lib`
(SELF-509's tool, re-run after confirming it had already been applied here by
SELF-597/`spend-limits.test.ts`'s own coverage comment) found one real zero-hit
branch in `kb-from-run.ts`'s `fractionOf`, the guard a scorecard's own header
comment says exists but that no fixture had ever reached.** Installed a
temporary `@vitest/coverage-v8@4.1.11` devDependency (matched this repo's
vitest, reverted before finishing, same move as SELF-509/593/596/597/598/603)
and ran `vitest run --coverage --coverage.include='packages/web/lib/**'`.
Every file in that tree came back explained already: `useUrlView.ts`'s low
number is SELF-81's documented React-lifecycle limitation; `store/supabase.ts`
:280, `graph/cluster.ts`'s four branches, and `spend-limits.ts`'s seven
remaining gaps each already carry (or are named by) a comment proving the
branch is structurally unreachable through today's callers — confirmed by
reading every one of those comments before moving on, not by the file-level
percentage alone.

`kb-from-run.ts`'s single uncovered statement (line 233,
`fractionOf`'s `typeof f.num !== "number" || typeof f.den !== "number"`) was
the one new lead. `scorecardOf`'s own comment two lines above is explicit:
"All four fractions must parse: a Coverage card missing half its instrument
would render confidence the run never measured, so a malformed reading yields
no card rather than a partial one" — a claim this function exists specifically
to enforce, and the sibling fallbacks one function over (`alsoOf`'s malformed-
entry filter, and the families/gate fallbacks `kb-from-run.test.ts:529-541`
already names as a prior fire's fix) are tested for exactly this failure
shape. `fractionOf` was not. Traced why: every malformed-scorecard fixture in
the file fails one level up, inside `fractionOf`'s own first guard (`!v ||
typeof v !== "object"`, line 231) — either the scorecard has no
`familiesWithPageTier` key at all (`{ families: [] }`) or isn't an object
("yes") — so `v` is never a truthy object that then has a wrong-typed `num`
or `den`, the one shape a hand-edited or older-format run file (`report.
scorecard` is read off disk, not constructed by this code) can actually
produce.

Added a test alongside the existing "refuses to invent a scorecard from a
malformed one" case: a full `liveScorecard` with one fraction field replaced
by `{ num: "2", den: 3 }` (string num) and another by `{ num: 1 }` (missing
den), asserting `scorecardOf` still refuses the whole card rather than
rendering it with one fraction blank. Verified non-vacuous by mutation:
changed line 233's `||` to `&&` (so only a double-wrong fraction would be
refused), reran — the new test failed on its first assertion, every other
test in the file still passed; restored the `||` and reran clean before
committing.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3378 tests passing (up from 3377, one
new), 13 skipped (same gated census as SELF-619).

Backlog item: SELF-620

**SELF-621 (2026-10-03 overnight fire) — re-ran the citation-drift sweep
(SELF-488/503's own tool, last applied to these exact two files on
2026-09-16/17) and found it due again: `sweep.ts` has grown past both of its
own self-citations, and past `judge.ts`, since.** Not a re-run of SELF-509's
coverage-driven method — this is the narrower, file-targeted check
`calibrate-kernel.ts`'s comment header itself names as its own precedent
("Same trace as SELF-405's rivals doc"), picked because `git blame` showed
every citation in both comments was last touched Sept 15-17 while
`packages/sweep/src/sweep.ts` has taken dozens of commits since (7826 lines
now, up from the ~7490 these citations were written against).

Found two in-file `sweep.ts` comments (the `mapHosts` fallback trace at
:7263-7275, and its declared twin in the `rivals` section at :7531-7549) and
one `scripts/calibrate-kernel.ts` comment (:108-152, tracing why
`e.domain || e.name || ""` has no live seam) all citing lines that have since
shifted — same substance, stale addresses, exactly SELF-488/503's shape.
Verified each by reading the target line directly before changing its
citation, not by assuming a consistent offset:

- `sweep.ts`'s two self-citations of its own `entities.push` sites, "(5641,
  5648)", are now at 5677 and 5684 (confirmed: `entities.push(...judged.
  entities.map(...))` and the triage-skip `entities.push({ name: t.host,
  domain: t.host, ... })` immediately after it) — a uniform +36 shift.
- Both citations of the `HostCandidate` build line, "built at line 5165",
  are now at 5195 (`host = new URL(h.url).hostname.toLowerCase().replace(/^www\./, "")`)
  — +30.
- The `mapHosts` comment's self-reference to the `rivals` section's `onMap`,
  "~line 7466", now resolves to 7530 (`const onMap = new Set<string>();`)
  — +64, a different shift than the other two because it crosses more of
  the intervening edits.
- The same comment's citation of `judge.ts`'s ten entity-constructor lines,
  "(406, 491, 767, 787, 812, 829, 881, 898, 961, 964)", is now a uniform +6:
  grepped `packages/core/src/judge.ts` for `domain: h.host` directly and got
  412, 497, 773, 793, 818, 835, 887, 904, 967, 970 — ten hits, same count,
  same order, same `domain: h.host` shape at each.
- `calibrate-kernel.ts`'s four `tools-free.ts` citations (`:522` for the
  `nodeKey` call, `:585` / `:585-586` for the kind/relation downgrade,
  `:615` for the node's `domain: n.domain` field) are now a uniform +45:
  567, 630, 630-631, 660 (confirmed by reading `rememberTool`'s body at each
  new address — same calls, same order).
- `calibrate-kernel.ts`'s `map.ts:58`, `verdict.ts:31` and `verdict.ts:100-
  109` citations still match exactly; left alone.

No claim this makes was re-derived from the old citation — each new line
number was read from the current file first, the same discipline SELF-488/
503 used. Comment text and reasoning are otherwise unchanged; this is eleven
line-number corrections across two files, nothing else. No behavior change.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3378 tests passing, 13 skipped (same
gated census as SELF-620 — unaffected by a comment-only change).

Backlog item: SELF-621

**SELF-622 (2026-10-03 overnight fire) — the same citation-drift sweep
SELF-488/503/621 ran against `sweep.ts`/`judge.ts`/`calibrate-kernel.ts`,
pointed instead at every other source comment citing a line inside
`packages/swarm/src/tools-free.ts`, the one target file those three fires
never covered.** Grepped every `*.tsx?:[0-9]+` citation across
`packages/*/src`, `packages/web/{app,components,lib}` and `scripts/*.ts`
(57 total, excluding test files and this doc's own historical entries,
which are a log of what a past fire did and are not meant to track a
moving target), then compared each citing comment's own last-touched commit
(`git blame` on the comment's line) against its target file's last-touched
commit. `tools-free.ts` is the newest-modified target in the whole set
(2026-10-03, newer than the citations bumped by SELF-621 itself), so every
comment citing a line inside it was a candidate; verified each by reading
the cited line's actual content against what the comment claims is there,
the same discipline SELF-621 used, not by trusting the timestamp heuristic
alone (it also flagged ~30 other citations whose target file changed
elsewhere in ways that left the cited line untouched — confirmed by reading
each candidate before touching anything, and left those alone).

Eight citations into `tools-free.ts`, across four files, had drifted:

- `run-evidence.ts:229` — `ownPage`/`snippetFor`'s own line numbers ("line
  379, 456 below", a self-citation within the same file) → 405, 481 (their
  function defs: `ownPage(key: string)`, `snippetFor(hostKey: string)`).
- `run-evidence.ts:233` — `tierOf`'s `key` ("tools-free.ts:454") → 567
  (`const key = nodeKey(n.kind, n.name, n.domain)`, immediately above
  `tierOf`'s call site at line 581).
- `map.ts:228` — "the only place a MapNode is ever minted" ("tools-free.
  ts:612") → 657 (`ctx.map.nodes.set(key, {`).
- `map.ts:230` — `descGrounded`'s computation ("tools-free.ts:560-566") →
  605-611 (the `Math.round(descriptionGrounding(...).score * 100) / 100`
  block, confirmed still 7 lines).
- `map.ts:231` — the merge path's reassignment ("tools-free.ts:654") → 699
  (`existing.descGrounded = descGrounded`).
- `map.ts:309` — `MapNode.contributions`'s two write sites ("tools-free.
  ts:603/617") → 672/686 (the mint's `contributions: [{ writer, tier }]`
  literal, then the merge path's `stampContribution(existing, writer,
  tier)` call — still a 14-line gap between them, same as the original
  603/617, confirming the pairing survived even though both shifted).
- `orchestrator.ts:894` — the empty-key rejection block ("tools-free.
  ts:517-527") → 567-576 (`const key = nodeKey(...)` through its `if
  (!key)` rejection's `continue`, still an 11-line-wide guard).
- `agent.ts:994` — the map's one edge-writing site ("tools-free.ts:749") →
  794 (`ctx.map.edges.push({ from, to, relation: e.relation, ... })`,
  confirmed it is still the only `ctx.map.edges.push` in the file).
- `agent.ts:1006` — `rememberTool`'s per-call `{added, merged}` return
  ("tools-free.ts:793") → 838 (`return { added, merged, rejected,
  downgraded, poolLeftUsd: ... }`).

Comment text and reasoning are otherwise unchanged — every claim these nine
corrections sit inside was re-verified against the target's current content,
not re-derived from the stale number, the same check SELF-621 ran. No
behavior change; nine line-number corrections across four files.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3378 tests passing, 13 skipped (same
gated census as SELF-621 — unaffected by a comment-only change).

Backlog item: SELF-622

**SELF-623 (2026-10-03 overnight fire) — a genuinely new angle, the install
step itself rather than the source tree: ran `pnpm licenses list --prod`
(clean, read-only) and investigated the `Ignored build scripts: esbuild`
warning every `pnpm install` on this branch has printed since pnpm 10 made
build scripts opt-in, which no prior SELF-<n> had looked at by name.**
`pnpm licenses list --prod` returned MIT/Apache-2.0/ISC/BSD across the
production dependency tree with nothing copyleft or unlicensed — a clean
read, nothing to fix, recorded so a future fire does not re-run the same
check expecting a different answer.

The build-script warning looked, on first read, like something a future
contributor would "fix" by running `pnpm approve-builds` the moment they saw
it — exactly the kind of thing worth settling once rather than leaving for
each new clone to rediscover. Traced rather than silenced: pnpm 10 blocks a
dependency's install-time script by default (a supply-chain guard — an
arbitrary `postinstall` is one of the more common real-world attack vectors
in the npm ecosystem), and `esbuild` is the one package in this tree that
ships one. Read `esbuild`'s own `install.js`: the script's job is to
download a platform-specific binary ONLY when none of its `@esbuild/
<platform>` optional dependencies resolved — a fallback path, not the
primary one. Confirmed `@esbuild+linux-x64@0.28.1` is present in this
sandbox's `node_modules/.pnpm` (pnpm resolved it as a normal optional
dependency, no script required), then proved the binary actually works with
the install script still blocked: `node node_modules/.pnpm/esbuild@*/
node_modules/esbuild/bin/esbuild --version` printed `0.28.1` cleanly.
`pnpm check && pnpm test` below is itself running on a `pnpm install
--frozen-lockfile` with the same warning present and the same binary
working, on every fire this whole branch has run — this is not a new
condition, only a newly-explained one.

Running `pnpm approve-builds` would not fix anything that is broken; it
would let `install.js` execute on the next install where it currently does
not, trading a working, script-free resolution for the exact class of risk
pnpm's default exists to block. Left the default alone — nothing to
approve — and added one paragraph to `CONTRIBUTING.md` right after the
`pnpm install && pnpm check && pnpm test` block, so the next person who
sees this warning on a clean clone reads why it's there and does not
"fix" it into a worse state. No source-code change.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`;
printed the exact warning this entry investigates). `pnpm check && pnpm
test` both exit 0: 3378 tests passing, 13 skipped (same gated census as
SELF-622 — a docs-only change touching neither package).

Backlog item: SELF-623

**SELF-624 (2026-10-03 overnight fire) — chased four fresh angles (floating/
unhandled promises, UTC-day boundary arithmetic, floating-point money
comparisons, mutation aliasing beyond `.sort()`); all four were already
closed by SELF-528/573/607/618 or fail safe by this codebase's own "fail
closed" doctrine. The one real find was a factual error in SELF-617's own
entry above, not a code bug: its item 4 claims `GraphCanvas.tsx:2005`'s
`peekTimer` "is cleared on the next hover but not on unmount while a timer
is in flight." That is wrong.** `grep -n "peekTimer"
packages/web/components/kb/GraphCanvas.tsx` shows three hits, not the two
SELF-617 traced: a declaration (`:586`), the hover-set/clear pair it
inspected (`:2004-2005`), and a dedicated unmount cleanup effect at
`:587-592` — `useEffect(() => () => { if (peekTimer.current != null)
window.clearTimeout(peekTimer.current) }, [])`, forty lines above where
SELF-617 was looking, directly beneath the ref's own declaration rather than
its usage. `git log -S"peekTimer.current != null) window.clearTimeout"
--oneline -- packages/web/components/kb/GraphCanvas.tsx` returns one commit,
`1770fca`, the file's own initial commit — the cleanup has been there since
before this backlog's first entry, not added since.

SELF-617's bottom line ("not worth a change") still holds, but for the
opposite of its stated reason: there is no gap to leave unfixed, because the
unmount case it worried about was already handled. Left `GraphCanvas.tsx`
untouched — there is nothing to fix in it — and left SELF-617's own entry
text as the historical record of what that fire concluded rather than
editing it after the fact; this entry is the correction a future fire should
read first if it cites SELF-617 on this point.

No code change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`). `pnpm check && pnpm test` both exit 0: 3378 tests passing,
13 skipped (same gated census as SELF-623 — a docs-only change touching
neither package).

Backlog item: SELF-624

**SELF-625 (2026-10-03 overnight fire) — a genuinely new angle: compared two
sibling files in the same directory instead of reading one file in
isolation, the way every prior SELF-<n> in this class has worked.**
`packages/web/components/build/` has two live feeds that solve the same
problem — a stream of rows arriving while a run is `running`, read by
someone who may scroll up mid-run to re-read an earlier line.
`AgentPanel.tsx` solves it carefully: a `pinned` flag toggled by an
`onScroll` handler (`scrollHeight - scrollTop - clientHeight < 40`), with
its own comment stating the failure it exists to avoid — "yanking someone
back to the bottom while they are reading is worse than not following at
all." `EventFeed.tsx`, the other feed in the same directory, did exactly
that: its auto-scroll effect ran `el.scrollTop = el.scrollHeight`
unconditionally on every `items` change, with no `pinned` state and no
`onScroll` handler at all.

Confirmed this was not a deliberate difference. `git log --follow --
packages/web/components/build/EventFeed.tsx` shows no commit on the file
since the repo's initial commit (`1770fca`) other than the test-only commit
that gave it coverage (SELF-143) — that fire documented the jsdom/RTL gap
around the scroll effect but was scoped to coverage, not behavior, and did
not compare it against `AgentPanel.tsx` sitting in the same folder.
`AgentPanel.tsx`'s own `pinned` mechanism has been present since that same
initial commit, so this is not a regression either file introduced — it is
two components solving one problem differently since day one, with nobody
having read them side by side until now.

Confirmed reachable, not theoretical: `BuildWorkflow.tsx:900` renders
`<EventFeed items={feed} running={running} />` on the live build page, the
one surface a reader watches while a sweep is in progress.

Fixed by porting `AgentPanel.tsx`'s `pinned`/`onScroll` pattern into
`EventFeed.tsx` verbatim — same 40px threshold, same mechanism — rather than
inventing a new one. Did not port `AgentPanel.tsx`'s "following/paused"
button: that is a discoverability nicety on top of the fix, not the bug
itself, and scrolling back near the bottom already re-pins automatically
through the same `onScroll` handler. No test added — the behavior is
scroll-event-driven DOM state, the same jsdom/RTL gap
`EventFeed.test.tsx`'s own header comment already names for this exact file;
its existing `renderToStaticMarkup` tests still pass unchanged, since the
initial render (`pinned` starts `true`) produces identical markup to before.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3378 tests passing, 13 skipped (same
gated census as SELF-624 — unaffected by a web-only behavior change with no
new test).

Backlog item: SELF-625

**SELF-626 (2026-10-03 overnight fire) — read `components/SkipLink.tsx` and
its own dedicated test (SELF-181) side by side and found the test enforces
only half of the component's header-comment claim.** The comment says the
skip link "lands focus on `<main>` rather than merely scrolling to it, so
the next Tab continues inside the page." `SkipLink.test.tsx` already pins
`href="#main"` against `layout.tsx`'s `id="main"` (SELF-181's own find —
nothing cross-checked the two literals), but a bare `<main>` has no native
focusability: only interactive elements and anything carrying `tabindex`
are focus targets for hash navigation, so the id match alone gets you a
scroll, not the focus move the comment actually promises. `layout.tsx:139`
does carry `tabIndex={-1}` on that same `<main>` — the standard skip-link-
target technique — so the code is correct; no test enforced it.

Added one test in the existing "SkipLink's #main target actually exists in
layout.tsx" block: extract the `<main ...>` opening tag and assert it
contains both `id="main"` and `tabIndex={-1}`, the same string-matching
style (not simulated browser focus — jsdom doesn't model hash-navigation
focus) the rest of this test file already uses. Verified non-vacuous by
mutation: removed `tabIndex={-1}` from `layout.tsx`, reran — the new test
failed; restored it and reran clean before committing. No source change.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`;
printed the same `esbuild` build-script warning SELF-623 already explains).
`pnpm check && pnpm test` both exit 0: 3379 tests passing (up from 3378, one
new), 13 skipped (same gated census as SELF-625).

Backlog item: SELF-626

**SELF-627 (2026-10-03 overnight fire) — a sweep of every file never touched
by a commit on this branch, cross-checked against the test tree; nothing
survived.** `git diff --stat a7bbc57..HEAD` names every file this branch has
ever changed; diffing that against `git ls-files` for `packages/**/*.ts` and
`scripts/**/*.ts` turns up the files no prior SELF-<n> ever had reason to
open. Read every non-trivial one end to end (`packages/core/src/scorecard.ts`,
`grounding.ts`, `investigator.ts`; `packages/swarm/src/family-ledger.ts`;
`packages/web/lib/scorecard-view.ts`, `zip.ts`, `graph/layoutCache.ts`,
`graph/settings.ts`, `graph/search.ts`, `notes-view.ts`, `theme.ts`,
`graphIcons.ts`; the seven thin API routes under `packages/web/app/api/kb`
and `packages/web/app/api/run/[id]` including the 201-line `stream/route.ts`;
`packages/sweep/src/rank.ts`, `packages/core/src/pricing.ts`). Checked each
one against its own dedicated test file where one exists
(`grounding.test.ts`'s 15 cases, `zip.test.ts`'s byte-level round-trip reader,
`search.test.ts`'s prefix-vs-degree ordering tests, `scorecard-view.test.ts`,
`notes-view.test.ts`, `graphIcons.test.ts`, `layoutCache.test.ts`) — every
file in this set already carries coverage of this depth despite never having
been the subject of a commit on this branch, which is the real finding here:
"untouched by a SELF-<n> commit" does not mean "unaudited", it means the last
read of it found nothing to fix, so the signal this sweep leaned on is weaker
than night 3's "Areas nobody has swept" framing implied.

Two near-findings, both run down and ruled out rather than shipped:

1. `FamilyLedger.opened()` (`family-ledger.ts:46-56`) unconditionally resets
   `status` to `"queued"` and deletes `because` on ANY existing row for a
   re-opened `dedupeKey`, regardless of whether that row is currently
   `"claimed"` or `"landed"` — nothing in the function itself guards against
   clobbering an in-flight or finished family. Traced the only caller path
   (`tools-control.ts:547` `ctx.board.promote`, gated by `wasUnreviewed` at
   line 546, and `orchestrator.ts:628` `board.push(seed, "lead")` for the
   seed) down to `packages/core/src/board.ts`, which was already touched
   earlier on this branch: `Board.push` rejects a `dedupeKey` already in
   `#claimed` (`board.ts:89-91`), `Board.promote` rejects the same
   (`board.ts:155-157`), and `Board.release` — the only path back from
   `#claimed` to `#queued` — is documented and implemented to never run for a
   landed mission (`board.ts:135-136`, "A landed mission is never released: it
   stays claimed so its key keeps rejecting duplicates for the rest of the
   run"). So the event that would call `FamilyLedger.opened()` against a
   claimed-or-landed row cannot reach it: both of the board's own gates
   refuse first. Structurally dead, not a live bug — confirmed by reading the
   caller chain, not by guessing from the ledger file alone.

2. `packages/web/lib/graph/search.ts`'s `rankMatches`: the two "substring"
   score bands (`10 + title.indexOf(q)` and `20 + domain.indexOf(q)`,
   `search.ts:32-33`) can cross when a title match sits 11+ characters in,
   letting a domain hit at index 0 outrank a title hit that starts later —
   the file's own comment only guarantees prefix hits always beat substring
   hits (true in every case: band 0-1 vs. band 10+), and never claims the two
   substring bands stay ordered against each other. `search.test.ts` has no
   case exercising that crossover. Not a verified defect against any stated
   invariant — just an untested corner of a ranking heuristic — so left
   alone rather than "fixed" against a guess at what the ranking should do.

No source change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`; same `esbuild` build-script warning SELF-623 already
explains). `pnpm check && pnpm test` both exit 0: 3379 tests passing, 13
skipped — identical to SELF-626's own count, as expected for a read-only
fire.

Backlog item: SELF-627 - BLOCKED

**SELF-628 (2026-10-03 overnight fire) — extended SELF-488/503/621/622's
citation-drift sweep beyond the `sweep.ts`/`judge.ts`/`tools-free.ts`
targets those four fires covered, to every other `file.ts:NNN` citation in
the repo's non-test source comments.** SELF-621/622 each scoped to one or
two target files chosen because they were the newest-modified file in the
set; neither claimed to have checked every citation, and SELF-509's own
260-citation census is from 2026-09-17 — stale by three weeks of commits.
Grepped every `[A-Za-z0-9_-]+\.tsx?:[0-9]+(-[0-9]+)?` citation across
`packages/*/src`, `packages/web/{app,components,lib}` and `scripts/*.ts`
(excluding test files, `fixture.ts`, and this doc's own historical entries,
same exclusions SELF-622 used), compared each citing line's own last-blamed
commit against its target file's last-touched commit to shortlist
candidates, then read every target line's actual current content against
what the comment claims is there before changing anything — the same
discipline SELF-621/622 used, not the date heuristic alone (several
candidates the date check flagged, e.g. `tools-paid.ts:645`/`:373` cited
from `run-evidence.ts:234-235` and `verdict.ts:102`/`:111` cited from
`judge.ts:950,952`, turned out to still match exactly and were left alone).

Thirteen citations across nine files had drifted, all simple line-number
corrections with the underlying claim re-verified against current content,
no reasoning changed:

- `GraphCanvas.tsx:738` → `NoteView.tsx:107` is now `:129` (the
  `.catch(() => ({}))).error` line moved when the component grew).
- `KbOverview.tsx:817` → the same `NoteView.tsx:107` and `GraphCanvas.
  tsx:745` are now `:129` and `:741`.
- `lib/graph/cluster.ts:135` → `GraphCanvas.tsx:910` is now `:906`;
  `bake-layouts.ts:128` is now `:146`; the same comment's self-citation
  `assignClusters (line 107 above)` is now `88`.
- `lib/kb-from-run.ts:986` → `map.ts:217` (citing `entityEdges()`'s
  `domainOf` fallback) is now `:246`.
- `sweep.ts:68` → `agent.ts:126` (the re-exported `ModelPricing` type) is
  now `:127`.
- `run-evidence.ts:232` → `orchestrator.ts:335` (the guarded `anchor`
  local) is now `:331` — `335` is now where `orchestrator.ts`'s own `map =
  new MapState(opts.domain)` lives, a coincidence confirmed by reading both
  lines, not assumed from the number alone.
- `orchestrator.ts:744-767`, the `.catch()`-is-dead-code proof: six
  citations into `agent.ts` shifted by the same `agent.ts` growth
  SELF-509/599 already measured elsewhere (`:1137`→`:1143`, `:1116-1183`→
  `:1122-1186`, `:1053`→`:1059`, `:1055`→`:1061`, `:1054-1058`→`:1060-
  1064`, `:1077`→`:1083`, `:1192`→`:1198`); its `board.ts:96` citation is
  now `:110`, and since SELF-513 landed on this branch between when that
  citation was written and now, the comment's literal quoted snippet
  (`allowances[held.tier] <= spendableUsd`) no longer matches the source it
  quotes either — updated the quote itself to `allowances[held.tier] <=
  spendableUsd + EPSILON` rather than leave a direct quotation false; its
  own self-citation `map at line 512 above` is now `:335` (confirmed
  against the same `new MapState(opts.domain)` line the `run-evidence.ts`
  fix above also resolves to).
- `orchestrator.ts:893` → `map.ts:166` (`nodeKey`) is now `:153`.
- `tools-paid.ts:833` → `judge.ts:397` (the signal-aborted throw inside
  `judgeOne`) is now `:403`.
- `scripts/export-target.ts`: three separate citations into `export-kb.ts`
  had all drifted — the five `EXPORT_ENTRIES` plain-file line numbers
  (`:978,948,1049,1104,1140` → `:1015,985,1086,1141,1177`, same order:
  AGENTS.md, README.md, SKILL.md, llms.txt, manifest.json), the three
  per-row `.md` write sites (`:722,:787,:844` → `:758,:824,:881`), and the
  `SKILL.md` body-heading marker (`:1055` → `:1092`).
- `scripts/corroboration-arrival.ts:105` → the four `sweep.ts` sites
  sharing the `new URL(h.url).hostname...replace(/^www\./, "")` hostname
  shape (`:4177-4178, 5186, 6305, 7510` → `:4192-4193, 4491, 5195, 6314`) —
  the fourth site had moved from line ~7510 to a different function
  (`hostOfHit` inside the per-family/per-product yield calculation,
  :4491) entirely; confirmed by grepping the literal expression rather than
  trusting the old line stayed near the same function.
- `scripts/calibrate-kernel.ts:89` → `diff-runs.ts:38` and `audit.ts:51`
  (the two sibling scripts' "not a run file this reads" throw sites) are
  now `:43` and `:42`.

No behavior change anywhere — every edit is inside a `//` or `/** */`
comment. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`; same `esbuild` build-script warning SELF-623 already
explains). `pnpm check && pnpm test` both exit 0: 3379 tests passing, 13
skipped — identical to SELF-627's own count, as expected for a
comment-only change.

Backlog item: SELF-628

**SELF-629 (2026-10-04 overnight fire) — two genuinely new checks, neither
tried by any prior fire, found nothing to fix.**

First: re-ran `pnpm audit` (clean, read-only, no network write) three days
after SELF-590 closed the last finding — 0 vulnerabilities, same as then, so
no newly-disclosed advisory has landed against this dependency tree since.

Second: verified the one arithmetic claim in README.md's "## The agents"
section (the `OPENKB_TRIAGE`/`OPENKB_SECOND_LOOK` paragraph) that no prior
SELF-<n> had checked — "4.6% of hosts skipped, pooled over the 28 runs that
record it, 1,283 of 28,182." `1283 / 28182 = 4.5519…%`, which rounds to 4.6%
correctly. Could not go further than the arithmetic itself: the pooled counts
(1,283/28,182 and the adjacent "716 asked and 324 rescued") are derived from
real run files under `/runs/`, which `.gitignore:44` keeps out of every
checkout on purpose (confirmed: no `runs/` directory exists in this
sandbox) — the same boundary that already gates seven live-fixture test
suites dark (see `pnpm check`'s skip census). Recomputing those two counts
from scratch would need a live sweep, which this branch's rules forbid, so
the claim is accepted on the rounding check alone and recorded here so a
future fire does not re-derive it expecting a different answer.

While reading that paragraph, also re-checked `packages/web/lib/viewTypes.ts`
and `packages/web/lib/notes-view.ts` end to end for the one bug class B3 and
SELF-545's `FAMILY_TONE` finding both turned out to be — a closed union whose
gloss/lookup map falls one member short. Every `Record` keyed on a relation,
tier or family in either file, plus the two siblings they document
themselves against (`kb-from-run.ts`'s `RELATION_WEIGHT`, `components/
ui.tsx`'s `TIER_TONES`): `RELATION_BLURB` (14 keys — `RELATION_WEIGHT`'s 13
real relations plus `anchor`, a deliberate superset, not a gap);
`FAMILY_TONE` (4/4 `QueryFamily` members, already fixed by SELF-545);
`TIER_BLURB`/`TIER_TONES` (`ui.tsx:63-67`)/`TIER_RANK` (`notes-view.ts:23-27`)
(3/3 `own-page`/`page`/`snippet`, each with an explicit, correctly-ordered
fallback for an unrecognised value). None short a member. `notes-view.ts`'s
`orderNotes`/`relationFacets`/`noteHaystack`/`filterNotes` were also read in
full — the sort keys, the single-source-of-truth note on `relationFacets` not
duplicating `RELATION_WEIGHT`, and the absorbed-name haystack all do what
their own comments claim.

No code change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`; same `esbuild` build-script warning SELF-623 already
explains). `pnpm check && pnpm test` both exit 0: 3379 tests passing, 13
skipped — identical to SELF-628's own count, as expected for a read-only
fire.

Backlog item: SELF-629 - BLOCKED

**SELF-630 (2026-10-04 overnight fire) — `scripts/overnight.ts` fetched its own
OpenRouter key info twice per target, where one call already carries both
fields it needed.** Found reading `scripts/*.ts` beyond `sweep.ts`
(D-scope: "areas nobody has swept"), the same class SELF-55/56/509 already
worked in `query-yield.ts`/`corroboration-arrival.ts`/the CLI entrypoints —
this file was the one script in that directory never read end to end.

`keyUsage()` and `headroom()` each called `fetch("https://openrouter.ai/
api/v1/key", …)` independently to read one field (`data.usage`, then
`data.limit`) off the SAME response — `main()`'s setup called both back to
back, and the per-target loop called both again on every iteration of up to
14 targets, for up to 30 requests a batch to an endpoint whose one response
already answers both questions. Not a correctness bug (each fetch returns a
consistent `{limit, usage}` pair on its own, so `real` and `room` were never
computed from mismatched snapshots) — a plain inefficiency, the kind this
D-scope exists to find once nobody is reporting it as a user complaint.

Merged into one `keyInfo(): Promise<{usage, limit}>` and pulled the
`limit === null ? Infinity : limit - usage` arithmetic into a standalone
`headroomOf()`, exported and unit-tested directly (three cases: a real
limit, the `null`-limit account this repo's own key actually has, and usage
already past the limit) — the half of the merge a live key is not needed to
exercise. `main()`'s setup and per-loop-iteration reads now each cost one
request instead of two. No behavior change: the same two numbers are
compared against the same two thresholds, just read from one response
instead of two independent ones.

Could not exercise `keyInfo()` itself or a live `main()` run — both need a
real `OPENROUTER_API_KEY` and a real outbound call, exactly what this loop
is forbidden from making. `pnpm install --frozen-lockfile` first (fresh
clone, no `node_modules`; same `esbuild` build-script warning SELF-623
already explains). `pnpm check && pnpm test` both exit 0: 3382 tests
passing (up from 3379, three new `headroomOf` cases), 13 skipped.

Backlog item: SELF-630

**SELF-633 (2026-10-04 overnight fire) — started down the "every file this
branch never individually touched" sweep (`grounding.ts`, the seven thin
`api/kb`/`api/run` routes, `zip.ts`, `graph/layout.ts`, etc.), read about a
dozen of them end to end, then found this file's own history (SELF-513,
527/528, 534, 538/539/542, 546, 627 among others) had already run that
exact sweep — repeatedly, down to the same file list and the same two
near-findings (`FamilyLedger.opened()`'s unconditional reset, `search.ts`'s
crossing substring bands) SELF-627 had already traced and ruled out eleven
hours earlier. Discarded that write-up rather than commit a duplicate; the
only thing worth keeping from it is confirming, again, that this angle is
now fully saturated and the "neither done nor BLOCKED" check this loop's
own SETUP step 4 does against git log is not enough on its own to rule out
a re-tread — a prior fire's find-nothing read never touches the file it
read, so it never appears in `git log --name-only`, exactly SELF-627's own
point, independently re-arrived-at and not news.

Did a genuinely new, narrow, mechanical check instead: every relative link
and image `src` in the repo's top-level prose
(`README.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, `DEPLOY.md`,
`SECURITY.md`, `CHANGELOG.md`, `demo/README.md`, `prompts/README.md`,
`.github/pull_request_template.md`) resolves to a real path — grepped for
"broken link"/"dead link" across this file's history first and found no
prior fire had run this specific check. Extracted every `](path)` and
`src="path"` target across all nine files (31 distinct non-URL targets
after dropping `https://` links and GitHub badge URLs) and confirmed each
exists on disk: `LICENSE`, `package.json`, `assets/launch.mp4`,
`assets/launch.gif`, `assets/mark.svg`, `examples/kb-clerk-com/README.md`,
`prompts/` and `prompts/README.md`, `skills/mapping-markets`,
`ARCHITECTURE.md`/`DEPLOY.md`/`README.md` (the three docs that link to each
other), and the four `core/src/{evidence,judge,verdict,spend-cap}.ts`
citations README's own "## How it decides" section points at. None of the
nine files uses a `#fragment` anchor, so there was no heading-anchor half
of this check to run. Also re-grepped the whole source tree for
`middleware.ts` by name, since SELF-632 (two fires ago) renamed that file
to `proxy.ts` and a stale doc reference would be exactly this kind of
broken-link defect — none found outside `vitest.config.ts`'s own comment
and `proxy.ts`/`proxy.test.ts` themselves, which already name the rename.

Nothing broken. No code or doc change. `pnpm install --frozen-lockfile`
first (fresh clone, no `node_modules`; same `esbuild` build-script warning
SELF-623 already explains). `pnpm check && pnpm test` both exit 0: 3382
tests passing, 13 skipped — identical to SELF-632's own count, as expected
for a read-only fire. Also re-ran `pnpm --filter @open-kb/web build` once
more (SELF-632's own verification method): still compiles clean with no
deprecation warnings, confirming that fix still holds two fires later.

Backlog item: SELF-633 - BLOCKED

**SELF-634 (2026-10-04 overnight fire) — a genuinely new angle, cross-package
dependency VERSION-RANGE consistency (distinct from SELF-544's import-usage
audit of the same six manifests); found one real-looking split that traces to
harmless.** SELF-544 read all six `package.json` manifests end to end but
only cross-checked each declared dependency against what the code imports
(dead-declaration hunting); nobody had compared the declared SemVer ranges
for a dependency shared across manifests against each other. Diffed all
three: `ai` (`^7.0.48` everywhere) and `@types/node` (`^22.10.0` everywhere)
are identical across every manifest that declares them. `zod` is not:
root and `packages/web/package.json` declare `^4.4.3`, while
`packages/core`, `packages/swarm` and `packages/sweep` each declare
`^4.0.0` — a real, measured split, not a typo I'm inferring.

Traced whether the looser floor can bite: `packages/core`, `swarm` and
`sweep` each also depend on `ai@^7.0.48` directly, and `node_modules/.pnpm/
ai@7.0.48*/node_modules/ai/package.json`'s own `peerDependencies` (already
read once for this, by SELF-544) requires `zod: "^3.25.76 || ^4.1.8"` — so
those three packages' own `^4.0.0` floor is already looser than a peer
requirement they carry themselves; a `zod@4.0.0`-exact install would satisfy
their own declared range while failing their own peer dependency. Checked
`pnpm-lock.yaml`: every one of the six manifests resolves to the identical
single `zod@4.4.3` entry (`grep -n "^  zod@" pnpm-lock.yaml` returns exactly
one block), so nothing in this repo, today, on this lockfile, is actually
exposed — `pnpm install --frozen-lockfile` can never pick the lower floor
while this lockfile exists. The split is real but dormant: it would only
surface on a from-scratch `pnpm install` with the lockfile deleted, which
this repo's own CI (`.github/workflows/check.yml`, re-read for this) never
does — it restores the committed lockfile, same as every fire since C2.

Not fixed. Tightening three manifests' floor from `^4.0.0` to `^4.4.3` would
be a one-line-times-three change with no observable behaviour difference
under the lockfile this repo actually ships — exactly the "arithmetic
dressed as evidence" shape P1-8's own BLOCKED note already warns this
branch against taking on faith. Recorded so a future dependency-hygiene
fire does not re-read these six files from scratch looking for this same
class of gap: the import-usage angle (SELF-544) and the version-range angle
(this fire) are now both covered, and a third angle (peer-dependency
satisfaction under a regenerated lockfile) is the one edge this fire
checked by hand rather than by tooling — worth automating only if a real
`pnpm install` without `--frozen-lockfile` is ever on this branch's critical
path, which today it is not.

Also re-ran SELF-630's own verification once more, since fresh eyes on new
code is the other angle this fire tried before settling on the one above:
read `scripts/overnight.ts` end to end adversarially (the `keyInfo`/
`headroomOf` merge, the per-target loop's two stopping checks, every
`parseSweepStdout` regex against the exact template literals `scripts/
sweep.ts:442-444,478,495` and `packages/sweep/src/sweep.ts:3080,3839`
actually print — confirmed `/\$([\d.]+) ·/` has exactly one possible match
site in a full transcript, `scripts/sweep.ts:495`, not the per-event
`onLog` lines which print `$<total>  <line>` with two spaces and no `·`).
Nothing wrong; SELF-630's own work holds.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`;
same `esbuild` build-script warning SELF-623 already explains). `pnpm check
&& pnpm test` both exit 0: 3382 tests passing, 13 skipped — identical to
SELF-633's own count, as expected for a read-only fire.

**SELF-635 (2026-10-04 overnight fire) — a genuinely new angle: `Dockerfile`
and `.dockerignore` had never been touched by a commit on this branch and
are never named anywhere in this document — confirmed by diffing every file
in the repo against `git log a7bbc57..HEAD --name-only` and grepping this
file for both basenames, both came back empty before this entry.** Read
both end to end rather than just grepping, same as every other first-read
file this backlog tracks.

Found nothing broken, but found real gaps in what had ever been checked
rather than just asserted in a comment:

- The two build commands the image actually runs were never run standalone
  before. Ran both by hand: `rm -rf packages/{core,providers,sweep}/dist &&
  pnpm --filter @open-kb/core --filter @open-kb/providers --filter
  @open-kb/sweep exec tsc -b` rebuilt all three from nothing (exit 0, `dist/
  src/*.{js,d.ts}` present in each); `pnpm --filter @open-kb/web build`
  (33s) exits 0 with no deprecation warnings and prints `ƒ Proxy
  (Middleware)`, confirming SELF-632's `proxy.ts` rename still satisfies
  Next 16 two fires later, under the literal command the image's build
  stage runs, not an approximation of it.
- `next.config.ts:65`'s `OPENKB_RUNS_DIR ??= path.join(repoRoot, "runs")`
  (`repoRoot = path.resolve(import.meta.dirname, "../..")`, and
  `next.config.ts` lives at `packages/web/` in the image) resolves to
  `/app/runs` — the exact literal the Dockerfile's own `ENV
  OPENKB_RUNS_DIR=/app/runs` hardcodes. The `ENV` is redundant with the
  `??=` fallback, not wrong; traced rather than assumed, since a mismatch
  here is exactly the class of bug ("ephemeral on most hosts" silently
  pointing somewhere unwritable) `lib/runs.ts`/`api-error.ts`'s large
  `OPENKB_RUNS_DIR` test suites exist to catch at a layer below this one.
- `next.config.ts`'s `outputFileTracingIncludes` comment makes two
  measured-sounding claims about a built image's file-tracing manifest
  (`/api/map` gets `prompts/`, every function gets `demo/maps/*.json`) that
  this branch's own history never re-checked against an actual
  `.next/**/*.nft.json` — grepped this document for `.nft.json` first and
  found no prior fire had opened one. Built the web app and read the
  manifests directly: `api/map/route.js.nft.json` lists 156 files, 21 of
  them under `prompts/` (the full `prompts/agents/*.md` set, confirmed by
  name); all 18 page/route `.nft.json` files list exactly the same 6 files
  under `demo/maps/` (`demo/maps/*.json` on disk is also 6 files, counted),
  and `middleware.js.nft.json`/the two `next-server*.js.nft.json` list 0 —
  the proxy and the server runtime correctly don't carry either glob. Both
  claims hold, now against real tracer output instead of the comment's own
  say-so.
- `.dockerignore`'s root-anchored `assets`/`docs`/`.claude` excludes could
  in principle catch something the web app reads at runtime; checked
  `packages/web/public/` (what Next actually serves, per `ScrollFilm.tsx`/
  `GraphCanvas.tsx`/`bake-layouts.ts`) is a different, non-root-anchored
  path untouched by any of those rules.

Could not verify the one thing that would have made this complete: an
actual `docker build .` of the two-stage image. `docker info` fails here —
`dial unix /var/run/docker.sock: connect: no such file or directory` — this
sandbox has the `docker` CLI but no daemon behind it, a structural gap like
the missing `runs/` directory other BLOCKED items have hit, not a live/paid
call and not fixable by writing a fixture (there is no fixture for "does a
multi-stage image build"). Re-scoped to what a daemon-less sandbox can
actually check — the literal commands, the literal env resolution, the
literal tracer output — and that narrowed scope came back fully verified
clean, so this is not marked BLOCKED: nothing named above is left undone,
only the one thing (the image build itself) that was never in reach.

No code or doc change beyond this entry. `pnpm check && pnpm test` both
exit 0: 3382 tests passing, 13 skipped — unchanged, as expected for a
read/build-only fire.

Backlog item: SELF-635

Backlog item: SELF-634 - BLOCKED

**SELF-636 (2026-10-04 overnight fire) — a prompt/schema cross-check across
every agent, the angle SELF-539 opened and never finished, found one real
drift: the swarm's own harvest-classify call has been silently answering
two fewer fields than its own prompt asks for since 9a96f2f.** SELF-539
read every then-untouched prompt file end to end and cross-checked its
claims against the code; it did not check, for any agent, whether the
zod schema actually offered every field the prompt's own "Answer with"
line names. Checked that for all twelve `prompts/agents/*.md` files against
every `z.object` schema that renders them (`classify`, `triage`,
`drop-confirm`, `listicle`, `link`, `orphan`, `assess`, `catalog`,
`understand`/`group` — the schemas sweep.ts builds its calls from). Eleven
matched field-for-field. One did not.

`prompts/agents/classify.md`'s "Answer with" line names eight fields:
`name`, `kind`, `what`, `relation`, `reasoning`, `why`, `spans`,
`relationSpan`. `packages/sweep/src/sweep.ts`'s own classify schema
declares all eight, in that order — already guarded by
`classify-answers-in-the-order-its-prompt-teaches.test.ts` (P1-6's own
fix). `packages/swarm/src/agent.ts`'s `makeHarvestClassify` renders the
SAME classify.md text — composePrompt over the file on disk, per its own
doc comment, "the SAME doctrine file the sweep renders" — but its zod
schema declared only six: `name`, `kind`, `what`, `relation`, `why`,
`spans`. No `reasoning`, no `relationSpan`.

Traced to the commit that added them: 9a96f2f (2026-08-21, on this
branch, the branch's own base commit's immediate successor), "a placement
ladder that keeps what it finds, not a gate that drops what it can't
name." Its own message says "every classify verdict now also carries a
one-sentence `reasoning` and a `relationSpan` receipt" — stated as a
property of every classify verdict, not of the sweep's alone. Read its
full diff: it touched `packages/core`, `packages/sweep` and
`packages/web`; `packages/swarm/src/agent.ts` does not appear in it at
all. The doctrine file and the sweep's schema grew together; the swarm's
own copy of the same call did not, and nothing since has caught it —
`core/src/judge.ts`'s own `JudgeDeps.classify` return type is deliberately
narrow (by design, so the sweep's own richer closure needs an `as Entity`
cast to carry these same two fields past it — see
`packages/sweep/src/sweep.ts:5600-5607`'s own comment on exactly this
narrowing), which means a type-checker reading `Judged` would never flag
the swarm's schema as incomplete; only reading the prompt text against the
schema that renders it catches this.

This is not a crash and not a test failure — `generateObject`'s schema IS
the API contract (unlike sweep.ts's own classify call, where the schema
and the prompt were extended in the same commit and the schema is still
the real contract, just a matching one): a model handed the narrower
schema could never answer `reasoning`/`relationSpan` even though its own
prompt asked for them, and zod's default object parsing strips unknown
keys rather than erroring, so every harvest judgement since 2026-08-21 has
been silently narrower than its own doctrine, with no error, no test
failure, and no measurement anywhere saying so — the exact "arithmetic
dressed as evidence" shape this document's own BLOCKED notes warn against
shipping, just inverted: evidence the engine could have collected and
never asked for.

Fixed by adding both fields to the harvest schema, same order and same
descriptions as sweep.ts's own (`reasoning` right after `relation`, not
after `spans` — sweep.ts's own schema comment measures why: trailing
optional fields fill at 26% against 85% for one sitting next to its
required counterpart), then threading them through the one path that can
set them: `HarvestClassify`'s return type (`tools-paid.ts`), `landOne`'s
node construction, `RememberNodeInput` and both the new-node and
`incomingStronger`-merge branches of `rememberTool` (`tools-free.ts`), and
`MapNode`/`EntityRow` plus `MapState.entities()`'s passthrough (`map.ts`)
— the same optional-field-survives-a-merge shape `because`/`unreadableReason`
already had, extended by two more fields rather than re-patterned.
`relationGrounded` (the companion check sweep.ts computes while it still
holds page text, per its own comment on why that check cannot move inside
`judgeHosts`) is deliberately NOT added: computing it for the swarm would
need the same page text past the same narrowing, a materially bigger
change, and the web UI's `NoteView.tsx` already renders an absent
`relationGrounded` as "relation quoted, not verified on the page" rather
than assuming it verified — so a swarm-sourced `relationSpan` without it
renders honestly undercredited, never wrongly credited. Recorded here
rather than silently deferred, so a future fire does not treat its absence
as an oversight this one missed.

Verified non-vacuous: reverted the `landOne` passthrough lines alone,
confirmed the new "rides a harvested verdict onto the node" test
(`packages/swarm/tests/tools-paid.test.ts`) fails exactly there with the
expected value turning up `undefined`, restored them. Added a second test
pinning that a verdict answering neither field leaves the node and
`entities()` without the keys at all (no `reasoning: undefined` appearing
where it never did before), and a schema-level test in
`packages/swarm/tests/harvest-classify-prompt.test.ts` confirming a mock
model's answer carrying both fields now survives zod's parse instead of
being silently stripped. `pnpm check && pnpm test` both exit 0: 3385 tests
passing (up from 3382, three new), 13 skipped — same gated census.

Backlog item: SELF-636

**SELF-637 (2026-10-04 overnight fire) — re-ran `jscpd` clone detection over
the whole four-package `src` tree, a check SELF-617 explicitly declined to
redo narrowed to two files; the one new clone it surfaced traced to a
by-design pair, not a drift risk.** SELF-615 installed `jscpd@5.4.0` once,
fixed the one real duplicate it found, and confirmed the tool was clean
afterward; SELF-617 later re-checked only the two files SELF-615/616 had
just touched (by coverage, not `jscpd`) and said explicitly that re-walking
`jscpd`'s own ground was out of scope for that fire. No fire since has run
`jscpd` again over the full tree, and five commits have touched
`packages/{core,sweep,swarm,providers}/src` since SELF-615's run — most
citation-drift or ReDoS-guard sized, but one (`f2089eb`, SELF-636 above)
added two new optional fields to a node shape threaded through four files,
exactly the kind of change that grows a new copy-pasted shape.

Ran `pnpm dlx jscpd@5.4.0 --min-lines 10 --min-tokens 50` over
`packages/{core,sweep,swarm,providers}/src`, excluding tests. Two clones,
same count as SELF-615 left behind: the `sweep.ts:2274-2285` vs.
`:2374-2384` token-accounting pair SELF-615 already traced to the
call/retry split of one `call()` closure and ruled intentional (unchanged
since, confirmed by re-reading both spans), and one neither SELF-615 nor
any later fire had seen before — `packages/swarm/src/map.ts:246-256`
(`MapState.entities()`'s optional-field spread) vs.
`packages/swarm/src/tools-free.ts:680-684` (`rememberTool`'s new-node
object literal). Read both in full against `MapNode`'s current field list
(`map.ts:53-115`, now 17 fields after SELF-636 added `reasoning`/
`relationSpan`) rather than trusting the line match: `entities()` spreads
every optional `MapNode` field (`because`, `unreadableReason`, `settledBy`,
`reasoning`, `relationSpan`, `descGrounded`) into `EntityRow`, and the
new-node literal sets the same six when constructing one — but the two
sides exist for opposite reasons (one serializes a node that already
exists, the other mints one that does not) and `EntityRow`'s own doc
comments (`map.ts:137-152`) independently name every field as "carried
into the run JSON under the same name," so there is no third place either
side could silently fall out of sync with — unlike SELF-615's rival-mapping
clone, which was two independently-typed-out literals for the same input.
Confirmed no field is missing on either side: `key`, `evidence`,
`contributions` and `retracted` are the only `MapNode` members `entities()`
omits, and all three are deliberately unserialized (same file's own
comments at `map.ts:107`, `:154` name why). Also confirmed the harvest path
that creates these nodes (`tools-paid.ts:761-819`'s `landOne`) and the
model-facing `remember` tool's own zod schema (`agent.ts:406-442`) stay
correctly separate — the schema never exposes `reasoning`/`relationSpan`/
`unreadableReason`/`settledBy` to a model, exactly as `map.ts`'s own doc
comments claim, and the merge branch (`tools-free.ts:737-740`) carries
both new fields on an `incomingStronger` merge the same way the new-node
branch does, matching SELF-636's own description of that fix. Not a clone
to merge: forcing one shared function here would couple "build a node" to
"read a node back," two call sites with no third reader to protect from
drift.

No code or doc change. `pnpm install --frozen-lockfile` first (fresh
clone, no `node_modules`; same `esbuild` build-script warning SELF-623
already explains). `pnpm check && pnpm test` both exit 0: 3385 tests
passing, 13 skipped — identical to SELF-636's own count, as expected for a
read-only fire.

Backlog item: SELF-637 - BLOCKED

**SELF-638 (2026-10-04 overnight fire) — a coverage sweep of `packages/web/app`
(SELF-509/620's tool, never run over this tree before — SELF-620 covered
`packages/web/lib` only), found two real validation branches in
`app/api/map/route.ts` with zero test hits anywhere in this repo.** Installed
a temporary `@vitest/coverage-v8@4.1.11` devDependency (matched this repo's
vitest, reverted before finishing, same move as SELF-509/593/596-598/603/620)
and ran `vitest run --coverage --coverage.include='packages/web/app/**'`.
Every page component came back as the already-documented no-jsdom/RTL-harness
gap (B1-B4, SELF-528/619 et al.) except `app/layout.tsx`, which is 0% because
nothing imports it directly — Next's own root layout, exercised only through
a real render. The one API route folder with real server logic,
`app/api/map/route.ts`, came back 94.62% with two gaps worth reading rather
than waving off: lines 402-406 (`queries must be between 1 and ${MAX_QUERIES}`)
and 415-419 (`not configured: ${missing.join(", ")}`).

Grepped every test file in `packages/web/app/api/map/` (`route.test.ts`,
`budget.test.ts`, `limits.test.ts`, `demo.test.ts`) for both error strings
first, to rule out the coverage tool simply missing an existing assertion:
zero hits. `demo.test.ts` exercises "body must be JSON" and "does not name a
company" — the two refusals right above these in the same function — but
nothing anywhere posts a `queries` count outside `[1, 120]`, and
`limits.test.ts`/`budget.test.ts` both set every one of
`BRIGHTDATA_API_TOKEN`/`BRIGHTDATA_SERP_ZONE`/`BRIGHTDATA_UNLOCKER_ZONE`/
`OPENROUTER_API_KEY` in their own `beforeAll` specifically so the route gets
PAST this point — neither suite's job is to test this gate, so neither ever
unset a credential to check it. Both branches are real, user-facing 400/503
refusals (a client that sends `queries: 500` or a deployment missing one
`.env` var) with no regression test anywhere guarding either sentence or
status code.

Added three tests to `route.test.ts`'s own harness (it already has every
env var this needs set in `beforeAll`, and the `post()`/`hoisted.afterTasks`
helpers this gate needs to prove a refused request starts nothing): a
`queries` under 1, a `queries` over 120, and two of the four credentials
unset at once — the last deliberately two, not one, because the handler
`.join()`s every missing key and a test that unset only one could not tell
`.join()` from `missing[0]`. Verified non-vacuous by mutation: replaced each
guard's `if (...)` with `if (false)` in turn, confirmed the matching new
test(s) failed with a 200 where a 400/503 was expected, then restored the
original file from a saved copy before staging anything.

Also chased a related lead to ground rather than just the coverage numbers:
`spendCapFor`'s `onRecordFailure` callback (route.ts:810-811) is *also*
uncovered, and looked at first like the same class of gap. It is not one —
SELF-607 already proved, for a different call site in this same file, that
`failRun` cannot reject today (`settle`'s three slots are each individually
non-rejecting: `persist().catch()`, `db.upsertRun` via `quiet()`, and
`r.pumped`/`pump()`'s own internal catch). Read `SpanStream.emit`/`close`
(`core/src/spans.ts`) and `failRun`'s own body (`lib/runs.ts:418-488`) end to
end to confirm nothing between `record(trip)` and that conclusion can throw
synchronously either — `namedFaults.runCostCeiling` only formats numbers
that are always finite at this call site, and `emit`/`close` have no throw
path for any input. So `onRecordFailure` is dead by the same construction
SELF-607 already named, just reached from `spendCapFor` instead of the
deadline-timer `void`; not a fresh gap, and not pursued into a test for the
same reason SELF-607 took no action — there is nothing a fixture could make
happen.

`pnpm check && pnpm test` both exit 0: 3388 tests passing (up from 3385,
three new), 13 skipped — same gated census as SELF-637.

Backlog item: SELF-638

**SELF-639 (2026-10-04 overnight fire) — four angles no prior SELF-<n> had
named by keyword (credential-leak-through-error-logging, CLI/web env-flag
drift, an asymmetric `|| 0` fallback, and IDN/Unicode domain handling); all
four trace to an existing, deliberate design rather than a gap.**

1. **Does a caught fetch error ever print a credential?** The two secrets
   this codebase sends over the wire (`creds.token` for Bright Data,
   `OPENROUTER_API_KEY` via the `ai` SDK) are both built into an
   `Authorization: Bearer …` header. Read every `catch` downstream of a
   `fetch`/`f()` call that could see that header: both of
   `packages/providers/src/brightdata.ts`'s call sites (:363, :756) convert
   a thrown `e` into a hand-built `reason`/`abandoned` string keyed off
   `e instanceof BlockedHostError`, `callOpts?.signal?.aborted` and
   `timeout.aborted` — never `String(e)` or `console.error(…, e)` on the raw
   error, so a `TypeError: fetch failed` (which itself never contains
   request headers — confirmed against Node/undici's own `fetch` error
   shape, which carries only a message and an optional `cause`, not the
   `RequestInit` that produced it) has no path to the log even in principle.
   The five `console.error` sites that DO print a caught error wholesale
   (`route.ts:811`, `api-error.ts:136`, `runs.ts:261,314,1105`,
   `supabase.ts:80,317`) are all downstream of run bookkeeping (persistence,
   span pumps, the fault logger) — none of them sit between a credentialed
   fetch and its catch, confirmed by reading each call site's caller chain
   back to its nearest `fetch`/`f()`. No credential-bearing object is ever
   within reach of a bare `console.error(err)` in this tree.

2. **CLI/web default-on-flag drift**, the exact class P0-1 fixed once
   already (`scripts/sweep.ts`'s and `route.ts`'s own copies of the
   `OPENKB_TRIAGE`/`_SECOND_LOOK`/`_LISTICLE_HARVEST` disable check). Both
   call sites import the same `disablesFlag` from `packages/core/src/
   flags.ts` (confirmed by grep — zero hand-copied duplicates remain), whose
   own doc comment already names this exact drift risk as the reason it was
   extracted. Nothing to do; recording so a future fire does not re-open a
   question `flags.ts`'s own header already answers.

3. **`Math.max(0, Math.floor(Number(process.env.OPENKB_RANK_UNLOCK ?? 3) ||
   0))`** (`sweep.ts:5622-5625`) looked, on first read, like the same `||
   default` family as `OPENKB_CALL_TIMEOUT_MS`/`OPENKB_RANK_CONCURRENCY`
   nearby — except its fallback is `0`, not its own `??` default (`3`),
   which those others all match. Read the three lines of comment directly
   above it: "a blocked front page… earns one unlocked retry… OPENKB_RANK_
   UNLOCK=0 turns it off" — `0` is the feature's own documented "off" value,
   so unset (`3`, a real retry budget), explicitly `"0"` and a malformed
   string (`NaN`) all correctly collapse to the same safe answer, and the
   outer `Math.max(0, …)` additionally clamps a negative override to the
   same off state. Not an asymmetry bug: the fallback value IS the feature's
   off-switch, chosen per-site on purpose, not a copy-paste of a sibling
   constant's default.

4. **IDN/Unicode anchor domains** — never checked by name in this document.
   `packages/web/lib/anchor.ts`'s `normalizeDomain` gates every anchor
   through `/^[a-z0-9-]+(\.[a-z0-9-]+)+$/` before anything else runs, which
   admits only ASCII letters/digits/hyphens — a real Unicode domain
   (`münchen.de`) fails this shape check outright and is refused with the
   same 400 a malformed string gets, never reaching `registrableHost`.
   Checked whether this creates a two-spellings-of-one-host identity split
   the way a stray IDN could: it cannot, because the only form that ever
   passes the gate is plain ASCII, which already includes punycode
   (`xn--mnchen-3ya.de` matches `[a-z0-9-]+` — `x`,`n`,`-` are all in the
   class), and `new URL(someLink).hostname` — every OTHER place a hostname
   reaches `registrableHost` in this codebase (`verdict.ts:38`,
   `coverage.ts:96`, `alias.ts:90,169`) — is WHATWG `ToASCII`, which renders
   the same real-world domain as the identical punycode string. So the one
   path that accepts a raw string (the anchor) and the many paths that
   accept a `URL`-parsed one converge on the same ASCII spelling for any
   domain that is reachable at all; a genuine Unicode anchor is simply
   turned away at the door, by design, not silently mis-keyed.

No code change — all four were existing, correct behaviour. `pnpm install
--frozen-lockfile` first (fresh clone, no `node_modules`; same `esbuild`
build-script warning SELF-623 already explains). `pnpm check && pnpm test`
both exit 0: 3388 tests passing, 13 skipped — identical to SELF-638's own
count, as expected for a read-only fire.

Backlog item: SELF-639 - BLOCKED

**SELF-640 (2026-10-04 overnight fire) — re-ran `@vitest/coverage-v8` over
`packages/{core,sweep,swarm,providers}/src` (SELF-509's own tool, not rerun
over the full tree since; SELF-638 only scoped it to `packages/web/app`) and
found one real branch gap in `tools-free.ts`'s anchor guard.** Every uncovered
line the fresh run surfaced matches a line SELF-509 already proved dead by
construction, just shifted — confirmed by re-reading each one against
`core/src` (`alias.ts:68,212`, `catalog.ts:363-364`, `judge.ts:967-968`,
`url.ts:162`), `providers/src` (`brightdata.ts:504-533,545,609`,
`safe-fetch.ts:113-115`), and `sweep/src` (`sweep.ts`'s whole uncovered list)
— except one line in `swarm/src/tools-free.ts` that was never on SELF-509's
list because the guard it sits in did not exist yet.

`rememberTool`'s anchor guard (`tools-free.ts:592`) reads
`key === ctx.map.anchor && (n.kind === "company" || n.kind === "product")` —
a node whose key collapses onto the anchor's own host is refused with "that
is the anchor", so a model cannot re-describe the company the map is already
about as one of its own competitors. The suite already had a test driving
the left arm of the `||` true (`kind: "company"`, added when the guard was
written) but never the right: grepping every `kind: "product"` fixture in
`tools-free.test.ts` found three, none with a domain matching the anchor.
Branch coverage on that line sat at less than 100% for exactly this reason —
the line executes either way, so a plain line-coverage reading would have
missed it; only the per-branch column caught it.

Added one test beside the existing company one, same shape: a product node
whose domain is the anchor's own host, asserting the same rejection. Verified
non-vacuous by narrowing the guard to `n.kind === "company"` alone and
confirming the new test is the one that fails (`r.added.nodes` comes back 1,
not 0, with no rejection) — then restored the real guard. `pnpm check &&
pnpm test` both exit 0: 3389 tests passing (up from 3388, one new), 13
skipped — same gated census as SELF-639.

Backlog item: SELF-640

**SELF-641 (2026-10-04 overnight fire) — CHANGELOG.md's last sync (ca93b73,
SELF-631) predates two more user-facing fixes.** Same gap this file has now
been caught in three separate fires (949cfab, then ca93b73, now this one) —
checked `git log ca93b73..HEAD --oneline` by hand rather than trusting any
summary, and two of the eight commits in that range are real, user-facing
fixes with no changelog entry: `f2089eb` (the swarm's harvest-tier classify
call silently dropped `reasoning`/`relationSpan` on every judgement since
the placement-ladder commit outgrew its schema — SELF-636) and `4cccabf`
(`next build` has been printing a Next-16 deprecation warning on every build
since this repo's Next version, silenced by the `middleware.ts` → `proxy.ts`
rename — SELF-632). The other six commits in the range (SELF-633/634/635/
637/638/639, this file's own entries) are read-only sweeps or a jscpd/env
audit with no shipped behaviour change, matching this file's own "Also in
this range" exclusion the same way SELF-631 applied it.

Added one bullet each, in the sections their closest siblings already live
in: the harvest-classify fix beside "Map quality"'s existing `reasoning`/
`relationSpan` bullet (same feature, the swarm's own copy of the gap sweep's
classify path already had), the middleware rename under "Bug fixes" beside
the other build/infra correctness entries (the `packageManager` field, the
deadline-watchdog fault naming).

No source change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`; same esbuild build-script warning SELF-623 already
explains). `pnpm check && pnpm test` both exit 0: 3389 tests passing, 13
skipped — identical to SELF-640's own count, as expected for a docs-only
change.

Backlog item: SELF-641

**SELF-642 (2026-10-04 overnight fire) — `skills/mapping-markets/references/
onboarding.md`, a basename never once named in this document's history, still
described `OPENKB_PAGES`'s pre-`d740379` behaviour as current.** Checked every
low-mention-count file against this document's own citation index (the SELF-
566/599/604/613/627/628 method) and found two reference docs under `skills/`
that had never been individually read: `onboarding.md` and `reading-a-map.md`.
Read both end to end against the code and the rest of the repo's docs.

`reading-a-map.md` checked out clean on every verifiable claim: the 13-member
`RELATIONS` enum (`sweep.ts:700-713`) matches its two tables exactly (8
commercial + 3 channel + `none`/`unknown`); `--edges`'s `measured`/`inferred`
confidence values match `EntityEdge`'s zod enum (`sweep.ts:785-787`) word for
word; the "two or more different searches" pairing rule matches the `n >= 2`
filter at `sweep.ts:6342`. Its one unverifiable number ("302 of 776 kept
entities" for `adjacent`) is a real-run statistic this sandbox cannot
re-derive, the same class of claim P1-5/P1-6 already left alone for the same
reason.

`onboarding.md`'s `OPENKB_PAGES` row was wrong. The table read `4` (CLI) / `2`
(library)`, and the prose below it concluded "...so the CLI's `4` reads four
pages everywhere and leaves that promotion nothing to buy" — describing the
exact bug `d740379` (2026-08-22, "variable page depth was inert on every CLI
run") fixed seven weeks ago. That commit's own message says it audited and
corrected README.md and ARCHITECTURE.md for this same claim; this skill
reference, in a different directory, was never in its scope and has read
backwards ever since. Confirmed current behaviour directly: `scripts/
sweep.ts`'s `pages:` option is `Number(process.env.OPENKB_PAGES ?? 0) ||
undefined` (unset by default, per that commit's own comment at the same
line), and `ARCHITECTURE.md:113-119` states plainly "Both the CLI and the web
route leave `pages` unset by default, so both get the real 2→4 behaviour."
A reader following this skill's onboarding doc today would set `OPENKB_PAGES`
to chase a "CLI default" that stopped being the default seven weeks ago,
re-introducing the exact regression the commit that fixed it was about.

Rewrote the table row (unset — `2`, promoted to `4` per product on real
page-2 yield) and the prose's closing sentence to state the current, unset-
by-default behaviour and name `d740379` as where the old behaviour ended,
matching `ARCHITECTURE.md`'s own corrected wording rather than inventing new
phrasing for the same fact.

No source change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`; same `esbuild` build-script warning SELF-623 already
explains). `pnpm check && pnpm test` both exit 0: 3389 tests passing, 13
skipped — identical to SELF-641's own count, as expected for a docs-only
change.

Backlog item: SELF-642

**SELF-643 (2026-10-04 overnight fire) — the four backend packages' `tsconfig.json`
had never been read by full path in this document; found a real strictness
asymmetry against `packages/web/tsconfig.json`, tested it, and found the fix
too large for one sitting.** `tsconfig.base.json` (read and cited 17 times in
this document already, by `tsconfig.root.json` and `packages/web/tsconfig.json`
each quoting its own flag list) sets nine hardening flags, `noUncheckedIndexedAccess`
among them. `packages/{core,swarm,sweep,providers}/tsconfig.json` each just
`"extends": "../../tsconfig.base.json"` — all nine apply there untouched. Never
checked until now: the full path of each of these four files is a zero-hit grep
against this document's own history (confirmed before starting), so the "areas
nobody has swept" framing this D section opens with still applied to them
specifically, even though `tsconfig.base.json`/`tsconfig.root.json`/the web
config have each individually been read several times over.

`packages/web/tsconfig.json` cannot `extends` the base file at all — `tsconfig.
root.json`'s own comment already explains why ("compiled by Next... bundler
resolution... DOM lib... checked by its own `tsc --noEmit`") — so it hand-copies
eight of the base file's nine flags one at a time: `strict`, `noUnusedLocals`,
`noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
`noImplicitOverride`, `allowUnusedLabels: false`, `noUncheckedSideEffectImports`
are all there, verbatim. `noUncheckedIndexedAccess` is the one of the nine
missing (`declaration` is the other, correctly absent — web is not a library
with an `outDir`). Every backend package gets array/index access typed as
`T | undefined`; the web app, which does the same kind of array/record indexing
in its own graph and UI code, does not.

Tested whether this is a real gap rather than a deliberate omission: added
`"noUncheckedIndexedAccess": true` to `packages/web/tsconfig.json` locally and
ran `tsc --noEmit` (`pnpm install --frozen-lockfile` first, fresh clone). 60
errors across 15 files (`GraphCanvas.tsx`, `KbOverview.tsx`, `NotesTab.tsx`,
`TabBar.tsx`, `Donut.tsx`, `Sparkline.tsx`, `AgentPanel.tsx`, `lib/graph/
cluster.ts`, `lib/kb-from-run.ts`, `lib/nodeTypes.ts`, plus five `.test.ts(x)`
files hitting the same sites from their own fixtures). Read a representative
sample end to end rather than trusting the count: `kb-from-run.ts:487`'s
`RELATION_WEIGHT[e.relation] ?? RELATION_WEIGHT.none` flags on the `.none`
side too, because `RELATION_WEIGHT: Record<string, number>`'s string index
signature makes even a literal dotted property read possibly-undefined under
this flag — not a bug, a type-widening artifact of the `Record<string,...>`
declaration. `GraphCanvas.tsx`'s `parseHex`'s `let h = m[1]` flags because a
regex match array is indexed, even though the pattern's own single capture
group always matches when `m` is non-null. `TabBar.tsx:97`'s `tabs[to].id`
flags even though `to` is clamped to `[0, tabs.length-1]` and the function
already returns early when `i < 0` (which is only possible if `tabs` is
non-empty in the first place). Every site checked this way was sound by a
local invariant the type checker cannot see, not a live bug the missing flag
was hiding.

Reverted the tsconfig edit — `git diff --stat` confirms the tree is back to
`HEAD` before this entry's own commit. Did not enable the flag: the asymmetry
is real and worth recording, but a fix is a ~15-file, ~60-site sweep (adding
`!`/`??`/narrower types site by site, each one needing its own sanity check
the way the three samples above got), which is exactly the "too large for a
single sitting" shape this document already has a standing pattern for (see
SELF-586, the jscpd-fix-scope note, the vitest-major-bump note) — recorded
here rather than attempted piecemeal, so a future fire picks one file at a
time with this entry's three sampled cases as the template for "safe, not a
bug" versus a real one, instead of re-deriving the same 60-error list from
scratch. No source change. `pnpm check && pnpm test` both exit 0: 3389 tests
passing, 13 skipped — identical to SELF-642's own count.

Backlog item: SELF-643

**SELF-644 (2026-10-04 overnight fire) — closed the gap SELF-643 named: enabled
`noUncheckedIndexedAccess` in `packages/web/tsconfig.json` and fixed every
resulting error.** SELF-643 judged the fix "too large for a single sitting"
at 60 errors across 15 files, after sampling three sites and confirming each
was a type-widening artifact, not a bug. Re-measured from a fresh install
(this container's `node_modules` was absent; SELF-643's own count was taken
with it present) — 61 errors across 22 files once test fixtures mirroring
the same sites are counted individually, one more than SELF-643's 60, from
a line added since. Fixed all 61, all by the same two moves SELF-643's own
sample already demonstrated were safe:

- A loop- or length-guard-bounded index (`separationShoves`'s `discs[i]`/
  `discs[j]`, `TabBar.tsx`'s `tabs[to]`, `NotesTab.tsx`'s `flat[next]`,
  `GraphCanvas.tsx`'s fullscreen focus-trap `els[0]`/`els[els.length-1]`,
  `AgentPanel.tsx`'s `shown[i-1]`, `Sparkline.tsx`'s `clean[n-1]`,
  `Donut.tsx`'s `ring[0]` under `single`) — asserted `!` with a one-line
  comment naming the guard, the same shape `sweep.ts`'s own pre-existing
  `items[i]!` sites already use (checked — this flag has applied to the four
  backend packages all along, and `!` at a bounded index is their standing
  pattern, not a new one for this fix).
- A non-optional regex capture group read through an index signature
  (`GraphCanvas.tsx`'s `parseHex`/`hexToRgba`, plus five `.test.ts(x)` files'
  own `m[1]`/`m[2]`/`m[3]` reads of their own fixture regexes) — same `!`,
  same reasoning SELF-643's own `parseHex` sample already gave.

Two sites were a real type fix rather than an assertion: `KbOverview.tsx`'s
`EcosystemPanel` compared `relations[k] > 0` directly on a `Record<string,
number>` read; changed to `(relations[k] ?? 0) > 0`, identical result for
every input (`undefined > 0` and `0 > 0` are both `false`) but now typed.
`lib/kb-from-run.ts:487`'s `RELATION_WEIGHT[e.relation] ?? RELATION_WEIGHT.
none` was SELF-643's own named sample — asserted only the `.none` side,
since the literal key is always present and `e.relation` is the genuinely
unchecked lookup the `??` exists to cover. `layout.test.ts`'s `for (const
[w, h] of [[0,0], ...])` destructured from an untyped `number[][]`, where
every element actually is a fixed pair; gave the array literal a `[number,
number][]` annotation instead of asserting, since that is what it actually
is.

Verified non-vacuous the way SELF-643's own samples were: before applying
the `!`/`??`/annotation fixes, confirmed each flagged line really did
disappear from `tsc`'s error list once fixed and that no other line moved —
no bulk sed, each of the 22 files read and edited individually against its
own surrounding guard. `pnpm check && pnpm test` both exit 0: 3389 tests
passing, 13 skipped, matching SELF-643's own count (the flag adds
type-checking, not test cases) — same gated census as SELF-643.

Backlog item: SELF-644

**SELF-645 (2026-10-05 overnight fire) — re-ran `knip` 73 commits past
SELF-575's own run; the unused-code surface is byte-for-byte unchanged, and
a false "unlisted binaries" hit along the way turned out to be this fire's
own incomplete install, not the repo.** SELF-575 installed `knip@6.37.0` at
the workspace root and found zero unused files/dependencies, 4 unused
exports, 24 unused exported types. Every manual-read angle this document
already tracks (file-by-file sweeps, coverage, jscpd, madge, exactOptionalPropertyTypes
and friends — see SELF-509/575's own cross-references) had already been
tried at least once; re-running a tool whose last result is now 73 commits
stale is a legitimate different question ("did anything change"), the same
reasoning that justifies this document's periodic `pnpm audit`/jscpd
re-checks.

First attempt (`pnpm add -D -w knip@6.37.0`, no prior `pnpm install` this
session) reported a fifth category SELF-575 never saw: `Unlisted binaries
(1): next packages/web/package.json` — alarming, since `next` plainly IS a
dependency there (`packages/web/package.json:18`). Checked by hand before
trusting it: `ls node_modules/.bin/next packages/web/node_modules/.bin/next`
found neither — this container's `node_modules` held only this fire's own
new `knip` install, never a real `pnpm install` of the workspace. Knip's
binary check resolves against installed `.bin` symlinks, not package.json
text, so an uninstalled workspace makes every real dependency look
unlisted. Ran `pnpm install --frozen-lockfile` (the fresh-clone step every
other entry in this document already takes first) and re-ran knip
unchanged — the "unlisted binaries" category vanished, confirming it was
this fire's own setup gap, not a finding. Recorded so a future fire does
not spend a cycle chasing a monorepo "unlisted binary" that is really a
skipped install step.

With the workspace actually installed, the result matches SELF-575 exactly:
zero unused files, zero unused dependencies, zero unlisted dependencies, the
same 4 unused exports (`pairsOf`/`blockTheNetwork` in `packages/sweep/tests/
fixture.ts`, `GLYPH_KINDS`, `noteRunStarted`) and the same 24 unused
exported types, both lists identical name-for-name and line-for-line to
SELF-575's own. Nothing added in the 73 commits between — knip's own
registry confirms that axis is still clean rather than assuming SELF-575's
"nothing new" still holds by default.

No source change. `git checkout -- package.json pnpm-lock.yaml` before
finishing (`git diff --stat` confirms clean). `pnpm install --frozen-lockfile`
then `pnpm check && pnpm test` both exit 0: 3389 tests passing, 13 skipped —
identical to SELF-644's own count.

Backlog item: SELF-645

**SELF-646 (2026-10-05 overnight fire) — a citation-drift sweep (SELF-509's
own method, "grepped every `file.ts:NNN` comment citation... and diffed
each citation's own last-edited commit against its target file's last-edited
commit") found 13 stale citations across 8 `packages/web` files, most of
them caused by SELF-644's own edits shifting line numbers below each
inserted comment.** SELF-509's original sweep checked citations against
`git blame` timing and found none stale; it did not re-verify each
citation's text against its target line, which is the gap this fire closes
for the one package with the most comment-citation density
(`kb-from-run.ts` alone is cited by line number from six other files).

Checked every `file.ts:NNN`/`file.tsx:NNN` citation in `packages/web` whose
target was a file SELF-644 touched (`GraphCanvas.tsx`, `KbOverview.tsx`,
`NotesTab.tsx`, `TabBar.tsx`, `Donut.tsx`, `Sparkline.tsx`, `AgentPanel.tsx`,
`cluster.ts`, `kb-from-run.ts`) by reading the cited line's actual content
against what the citing comment claims it says — not by timestamp, since a
file can be edited and still keep a citation accurate (or, as five of the 13
found here show, be wrong for reasons that predate SELF-644 entirely).
`TabBar.tsx`, `Donut.tsx`, `Sparkline.tsx` and `AgentPanel.tsx` had no
external citations into them (checked by grep) and were not the line SELF-644
moved in `NotesTab.test.tsx` (a same-line `!`-assertion, no net shift) — all
four clean. The rest were not:

- `KbOverview.test.ts:18` cited `kb-from-run.ts:92-107` for the full
  `RELATION_WEIGHT` object; its real closing brace is line 118 — the object
  grew an 8-line comment (the `unknown: 20` rationale) after this citation
  was written, predating SELF-644. Corrected to `92-118`.
- The same file's own `lines 827-971` for "the dashboard's headline... and
  the placement gauge" pointed at an unrelated `useEffect` cleanup; the real
  anchors are the headline stat at line 943 and `PlacementPanel` itself
  (defined 247-303, rendered at 1005) — also predates SELF-644. Corrected to
  name both directly instead of guessing a single range.
- `NoteView.test.ts:14` and `NoteView.tsx:67` both cited the same pair of
  `sources[].url` builders in `kb-from-run.ts` as `754,772`; SELF-644 added a
  net +2 lines above them (the `RELATION_WEIGHT[e.relation] ?? ...none!`
  comment at line 486-487). Real lines are `756,774` — fixed in both files.
  `NoteView.test.ts:12`'s own `lines 325-326` for its icon+label render was
  separately wrong (real lines 346-347, predating SELF-644) — fixed too.
- `ProductsTab.test.tsx:126` cited `kb-from-run.ts:685` for `report.readPages`
  (real line 731, 46 lines off — a drift far larger than SELF-644's own
  shift, so mostly pre-existing) and `:169` cited `:287` for the
  integrations `foundAt` trim check (real line 279, also pre-existing).
  Fixed both.
- `NotesTab.test.tsx` cited `pathFor` at `kb-from-run.ts:147` (real: 167),
  the noise-routing guard at `430-433` (real: `471-474`), and the path
  sanitizer at `149` (real: 169) — all three pre-existing drift, not
  SELF-644's. Its fourth citation (`KIND_GROUP`, `73-80`) was already
  correct and left alone.
- `cluster.ts:135` cited `GraphCanvas.tsx:906` for the `assignClusters` call
  site that builds `clusterOf`; SELF-644's `parseHex`/`hexToRgba`/focus-trap
  comments shifted everything after line ~307 in `GraphCanvas.tsx` by +5,
  moving the real call from (pre-SELF-644) 906 to 911 — the one citation
  here that SELF-644 itself caused outright. Its sibling citation,
  `bake-layouts.ts:146`, was untouched by that commit and still correct.
- `layout.test.ts:285` cited `GraphCanvas.tsx:862/873` and
  `bake-layouts.ts:100/117` for the two `maxDeg`-deriving call sites; real
  lines are `862/874` (GraphCanvas's own `nodeCount` declaration at 862 was
  already right, only the `seedPosition` call one line later had drifted)
  and `118/135` (`bake-layouts.ts`'s `maxDeg` declaration and its own
  `seedPosition` call — a larger, pre-existing drift). Fixed both halves.
- `kb-from-run.ts:988` cited `map.ts:246` (a basename-only cross-package
  citation into `packages/swarm/src/map.ts`, this document's own established
  shorthand per the citation at line 3128) for `entityEdges()`'s `domainOf`;
  real lines are `267,269`. Fixed.

Every fix was read against the target file directly, not inferred from a
line-count delta — `kb-from-run.ts`'s citations in particular mix drift from
SELF-644 (a few lines) with drift that long predates it (tens of lines),
and treating all 13 as "SELF-644 shifted everything by N" would have
corrected some and silently re-broken others. No source logic changed —
every edit is a comment-text correction. `pnpm install --frozen-lockfile`
first (fresh clone, no `node_modules`). `pnpm check && pnpm test` both exit
0: 3389 tests passing, 13 skipped — identical to SELF-645's own count, as
expected for a comment-only change.

Backlog item: SELF-646

**SELF-647 (2026-10-05 overnight fire) — a genuinely new angle never tried by
any prior fire: audited every `addEventListener`/`setTimeout`/`setInterval`/
`MutationObserver`/`ResizeObserver` subscription in `packages/web` for a
missing cleanup or a stale-response race, the classic bug class none of this
document's many coverage/citation/lint sweeps would ever surface (the code
runs identically on every fixture regardless of whether an old subscription
also keeps firing after remount) — found nothing to fix.** Grepped every
`addEventListener(` call in non-test `packages/web` source (11 sites across 6
files) and read each one's enclosing `useEffect` end to end against its
`return` cleanup, rather than trusting that a `removeEventListener` nearby
was the matching one:

- `GraphCanvas.tsx:336,346` (`subscribeCoarsePointer`/`subscribeReducedMotion`,
  `matchMedia` `"change"` listeners used as `useSyncExternalStore` sources) —
  each returns `() => mq.removeEventListener(...)` on the same `mq` instance.
- `GraphCanvas.tsx:716-724` (a `MutationObserver` watching `data-theme` for
  the palette-resolve effect) — `mo.disconnect()` in the cleanup.
- `GraphCanvas.tsx:1240-1244,1253-1254` (two `document` `"keydown"` listeners,
  the fullscreen focus-trap and the non-fullscreen Escape handler) — both
  removed in their own cleanup; the focus-trap's also restores
  `document.body.style.overflow`, confirmed it is the same `prevOverflow`
  captured before the listener was attached, not a value that could drift.
- `GraphCanvas.tsx:1070-1164`'s retry-until-`d3Force`-exists `setTimeout` loop
  and its `peekTimer` (`:591-597,2010-2011`, the hover-peek delay) — the
  first clears via `window.clearTimeout(timer)` in the effect's own cleanup
  (the closure captures the mutable `timer` variable directly, so the final
  scheduled id is always the one cleared, not a stale earlier one); the
  second is cleared both on every re-arm (`:2010`, before scheduling a new
  one) and on unmount (`:592-597`, a dedicated mount-only effect whose only
  job is that one `clearTimeout`).
- `GraphSearch.tsx:61-62`, `CommandPalette.tsx:143-145` (two `window`
  `"keydown"` shortcuts) and `useUrlView.ts:82-84` (`"popstate"`) — all three
  are the same one-line `addEventListener`/`return () =>
  removeEventListener` shape, each confirmed removing the identical `onKey`/
  `onPop` reference it added.
- `TabBar.tsx:66-76` (a `ResizeObserver` plus `window` `"resize"` and a list's
  own `"scroll"` listener, three subscriptions in one effect) — cleanup
  disconnects the observer and removes both listeners; confirmed the `list`
  reference removed at cleanup time is `listRef.current` captured at effect
  setup, not re-read at cleanup (which would be `null` after an unmount).
- `ScrollFilm.tsx:51-58` (`window` `"scroll"`/`"resize"`, driving a rAF-batched
  callback) — cleanup removes both and also `cancelAnimationFrame`s any
  in-flight frame, so a scroll that fires right before unmount cannot call
  back into a torn-down component.
- `CommandPalette.tsx:154-171`'s `requestIdleCallback`-or-`setTimeout`
  fallback (warming the gallery fetch) — guarded by both a `dead` boolean
  checked inside the callback AND a real `cancelIdleCallback`/`clearTimeout`
  in cleanup, the belt-and-suspenders version of the pattern below.
- `BuildWorkflow.tsx:314` (the stream's `AbortController`, aborted on
  unmount) and `:320-322` (the elapsed-time `setInterval`, `clearInterval`
  in cleanup).

Three short, user-triggered `setTimeout`s with no unmount guard
(`GraphSearch.tsx:85`'s 120ms input-blur delay, `BuildWorkflow.tsx:264`'s
1200ms post-finish redirect, `:948`'s 2000ms "copied" reset) are not the same
bug class: each fires once off a direct user action (not a prop/effect that
could re-arm this subscription repeatedly across remounts), and a `setState`
landing after unmount here is the ordinary React 18 no-op — no warning, no
accumulating listener, nothing left running — not the leak-shaped shape this
sweep was looking for.

Separately checked the inverse bug — a slow response landing after a newer
one, or after unmount, clobbering fresher state — on every `fetch` call
inside a `useEffect` in `packages/web/components`: `GraphCanvas.tsx:735-760`
(the KB graph fetch) and `:970-990` (the baked-layout fetch) both guard every
`setState` behind a local `cancelled`/`dead` boolean set at the top of a
later run or at cleanup; `KbOverview.tsx:808-830` and `NoteView.tsx:121-140`
use the identical `cancelled` pattern, both captioned as deliberate because
the parent keys the component by slug/path so a slug change is a fresh mount
rather than a prop update the existing effect would need to re-guard.
`CommandPalette.tsx`'s idle-fetch (above) uses the same `dead` flag. Every
fetch-in-effect in the package already closes this race; none found open.

No code change — every site checked was already correct. `pnpm install
--frozen-lockfile` first (fresh clone, no `node_modules`). `pnpm check &&
pnpm test` both exit 0: 3389 tests passing, 13 skipped — identical to
SELF-646's own count, as expected for a read-only fire.

Backlog item: SELF-647 - BLOCKED

**SELF-648 (2026-10-05 overnight fire) — a genuinely new angle: this app has
never set a single security response header, and SELF-647's own exhaustive
list of methodologies (coverage, citation-drift, knip, madge, jscpd, pnpm
audit, every TS strictness flag, manual end-to-end reads of essentially every
source file) had no entry for this.** Grepped the whole of `packages/web` for
"X-Content-Type-Options", "nosniff", "X-Frame-Options" and "Content-Security"
— zero hits anywhere, confirming this was never set, not merely undocumented.

Scoped down from a full header sweep on purpose. `X-Frame-Options: DENY`
looked like the obvious next addition until reading `ScrollFilm.tsx`: it
embeds `/launch-rig.html` (a same-origin static file under `public/`) in its
own `<iframe>` to drive the launch film off scroll position. `DENY` blocks
framing from ANY origin, same-origin included, so adding it anywhere that
also covers `/launch-rig.html` would have silently broken that embed — the
exact "can't visually verify it still looks right" risk this routine's own
rules warn about. `SAMEORIGIN` would dodge that, but the task's hard scope is
narrower than "ship a CSP": a `Permissions-Policy` was the next thing
considered and dropped the same way, once `BuildWorkflow.tsx`'s
`navigator.clipboard` copy-button turned up — a restrictive policy disabling
`clipboard-write` would break it, and there is no way to confirm that from a
fixture test alone. `X-Content-Type-Options: nosniff` has neither failure
mode: it only constrains how a browser interprets a response's OWN declared
content-type, never which origins may frame a page or which browser APIs a
page may call, so there is no feature in this app it can silently break.

Added it in `packages/web/proxy.ts` (the one place already proven, by
`proxy.test.ts`'s own doc comment, to run in front of every matched
route — everything except `_next/static`, `_next/image` and `favicon.ico`,
per its `config.matcher`) rather than `next.config.ts`: `headers()` there
would need its own route-pattern reasoning against the same `_next` paths
this file's matcher already excludes correctly, and `proxy.ts` is the
narrower, already-tested surface. The reason this specific app wants it,
per `SECURITY.md`'s own stated scope ("the engine fetches arbitrary
third-party web pages... injection into a fetched page... that escapes into
something it shouldn't"): every `/api/kb/*` route answers with entity names
and descriptions a SWEPT SITE chose, as `application/json`, and `nosniff` is
the one-line guarantee a browser hitting such a URL directly never re-sniffs
that body as HTML on the strength of its content over its declared type.

Pulled the three `NextResponse.next()` call sites (the two credential-unset/
credential-correct successes) through one new `allow()` helper so they
cannot drift apart, and added the same header directly to the existing 401
`NextResponse` literal. Added one new test (the open-credentials path,
previously only checked for `status`) and extended two existing ones (the
no-header 401 case, the exact-right-credentials case) to also assert
`X-Content-Type-Options: nosniff`. Verified non-vacuous by mutation:
reverted just `proxy.ts` (kept the test changes) and reran — all three
assertions failed reading `null`; restored the fix and reran clean.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3390 tests passing (up from 3389, one
new), 13 skipped — same gated census as SELF-647.

Backlog item: SELF-648

**SELF-649 (2026-10-05 overnight fire) — ran `jscpd` (SELF-615/637's tool)
over `scripts/`, `packages/web/app`, `packages/web/lib` and
`packages/web/components` for the first time; every prior run had stopped at
the four library packages' `src/`.** Ten clones came back. Most were the
by-design shape prior fires have already learned to leave alone: the three
`api/kb/[id]/*` and `api/run/[id]/route.ts` hits are the same
`guarded(async (_req, { params }) => { const { id } = await params; … })`
Next.js route-handler boilerplate every dynamic route carries, already
thinned once by `findKb` (its own doc comment says so); `demo-investigate.ts`
vs. `discover.ts` and `experiment.ts` vs. `overnight.ts` are parallel CLI
arg-parsing blocks for siblings that don't share a caller; `swarm.ts` vs.
`sweep.ts` is two CLIs printing a cost summary in their own shape;
`kb/page.tsx` vs. `page.tsx` and the two `runs/[id]/page.tsx` ranges are
JSX fragments, not logic. None of those is a second, independently-typed-out
description of one fact the way `sweptFromRival` (SELF-615) was — forcing a
shared function onto any of them would be coupling unrelated call sites for
a graph-hygiene number only, the exact move SELF-595/637 already declined
elsewhere in this document.

One clone was the real thing: `scripts/check-skips.mjs` and
`scripts/check-test-collection.mjs` had byte-identical `rel()`, `run()` and
`TEST_FILE` — confirmed by reading both in full, not just trusting jscpd's
line range. Both files' own doc comments already argue at length for why the
two guards must stay independent (one reads `vitest list` against a
hand-written `GATES` manifest, the other reads `vitest list` against
`git ls-files`; neither set may be derived from the other, or the guard
proves only that something agrees with itself) — but that argument is about
the two SETS each script computes, not about the generic path/subprocess
glue or the "what is a test file" regex both already leaned on identically.
Confirmed by reading each file end to end before touching either: `rel`,
`run` and `TEST_FILE` never appear in the independence argument itself, only
in service of it. Two copies of `TEST_FILE` is the live risk — the repo's own
`sweptFromRival` precedent ("a closed set with two mappings is a closed set
that will disagree with itself") applies to this pair exactly: a future
`.test.` convention change applied to one copy and not the other would make
the two guards quietly disagree about what counts as a test file, with
nothing to catch it.

Fixed by extracting all three into a new `scripts/check-shared.mjs`, with a
doc comment naming jscpd, the two files, and why sharing this specific glue
does not weaken either guard's independence. Both scripts now import from
it and no longer define their own copies; `check-test-collection.mjs` kept
its detailed `.spec.`-inclusion reasoning in place (that argument is about
the regex's CONTENT, which did not change) with a short pointer added to
where the pattern itself now lives. No behavior change — confirmed by
running both scripts directly before and after and diffing stdout
byte-for-byte (identical), then by mutation: broke `TEST_FILE` in the new
shared file alone and reran both — `check-test-collection.mjs` reported all
231 tracked test files as "foreign" (collected by vitest, no longer
matched by the broken pattern as being on disk) and `check-skips.mjs`
reported all seven `GATES` entries as "declared gate not found in the
source" (no test file matched the broken pattern, so `sourceSites()` found
nothing to scan); restored the file and both guards returned to their
exact prior output. `tests/check-skips.test.ts` and `tests/collection.test.ts`
already exercise both scripts as real subprocesses rather than importing
their internals, so they needed no changes to keep covering the refactored
code; no new test added for the same reason B1-B4 and several SELF-<n>'s
before this one gave for a pure-glue extraction — `tsc`/the two existing
subprocess tests are what prove it.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3390 tests passing, 13 skipped —
identical to SELF-648's own count, as expected for a behavior-preserving
refactor.

Backlog item: SELF-649

**SELF-650 (2026-10-05 overnight fire) — a one-line `rel` inconsistency found
by widening SELF-648's header sweep to every outbound anchor in `packages/web`,
rather than re-running that sweep's own headers.** Grepped every
`target="_blank"` anchor in the package (13 sites across 8 files) and read
each one's `rel` by hand instead of trusting a single spot-check: `ProductsTab.tsx`
(x4), `KbBrowser.tsx`, `NoteView.tsx`, `HeaderNav.tsx`, `DemoHome.tsx` and
`layout.tsx` (x2) all carry `rel="noreferrer"` — except `SearchesPanel.tsx:198`,
the raw-SERP-hit link inside the "searches" build panel, which carried
`rel="noopener"` alone.

That is not a cosmetic gap. `noopener` only severs the new tab's
`window.opener` handle; it does nothing about the `Referer` header the
browser still sends on the navigation itself, which for this specific link is
the current KB-map page's own URL (run id and anchor domain both in the
path). Every other outbound link in the package already uses `noreferrer`
for exactly this reason — confirmed by reading each one, not just counting
`rel=` occurrences — so this one link was the sole path by which clicking
through a raw search result could tell the site a run is investigating that
the investigation happened. `noreferrer` is a strict superset of `noopener`
in every browser this app targets (MDN, living standard), so switching loses
no protection the single `noopener` was providing.

Fixed by changing that one `rel` to `"noreferrer"` with a comment naming the
other six files already doing this and why. The hit anchor sits inside the
per-row `isOpen` branch, which `SearchesPanel.test.tsx`'s own header comment
already establishes nothing in this file's `renderToStaticMarkup`-based
suite can reach (no click ever runs in a static render) — so rather than add
a jsdom/RTL harness this repo doesn't have (B1-B4's documented limit), tested
it the way `SkipLink.test.tsx` already tests its own click-gated
`tabIndex={-1}` claim: read the component's own source as text and assert
the anchor's `rel` by regex. Verified non-vacuous by mutation: flipped the
source back to `rel="noopener"` with the test unchanged, reran — the new
test failed showing the diff; restored the fix and reran clean before
staging.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3391 tests passing (up from 3390, one
new), 13 skipped — same gated census as SELF-649.

Backlog item: SELF-650

**SELF-651 (2026-10-05 overnight fire) — read `prompts/agents/listicle.md`
against its one call site end to end, a prompt/code pairing no prior fire had
named by this file (`grep -c listicle.md docs/overnight-backlog.md` was 0
before this entry); found the contract intact and one already-flagged,
already-unresolved risk that still needs a live run to close.** The prompt
(`listicle.md`) asks for one field, `vendors: string[]`, "each written once";
the call site's schema (`sweep.ts:4989-4993`) asks for exactly that, and the
anchor-exclusion the prompt's second line promises ("Do not list it") is
backed by the same `anchorBanName`/`banned()` pair every other name-extraction
call in this file uses (`sweep.ts:3502`, `:5055`) — not a second, drifted copy
of the rule.

Read the dedup block right below the call (`sweep.ts:5021-5055`) expecting to
find the bug its own comment describes ("Left case-sensitive, two spellings of
one vendor both survive into `fresh`...the fix belongs at the one caller that
can hand it a case-variant duplicate") — and confirmed instead that the fix is
already there: `seenLabel` dedupes on `v.toLowerCase()`, so "Wix" and "WIX"
from two different roundup rows collapse to one entry before `rivalHand` ever
sees them. Checked by git blame (`git log -L 5021,5056:packages/sweep/src/
sweep.ts`): the comment and the fix landed together in one commit (6b776e0),
the comment narrating the bug the code beneath it closes — not a stale
description of a regression, as its past tense first read like.

The one open question this read could not close: `LISTICLE_MAX_ROWS = 60`
(`sweep.ts:681`) carries its own comment admitting it "sat comfortably inside
one call's input floor back when `TRIAGE_BATCH` was itself 60... the
timeout-driven halving to 30 has never been re-checked against this
constant." That halving (`e2e7ba3`, 2026-08-23) was measured: a 60-row triage
call took 28.6-34.7s against a since-also-halved 60s `CALL_TIMEOUT_MS`
(`sweep.ts:609-611`) on a slow provider, and `TRIAGE_BATCH` was cut to 30 the
same commit for safety margin. `listicle` takes the same unmodified
`CALL_TIMEOUT_MS` (no per-agent override exists for it in the `agent ===
"link" ? ... : CALL_TIMEOUT_MS` chain at `sweep.ts:2185-2194`), so the same
arithmetic that justified halving `TRIAGE_BATCH` could apply to
`LISTICLE_MAX_ROWS` too — or might not, since the listicle prompt asks a
narrower question (names only, `maxOutputTokens: 1_500`) than triage's
per-host classification and the provider is now throughput-sorted rather than
pinned to the slow host that caused the original overrun. Deciding between
those needs a real call's wall-clock time, and this environment is forbidden
from making one ("no live or paid runs, ever"). Halving `LISTICLE_MAX_ROWS` to
match `TRIAGE_BATCH` on the strength of the analogy alone, without a
measurement, would be exactly the "arithmetic dressed as evidence" P1-8 named
and refused to ship — so `LISTICLE_MAX_ROWS` stays at 60, unchanged, and this
entry hands the open question to whoever next runs a real sweep with roundup
rows in it: time the listicle-harvest call and compare it against
`CALL_TIMEOUT_MS`.

No code change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`). `pnpm check && pnpm test` both exit 0: 3391 tests passing, 13
skipped — identical to SELF-650's own count, as expected for a read-only fire.

Backlog item: SELF-651 - BLOCKED

**SELF-652 (2026-10-05 overnight fire) — the page URL itself (a run id in
every `/kb/[id]`/`/runs/[id]` path, an anchor domain in every `/kb/[domain]`
one) never carried a `Referrer-Policy`, the one header class SELF-648's own
security-header sweep grepped for by name (`X-Content-Type-Options`,
`X-Frame-Options`, `Content-Security`) and never checked — confirmed by
`grep -n "Referrer-Policy" docs/overnight-backlog.md` returning nothing
before this entry.** `graphIcons.ts:80` and `SiteIcon.tsx:113` already set
`referrerPolicy="no-referrer"` per `<img>`, by hand, for the one concrete
case anyone had measured: a favicon fetch naming a third-party host. That
covers image loads; it says nothing about what this app's own pages send as
`Referer` on a navigation or a `fetch()` call, which is the same class of
leak SELF-650 just fixed for one outbound anchor (`SearchesPanel.tsx`) by
switching its `rel` to `noreferrer`.

Checked how much of the gap the browser default already closes before
assuming a header was needed: every browser this app targets has defaulted
to `Referrer-Policy: strict-origin-when-cross-origin` since 2020/2021
(Chrome 85, Firefox 87, Safari) — the same "living standard" default
SELF-650's own `noopener`⊂`noreferrer` argument rests on. That default
already strips the path (and with it the run id or anchor domain) on any
cross-origin request; what it does NOT strip is this origin's own bare
hostname on a cross-origin request, or the full URL — including the run id
in the path — on a same-origin one (a `fetch()` to this app's own `/api/*`
routes, or any future same-origin anchor). `no-referrer` closes both, and
costs nothing: grepped every route in `packages/web` for
`req.headers.get("referer")` (zero hits — nothing here reads `Referer`), and
checked every external resource this app's pages load for one that needs a
referrer back — `next/font/google` self-hosts at build time (no runtime
request to Google's own servers at all, confirmed by reading `app/layout.tsx`'s
`next/font/google` import and how Next handles it), and the one iframe
(`ScrollFilm.tsx`'s `/launch-rig.html`) is a same-origin navigation a missing
`Referer` cannot break.

Fixed in `packages/web/proxy.ts`'s `allow()` — the same single exit point
SELF-648 built for `X-Content-Type-Options`, extended here rather than
duplicated — plus the 401 response's own header literal, matching that
response's existing `X-Content-Type-Options` line. Extended `proxy.test.ts`'s
three header assertions (open path, 401 refusal, successful auth) with a
`Referrer-Policy` check each, plus one new dedicated test for the open path.
Verified non-vacuous by mutation: stashed just `proxy.ts`, reran — all three
`Referrer-Policy` assertions failed with `null`, confirming none of them
passed by coincidence; restored and reran clean.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3392 tests passing (up from 3391, one
new), 13 skipped — same gated census as SELF-651.

Backlog item: SELF-652

**SELF-653 [id collision, see SELF-661] (2026-10-05 overnight fire) — `report.clock.predictedSeconds`
(SELF item never named: `grep -c "report.clock\|predictedSeconds"
docs/overnight-backlog.md` was 0 before this entry) silently priced every
run at the clock model's default rank width, never the width the run
actually ranked at.** Read `core/clock.ts` end to end — a file no SELF-<n>
entry had swept by name — against its one consumer, the `clock` field
`sweep.ts` adds to every report (added 4913a23, 2026-08-24, right after
51df06e measured the phase-cost model conservative). `rankSeconds` takes an
explicit `poolWidth` because `clock.ts`'s own doc states the hazard by name:
"a deployment ranking at 24 was reserving 3x the rank it needed." Grepped
every call site (`grep -n "runSeconds(\|rankSeconds("  packages/sweep/src/
sweep.ts`): the four mid-run clock checks (`sweep.ts:4315,4322,4471,5487`)
all thread the run's own `RANK_CONC` through as the third argument — except
`report.clock`'s own `predictedSeconds: Math.round(runSeconds(firedCount))`
(`sweep.ts:7671` before this fix), the one call site that dropped it and
fell back to `MEASURED_PHASE_COSTS.rankPoolWidth` (8).

Confirmed this is not cosmetic by recomputing the one real number
`clock.ts`'s own doc cites: "the first deadline-bound run predicted 502
seconds and took 214." `runSeconds(43)` at the default width 8 is exactly
502.37 → 502 — the comment's own figure is the buggy computation, not a
hand-check of a different one. That run's `.env` sets
`OPENKB_RANK_CONCURRENCY=24` (the figure `clock.ts` itself says the run
"actually used," two paragraphs down); `runSeconds(43, undefined, 24)` is
267.59 → 268, against the actual 214 — a 1.25x over-prediction, not the
2.3x `clock.ts` recorded as a surprising outlier. The bug produced the
outlier the comment then spent a paragraph explaining.

Fixed the one call site: `runSeconds(firedCount, undefined, RANK_CONC)`,
matching the other four. Left a CORRECTION paragraph in `clock.ts` right
after the "over-predicted by 2.3x" line naming the bug, the corrected 268s/
1.25x figure, and an explicit note that the "41 runs on disk" spread three
paragraphs up (`min 0.42 … median 1.44 … max 2.36`) was not re-derived by
this fix — those runs' own `OPENKB_RANK_CONCURRENCY` at run time is not
recorded anywhere this fire could read it back from, so that spread may
carry the same width-8 bias and is left as an open question for whoever can
check it against the raw `runs/` artifacts.

Added `packages/sweep/tests/sweep-buys-the-hand-it-was-dealt.test.ts`'s
`predictedSeconds prices at this run's own rank width` case: sets
`OPENKB_RANK_CONCURRENCY=24`, asserts `predictedSeconds` equals
`runSeconds(queries, undefined, 24)` exactly AND differs from the
width-8 default's own number (so a regression that silently drops the
third argument cannot pass by the two widths coinciding). Verified
non-vacuous by mutation: reverted just the `sweep.ts` call site, reran —
the new test failed (`expected 224 to be 148`); restored the fix and
reran clean before staging.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3393 tests passing (up from 3392,
one new), 13 skipped — same gated census as SELF-652.

Backlog item: SELF-653

**SELF-653 [id collision, see SELF-661] (2026-10-05 overnight fire) — closed the one gap SELF-648's own
header sweep named and deliberately left open: `X-Frame-Options`.** SELF-648
considered `X-Frame-Options: DENY` as its "obvious next addition" and
rejected it because `ScrollFilm.tsx` frames `/launch-rig.html` in its own
`<iframe>` and `DENY` blocks framing from every origin, same-origin included
— but its own writeup named the fix in the same sentence ("`SAMEORIGIN` would
dodge that") and scoped it out anyway, on purpose, to keep that fire to one
header. Re-read `ScrollFilm.tsx` to confirm the premise still holds rather
than trusting a four-commits-old description: `src="/launch-rig.html?t=0"` is
still a bare relative path, so the framed document is always served from
this app's own origin. Grepped the rest of `packages/web` for `<iframe` to
confirm it is still the only one (one hit) and for
`X-Frame-Options`/`frame-ancestors`/`sandbox="`/`allow-same-origin` to
confirm nothing already sets or depends on frame policy (zero hits on all
four).

`SAMEORIGIN` blocks exactly the clickjacking case the header exists for (a
different origin framing this app's pages, e.g. to overlay invisible UI on
top of the "Try the beta" start button or a KB map) while leaving the one
same-origin embed this app actually has untouched — unlike `DENY`, which
would have silently broken `ScrollFilm.tsx` with no fixture able to catch it
(the exact risk SELF-648 flagged and this routine's own rules repeat: no
jsdom/RTL harness exists here, and the routine can't visually verify the web
app).

Fixed in `packages/web/proxy.ts`'s `allow()` — the same single exit point
SELF-648/SELF-652 built and extended for `X-Content-Type-Options` and
`Referrer-Policy` — plus the 401 response's own header literal, matching
that response's two existing lines. Extended `proxy.test.ts`'s three header
assertions (open path, 401 refusal, successful auth) with an
`X-Frame-Options` check each, plus one new dedicated test for the open path,
mirroring SELF-652's own shape exactly. Verified non-vacuous by mutation:
stashed just `proxy.ts`, reran — all three new `X-Frame-Options` assertions
failed reading `null`; restored and reran clean before staging.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3393 tests passing (up from 3392, one
new), 13 skipped — same gated census as SELF-652.

Backlog item: SELF-653

**SELF-654 (2026-10-05 overnight fire) — `proxy.ts` set four response
headers and had never set `Strict-Transport-Security`, the one header in
that file's own allowlist that answers SECURITY.md's "auth bypass on the
hosted app's basic-auth gate" scope item directly rather than the
fetched-third-party-content class SELF-648/650/652/653 all addressed.**
Basic auth (this file's whole reason to exist) sends the password on every
request, base64-encoded — as good as plaintext on the wire. Without HSTS, a
visitor's first request, or any request after a cleared cache, can be
silently downgraded to `http://` by an on-path attacker (a captive portal, a
hostile access point) and that downgraded request carries the real
credential. Confirmed the gap first: grepped `packages/web` for
`Strict-Transport-Security` and `next.config.ts` for a `headers()` block
(zero hits either way), and `docs/overnight-backlog.md` itself for the
header name (also zero) — nobody had named this one yet.

Checked the two failure modes the file's own history already rejected
headers over (`DENY` breaking `ScrollFilm.tsx`'s same-origin iframe, a
`Permissions-Policy` breaking `BuildWorkflow.tsx`'s `navigator.clipboard`
button, both recorded a few paragraphs up in this same file): HSTS has
neither shape. Per spec, a browser ignores `Strict-Transport-Security`
entirely on a plain `http://` response, so it cannot touch `next dev` over
`http://localhost` or any host that never terminates TLS — there is no
feature this header can silently disable. Chose `max-age=31536000` (one
year) with neither `includeSubDomains` nor `preload`: a clone of this repo
can land on any custom domain, and this file has no way to confirm every
subdomain under that domain is itself served over HTTPS, so forcing it with
`includeSubDomains` would be the same over-broad move `SAMEORIGIN`
deliberately avoided two paragraphs up; `preload` is a browser-vendor list
that takes months to leave once joined, which this file cannot promise on
behalf of a domain it has never seen.

Set it in `allow()` and the 401 response's own header literal, alongside
the three headers already there and built the same way by SELF-648/652/653.
Extended `proxy.test.ts`'s three header-bearing assertions (open path, 401
refusal, successful auth) with a `Strict-Transport-Security` check each.
Verified non-vacuous by mutation: stashed just `proxy.ts`, reran — all three
new assertions failed reading `null`; restored and reran clean before
staging.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3395 tests passing (up from 3394, one
new), 13 skipped — same gated census as SELF-653.

Backlog item: SELF-654

**SELF-655 (2026-10-05 overnight fire) — `scripts/spend-caps.ts`, named by
hand in this section's own scope list ("`core/src/ledger.ts` and
`spend-cap.ts`") but never once itself (confirmed: `grep -c "spend-caps.ts"
docs/overnight-backlog.md` was 1 before this entry, a passing mention inside
SELF-509, not a dedicated read) — a fresh end-to-end read against its three
call sites found a real gap in `scripts/batch.ts`, the file that multiplies
and the one this file's own header calls "the largest single exposure in
the repo... the only entrypoint a person deliberately walks away from."**

Read `spend-caps.ts` in full first — `readCapUsd`/`capUsdOrExit`'s
malformed-value refusal, `listRoom`'s in-flight reservation arithmetic,
`stoppedRun`/`cappedReason`'s shape — against `packages/core/src/
spend-cap.ts`'s `SpendTrip`/`withSpendCap` and found the two line up exactly
as documented; no bug in the file itself. Then read every caller
(`scripts/sweep.ts`, `scripts/swarm.ts`, `scripts/batch.ts`) rather than
trusting that a file with this much doctrine in its own comments must be
used correctly everywhere it is called.

`batch.ts`'s own `listRoom` comment states the defence by name: "A run in
flight is held against the budget at the most it can still become, and
settles to its real cost when it ends." Traced what "settles" actually does
in `computeOutcome` (`batch.ts:173`): a capped run with no readable
`stopped-*.json` is charged the full run cap rather than left null —
`readCapUsd`'s own "the money is gone either way" reasoning, already
written there. A run killed by the outer wall clock (`TIMEOUT_S`, the
SIGKILL fired when a sweep hangs) was NOT given the same treatment — it fell
through to `usd: null`, and the caller's `spent += out.usd ?? 0` silently
priced it at $0.

Confirmed this is reachable, not theoretical, by reading `scripts/sweep.ts`
end to end for every place it writes `runs/sweep-*.json`: exactly one
`writeFileSync`, the last line of the file, after the whole `sweep()`
promise has resolved. A SIGKILL mid-run (the only reason `killed` is ever
true) therefore always leaves nothing on disk, however much it had already
spent — and `TIMEOUT_S`'s own comment names a worked example of exactly that
spend: "figma.com... killed at 91% done... having spent every dollar of
it," cited there to justify raising the timeout, never connected to what the
list budget does with that dollar afterward. The moment such a run's
`inFlight--` fires, its reservation is released and its real bill is gone
from `spent` for good — eroding the $50 list cap specifically in the
unattended, walk-away case the whole file exists to bound, which is a worse
place for a budget to quietly loosen than any of the four header fixes
SELF-648/650/652/653/654 made in a file nobody walks away from.

Fixed with one line mirroring the existing capped-run pattern exactly:
`if (i.killed && usd === null) usd = i.runCapUsd`. Scoped to `killed`
specifically, not every unexplained failure — an ordinary crash (bad exit
code, no file) can fail in its first second for $0, and charging every such
case at a full run cap would stop a list early over typos in a domain list,
which is speculative in the other direction. `killed` carries no such
ambiguity: it only fires after the complete `TIMEOUT_S` has elapsed, so
there is no fast-failure case it could be confused with.

Extended `tests/batch.test.ts`'s existing "killed by the outer wall clock"
case, which asserted `ok`/`detail` but never checked `usd` at all — the
exact blind spot that let this ship. Added three cases: killed with no map
is charged the run cap; killed on the rare race where the map landed anyway
keeps its real (lower) cost, unCharged by the new branch; an ordinary
non-killed failure with no map is still left null, proving the fix did not
widen past its scope. Verified non-vacuous by mutation: reverted just the
new line in `batch.ts`, reran — the new "charged the run cap" case failed
(`expected null to be 8`); restored the fix and reran clean before staging.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3398 tests passing (up from 3395,
three new), 13 skipped — same gated census as SELF-654.

Backlog item: SELF-655

**SELF-656 (2026-10-05 overnight fire) — before adding anything, spent this
fire checking whether there was anything left to add: read eight
never-individually-named files end to end (every `app/api/kb/**/route.ts`
handler, `next.config.ts`, `lib/graph/layoutCache.ts`, `lib/graph/search.ts`,
`lib/graph/settings.ts`), ran a fresh `@vitest/coverage-v8` pass scoped to
`packages/web/lib` and `packages/web/components` (the two trees SELF-509/620/
638/640 last measured), and read every uncovered line that turned up
(`runs.ts:834,842,913,992,1072,1102-1103,1111,1137`, `spend-limits.ts:519`,
`cluster.ts:169`, `supabase.ts:280`) against the comment already sitting at
each one — all nine were already named dead-by-construction or
intentionally-untested by a prior fire, and all eight files read clean.
Confirmed by `grep -c` against `docs/overnight-backlog.md` that every one of
these eight was genuinely unnamed before this entry (zero hits each, the same
check SELF-653 used for `spend-caps.ts`).** Recorded here so the next fire
does not re-spend an hour re-confirming the same floor: this branch's
automated-sweep toolbox (coverage, jscpd, knip, citation-drift, every TS
strictness flag, now also "read the never-touched-by-git-log file list") is
genuinely exhausted at the `packages/web/lib`/`components` layer, not merely
unchecked recently.

That left `proxy.ts`'s own header campaign (SELF-648/650/652/653/654) as the
one still-open, still-safe thread — `@vitest/coverage-v8` can't reach it
either, since `proxy.ts` sits outside every tree `vitest.config.ts` collects
and is tested by calling `proxy()` directly. Re-read that file's own doc
comment for what it had explicitly left unresolved: SELF-648 named
`Permissions-Policy` as "the next thing considered" and dropped it for
`BuildWorkflow.tsx`'s `navigator.clipboard` button. Re-checking that reason
before reusing it found it had quietly grown a second edge since: `app/film/
page.tsx` and `DemoHome.tsx` both carry a `<video autoPlay muted
playsInline>` hero — a `Permissions-Policy` strict enough to be worth
shipping would need `autoplay=(self)` on top of `clipboard-write=(self)`, two
browser features to get exactly right rather than one, with no jsdom/RTL
harness and no way for this routine to load the page and see either one
silently break. Grepped first rather than assuming: `window.open`,
`postMessage`, `requestFullscreen`/`exitFullscreen`/`fullscreenElement`,
`getUserMedia`, `geolocation`, `PaymentRequest` and the rest of the
Permissions-Policy feature list all came back with zero hits outside that one
`clipboard`/`video` pair — confirming the risk is real but narrow, not that
it is safe to just add the two exceptions and ship it; getting a browser-
breaking header wrong in a repo this routine cannot visually verify is a
worse outcome than leaving a known gap named. Left `Permissions-Policy`
exactly where SELF-648 left it.

What is NOT the same shape is `Cross-Origin-Resource-Policy`: a single value
(`same-origin`) with no per-feature allowlist to get wrong, so there is
nothing for a silent breakage to hide behind the way there is with
`Permissions-Policy`'s multi-feature surface. It also answers a gap none of
the four existing headers do: `nosniff`'s own paragraph already establishes
why this app's responses are worth protecting — "every `/api/kb/*` response
is JSON built from text a swept SITE chose, not this app" — but `nosniff`
only governs how THIS origin's own browser interprets those bytes, never
which OTHER origin's page may load them as a subresource and read something
back through a side channel (timing, size, load/error). `same-origin` is
CORP's strictest value and the correct one for an app that is not a widget
and sends no CORS headers anywhere. Checked the one direction this could
break before adding it: CORP governs responses FROM this server, never
requests this server or its pages make outward, so `graphIcons.ts`/
`SiteIcon.tsx` fetching third-party favicons FROM swept sites is the opposite
direction and unaffected; grepped the whole of `packages/web` for
`window.open`, `postMessage` and `crossOrigin` (zero hits on all three, same
grep run for the `Permissions-Policy` check above) to confirm no popup or
iframe flow of this app's own depends on being loadable as a subresource
elsewhere.

Fixed in `packages/web/proxy.ts`'s `allow()` — the same single exit point
SELF-648/650/652/653/654 built and extended for the other four headers —
plus the 401 response's own header literal. Extended `proxy.test.ts`'s three
header-bearing assertions (open path, 401 refusal, successful auth) with a
`Cross-Origin-Resource-Policy` check each, mirroring SELF-654's own shape
exactly. Verified non-vacuous by mutation: stashed just `proxy.ts`, reran —
all three new assertions failed reading `null`; restored and reran clean
before staging.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
Installed `@vitest/coverage-v8@4.1.11` (matched to this repo's
`vitest@4.1.11`, the same version-matching rule SELF-509 used) for the
coverage pass above; reverted `package.json`/`pnpm-lock.yaml` to their
committed state before finishing — confirmed with `git diff --stat` showing
only `proxy.ts`/`proxy.test.ts` touched. `pnpm check && pnpm test` both exit
0: 3399 tests passing (up from 3398, one new), 13 skipped — same gated
census as SELF-655.

Backlog item: SELF-656

**SELF-657 (2026-10-05 overnight fire) — a basename cross-reference (the
SELF-566/599/604/613 method) over `packages/web/components/build` turned up
`ResultPanel.tsx` and `FindingsPanel.tsx` with two or fewer hits apiece, both
mentions passing rather than a dedicated read. Reading `ResultPanel.tsx` end
to end found the SAME stopped-vs-failed contradiction its own header comment
already describes fixing, still live one component over, in `BuildWorkflow.tsx`.**

`ResultPanel.tsx`'s own comment at its `stopped` prop names a real,
already-fixed bug: pressing Stop used to land in the same rose "failed" card
a crash does, so "the badge said the work was lost, the text said it was
kept." The fix there reads `stopped` (BuildWorkflow's own "a person pressed
the Stop button" boolean, set synchronously in the button's `onClick`) ahead
of `errorText`, so a deliberate stop gets its own neutral card and a crash
keeps the rose one.

`BuildWorkflow.tsx`'s status strip, rendered directly above `ResultPanel` in
the same tree off the same two values, never got that fix. Its headline and
blurb (then at lines 756-760 and 769-772) branched on `errorText` alone:

    : errorText ? "Stopped" : "Finished — opening the map"
    : errorText ? "Everything the run found before it stopped is kept." : …

`errorText` is set by `onResult`'s `case "error"` for ANY stream error frame
— not only a cancellation. `lib/runs.ts`'s `failRun` writes a real fault
sentence for a genuine crash or a spend-cap trip, and only substitutes the
literal `STOPPED` constant when `r.abort.signal.aborted && !isNamedFault(error)`
— deliberately NOT the same thing as the client's own `stopped` state, per
that function's own comment ("reading the signal alone would answer that
reader 'you stopped this' about a run they were watching and did not
touch"). So a run that crashed set `errorText` to that fault sentence,
`stopped` stayed `false`, and the strip read `errorText` truthy and printed
"Stopped — everything the run found before it stopped is kept" regardless —
while `ResultPanel`, a few lines below, read the same two values correctly
and rendered its rose "failed / the run did not finish" card for the
identical ending. One page, one run, two panels disagreeing about whether
anything went wrong — not a theoretical shape: `errorText` becoming truthy
without `stopped` is the ordinary path for a spend-cap trip or any model/
fetch failure the sweep throws, exercised by this repo's own
`spend-cap.test.ts`/`runs.test.ts` fixtures, not an edge case requiring a
live run to reach.

Fixed by extracting the branch into `endedStripText(stopped, errorText)` in
`components/build/types.ts` (the file `STAGE_LABELS`/`STAGE_BLURB` — the
strip's other half — already live in), reading `stopped` first the same way
`ResultPanel` does, with a new "Failed" / "The run did not finish." pair for
an error that was not a stop. `BuildWorkflow.tsx`'s two call sites now read
`endedStripText(stopped, errorText).label` / `.blurb`. No behaviour change
for the two cases that were already right (a clean finish, a real stop);
the only case that changed is the one that was wrong.

No jsdom/RTL harness exists in this repo to render `BuildWorkflow.tsx`
itself (the same limitation B1-B4 and SELF-613 already note for this
directory), so the fix is proven the way `isSpendDecision`/`mergeEntities`
already are in `BuildWorkflow.test.ts` — as a plain, directly tested
function. Added `endedStripText` tests to `types.test.ts` covering all four
inputs, including "stopped wins even when the error text has not arrived
yet" (the client sets `stopped` synchronously on click, before the server's
error frame or fallback fetch resolves). Verified non-vacuous by mutation:
temporarily reverted `endedStripText` to the original `errorText`-only
branch (dropping the `stopped` check entirely) and reran — the new "reads
'Failed', not 'Stopped', for an error nobody asked for" case failed exactly
as expected (`Stopped` where `Failed` was wanted); restored the fix and
reran clean before staging.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3403 tests passing (up from 3399,
four new), 13 skipped — same gated census as SELF-656.

Backlog item: SELF-657

**SELF-658 (2026-10-05 overnight fire) — a basename cross-reference over the
remaining single/double-digit-hit files in `packages/web` and `packages/swarm`
(error.tsx, global-error.tsx, SkipLink.tsx, CostBreakdown.tsx, PlanCard.tsx,
StageTracker.tsx, GraphSettings.tsx, lib/graph/labels.ts, scrollProgress.ts,
typingGuard.ts, FindingsPanel.tsx, ResultPanel.tsx, nodeTypes.ts,
icons/NodeGlyph.tsx, viz/BarMeter.tsx, viz/StatTile.tsx,
core/src/testing/fake-provider.ts, swarm/src/seed-families.ts,
swarm/src/serialize.ts) read every one end to end and found nothing — each
already carries the defensive guard, test, or doc comment its own shape
calls for (GraphSettings.test.ts already pins PRESETS against RANGES;
Sparkline/BarMeter/StatTile's `compact`/`Math.max(...xs, 1)` already guard
the empty/negative cases a bug would hide in; SkipLink's `tabIndex={-1}`
contract is already cross-checked by its own test).** Also re-ran
`madge --circular` against `packages/web` with its `tsconfig.json` alias
resolved (SELF-595's own invocation) — same single cycle, same place
(`lib/runs.ts > lib/public-runs.ts > lib/store/supabase.ts`), already traced
by SELF-595 to one `import type` edge erased before anything runs and left
as is (BLOCKED, not a bug) for the same reason: no second home exists for
`RunStatus`/`StoredRun` that is not itself a drive-by abstraction. And
`madge --circular` over `packages/core/src`, `packages/providers/src`,
`packages/sweep/src`, `packages/swarm/src` together: zero cycles, matching
every prior run of this tool on this branch.

This document's own "exhausted toolbox" entries (SELF-509/645/656) already
cover coverage, knip, jscpd and citation-drift; this fire's contribution is
confirming the one manual angle those don't reach — a fresh, dedicated read
of the specific files this branch's own low-touch-count method (SELF-566/
599/604/613/657) had not yet individually read — also comes back clean at
this point in the branch's life. Recorded so a future fire spends its first
cycle picking a different angle (a fresh file-by-file read of a package this
list has not named recently, or a re-run of a tool whose last result is now
many commits stale) rather than re-walking this same low-touch-count list.

No source change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`). `pnpm check && pnpm test` both exit 0: 3403 tests passing,
13 skipped — identical to SELF-657's own count (read-only fire).

Backlog item: SELF-658

**SELF-659 (2026-10-06 overnight fire) — re-ran the `process.env` vs.
`.env.example` cross-check SELF-509 ran once, 156 commits ago, and confirmed
it still holds after everything this branch has added an env var for since.**
SELF-509's own pass (D section, 2026-09-17) only grepped for `process.env.`
literals; it predates `OPENKB_LINK_CONCURRENCY` (P0-3), the basic-auth pair
`KB_USER`/`KB_PASSWORD`, the demo-mode pair `OPENKB_DEMO`/`OPENKB_DEMO_MAPS_DIR`,
`OPENKB_CLI_RUN_CAP_USD`/`OPENKB_BATCH_CAP_USD`, every `OPENKB_SWARM_*` dial,
and `OPENKB_TRACE` — none of which it could have checked. Re-ran both
directions rather than trusting the old result still covers the new surface.

Forward: grepped every `process.env.NAME` literal across `packages` and
`scripts`, then separately traced every dynamic `process.env[name]` site
(`spend-limits.ts`'s `LIMIT_VARS`, `spend-caps.ts`'s `CLI_LIMIT_VARS`,
`public-runs.ts`'s `RUNS_PER_DAY_VAR`, `fatal.ts`'s inline `"OPENKB_TRACE"`)
back to the literal string each constant actually holds — a bracket lookup
is invisible to a plain `process.env.` grep, and the four run-cap/visitor-limit
variables all live behind exactly this indirection. 53 distinct names fell
out (54 with `NODE_ENV`/`VERCEL`, both platform-level and out of scope for an
app `.env`). Every one of the 53 is declared in `.env.example`, live or
commented with a `# ` explanation (the four `?? "deepseek/..."` model dials
SELF-509 already named the reason for).

Reverse: extracted every `VAR=` and `# VAR=` line from `.env.example` (53,
matching) and grepped the source tree for each name — zero came back with no
reader, so nothing documented there is dead.

Re-checked the one apparent gap SELF-509 recorded and set aside —
`OPENKB_MAX_DURATION`, named only in a doc comment (`app/api/map/route.ts:58`)
— and it is still prose describing an approach that does NOT work
(`Number(process.env.OPENKB_MAX_DURATION ?? 300)` failing Next's "must be
statically analysable" route-segment-config check), not a variable anything
reads. Same conclusion, now confirmed against the current file rather than
inherited from a three-week-old read.

No gap in either direction. No code or doc change — recorded so the next
fire that reaches for this exact check (the two-directional env-var
cross-reference, as opposed to SELF-509's forward-only pass) knows it was
re-run against the full current surface, not just re-cited from memory.
`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3403 tests passing, 13 skipped — same
gated census as SELF-658 (unchanged — a read-only fire).

Backlog item: SELF-659

**SELF-660 (2026-10-06 overnight fire) — `proxy.ts` carried five response
headers (SELF-648/650/652/653/654) and had never set `Cross-Origin-Opener-Policy`,
the one header in that same family that closes a gap none of the other five
touch: a cross-origin page holding a live `window.opener` handle back into
this app.** `nosniff` governs how this origin's own bytes are interpreted;
`Cross-Origin-Resource-Policy` governs who may load this origin's response as
a subresource; neither says anything about a page that opened this app with
`window.open` keeping a synchronous handle on the resulting `window` object —
which lets that opener poke at `location` and time this app's navigations even
though CORP already stops it from reading the response bytes directly.
`Cross-Origin-Opener-Policy: same-origin` severs that handle by putting this
origin in its own browsing context group.

Checked it carries none of the failure modes this same file's history has
already rejected other headers over (`DENY` breaking `ScrollFilm.tsx`'s
same-origin iframe, `Permissions-Policy` breaking `BuildWorkflow.tsx`'s
`navigator.clipboard` button): re-grepped the whole of `packages/web` for
`window.open`, `window.opener` and `postMessage` — the exact same three
`Cross-Origin-Resource-Policy`'s own paragraph already checked before it was
added — and got zero hits on all three again. Nothing in this app opens a
popup, is designed to be opened as one, or depends on a live `opener` link
back to a parent window, which is the one legitimate use `same-origin-allow-
popups` (COOP's weaker option) exists for. `same-origin` is COOP's strictest
value, the same choice this file already made for CORP two headers earlier,
for the same reason: nothing here needs a popup relationship to survive.

Added it to `allow()` and the 401 response's own header literal, alongside
the five headers already there, same shape SELF-648/650/652/653/654 all used.
Extended `proxy.test.ts`'s three header-bearing assertions (open path, 401
refusal, successful auth) with a `Cross-Origin-Opener-Policy` check each.
Verified non-vacuous by mutation: stashed just `proxy.ts` (kept the test
changes) and reran — all three new assertions failed reading `null`; restored
the fix and reran clean before staging.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3404 tests passing (up from 3403, one
new), 13 skipped — same gated census as SELF-659.

Backlog item: SELF-660

**SELF-661 (2026-10-06 overnight fire) — audited this file's own `SELF-<n>`
sequence for the one thing nobody had checked: whether two concurrent fires
ever picked the same number.** The routine prompt names git log as "the only
shared state" between the three fires sharing this branch and warns to
"trust git, assume nothing" — but the number a fire stamps on its own entry
is chosen by reading this file, not by reading git, and two fires reading it
within the same ten-minute window can each see the same "highest number so
far" before either has pushed. Checked by diffing every `Backlog item:
SELF-<n>` commit trailer against every `**SELF-<n>` header currently in this
file (`git log a7bbc57..HEAD --format='%B' | grep -oE 'Backlog item:
SELF-[0-9]+'` vs. `grep -oE '^\*\*SELF-[0-9]+' docs/overnight-backlog.md`,
both deduplicated and counted): exactly one number, **653**, is claimed by
two commits and carries two headers in the live document — `fe63f82`
(`fix(web): X-Frame-Options...`, committed 2026-10-05 04:47:35 UTC) and
`461d6a6` (`fix(sweep,core): report.clock priced every run...`, committed
2026-10-05 04:57:51 UTC). `git merge-base --is-ancestor fe63f82 461d6a6`
confirms `461d6a6` was built directly on top of `fe63f82` — not a stale
branch that never saw the other's push — so this was not a rebase race that
git's own machinery could have caught: the fire behind `461d6a6` read a
tree that already contained `fe63f82`'s brand-new `**SELF-653` entry and
still wrote its own as `SELF-653` rather than `654`.

(Nine other commit-trailer numbers — 636, 593, 587, 584, 541, 519, 434, 386,
324 — also belong to two commits each, but every one of those is the
documented, intentional shape this branch already uses on purpose: a fix
commit followed by a `docs(overnight): record SELF-<n>'s own writeup` or
"...landed without updating this file" companion commit that adds the one
entry the fix forgot, reusing the SAME id for the SAME item rather than
colliding two different ones. `grep` confirms none of those nine numbers
has more than one `**SELF-<n>` header in the CURRENT file — three of the
nine (434, 386, 324) have none at all, predating this file's own history
and reachable only through git log. 653 is the only case where two
headers, for two unrelated fixes, both exist in the live document today.)

The collision had also corrupted the file's own ordering, not just its
numbering: `461d6a6`'s insertion anchored on text that ended one line short
of `fe63f82`'s predecessor entry's own trailer, so its new block landed
BETWEEN `SELF-652`'s body and `SELF-652`'s own `Backlog item: SELF-652`
line — confirmed against `61e8ed9`'s own diff (`git show 61e8ed9 -- docs/
overnight-backlog.md`), which proves that trailer was written immediately
after its body originally. The result, before this entry: `SELF-652`'s
body ran straight into `SELF-653`'s (report.clock) full text with no
trailer between them, and the orphaned `Backlog item: SELF-652` line
surfaced instead sandwiched between the TWO `SELF-653` entries, where
`grep -c "Backlog item: SELF-652"` found it as the file's only hit.
Restored `Backlog item: SELF-652` to directly follow its own body and
removed the stray duplicate from between the two `SELF-653` blocks — a
reordering, not a rewrite; no entry's prose changed.

Did NOT renumber either `SELF-653` entry. Both commits' own immutable
trailers say `SELF-653`, and `fe63f82`'s own entry already says "the same
single exit point SELF-648/652/653 built" (naming itself), so changing the
document's header out from under either commit's own words would make the
file disagree with its own git history instead of only with itself.
Tagged each header `[id collision, see SELF-661]` instead — a two-word
pointer a reader can follow without this file pretending the clash never
happened. Checked whether the collision cost the sequence a number: it did
not — `654` through `660` each still name exactly one entry (the same
`uniq -c` count above), so nothing after 653 needs to shift, and this
entry continues at the true next number, `661`.

No source change. `pnpm install --frozen-lockfile` first (fresh clone, no
`node_modules`). `pnpm check && pnpm test` both exit 0: 3404 tests passing,
13 skipped — identical to SELF-660's own count, as expected for a
docs-only fire.

Backlog item: SELF-661

**SELF-662 (2026-10-06 overnight fire) — re-ran SELF-509's coverage-gap
sweep itself, 153 commits later, and this time the branch's own growth
had opened a real gap: `tools-free.ts`'s `rememberTool` can misattribute
`settledBy` on a merge.** SELF-658 flagged that the next fire should pick
"a re-run of a tool whose last result is now many commits stale" rather
than re-walk the same file lists; `knip` and the `process.env`/`.env.example`
cross-check had both been re-run since (SELF-645, SELF-659), but
`@vitest/coverage-v8`, the one tool SELF-509 itself introduced, had not —
same install/revert procedure as SELF-509 (`pnpm add -D -w
@vitest/coverage-v8@4.1.11`, matched to this repo's now-current
`vitest@4.1.11`; `pnpm add` dropped the workspace's `@open-kb/*` symlinks
as a side effect — `Cannot find package '@open-kb/core'` on 145 of 231
files — fixed by a plain `pnpm install` before trusting any result;
reverted `package.json`/`pnpm-lock.yaml` and reinstalled before
finishing, same as SELF-509 promised).

`packages/core/src` 99.86% lines, `packages/swarm/src` 99.41%,
`packages/sweep/src` 97.73%, `packages/providers/src` 100% — all within a
point of SELF-509's own numbers, so this was never going to be a story of
wholesale new dead code. Dumped the full statement-level miss list from
the JSON reporter (the text reporter's own column truncates long lists
with `…`, which is almost certainly why SELF-509's write-up could only
name a handful per file) and cross-checked every miss's `git blame`
against `79685be`, this branch's own root commit: every single line in
`core`, `providers`, and all but a handful in `swarm`/`sweep` predates
every fire this branch has ever run — the same structurally-dead
branches SELF-509 already traced, just enumerated more completely this
time, not new.

Read the handful that did NOT predate the root commit end to end anyway,
since "old" is not the same claim as "already read for THIS reason".
`tools-free.ts`'s `rememberTool` merge path (`tools-paid.ts`'s harvest
writes `settledBy` on nodes the way the lead's own `remember` schema never
can, per this same file's `RememberNodeInput` doc comment) stamped
`existing.settledBy = n.settledBy` unconditionally on every stronger-tier
merge, OUTSIDE the `!downgradeIntoSupported` guard that gates every one of
its sibling receipt fields (`because`, `unreadableReason`, `reasoning`,
`relationSpan`) — and with no `else delete`, unlike all four of them. The
line's own comment ("The judging stamp follows the account that owns the
scalar fields") states the exact rule `reasoning`/`relationSpan` already
enforce three lines later; the code just did not apply it to this field.
Two concrete failures from that gap, both reachable from ordinary mixed
harvest/lead traffic on one host: (1) a stronger PLAIN lead claim (no
`settledBy` — the model-facing schema never offers it) overtaking a
harvested node left the old `settledBy` stamp in place, so a node whose
winning kind/relation a lead wrote outright still claimed to have been
"settled by predicate/model"; (2) a stronger harvested claim that LOST the
scalar fields to `downgradeIntoSupported` (its own verdict reads
`unknown`, the standing claim is supported and holds) still overwrote
`settledBy` from the losing account onto the claim it failed to displace —
attributing a judging decision to an account that never made it.
`settledBy` round-trips into the run's exported `entities()` (`map.ts:247`)
and the web UI's `NoteView.tsx`, so this was a real, user-visible
provenance error, not an in-memory-only one.

Fixed by moving the `settledBy` assignment inside the `!downgradeIntoSupported`
block, alongside `reasoning`/`relationSpan` (same receipt-follows-owner
rule, same comment), and adding the missing `else delete existing.settledBy`
so a stronger claim with no stamp clears the stale one exactly the way its
three siblings already do. Added two tests to
`packages/swarm/tests/tools-free.test.ts`, one per failure: a stronger
plain claim clearing a harvested `settledBy`, and a stronger-but-downgraded
harvested claim failing to stamp `settledBy` onto the supported claim it
could not displace. Verified non-vacuous by mutation: stashed just the
`tools-free.ts` change (kept the test file) and reran — both new tests
failed with `"model"` where `undefined` was expected, exactly the two
failure modes above; restored the fix and reran clean before staging.

`pnpm install` first (the symlink casualty above, not a frozen-lockfile
concern — `package.json`/`pnpm-lock.yaml` carry no diff). `pnpm check &&
pnpm test` both exit 0: 3406 tests passing (up from 3404, two new), 13
skipped — same gated census as SELF-661.

Backlog item: SELF-662

**SELF-663 (2026-10-06 overnight fire) — two genuinely new angles: the five
`packages/web/app/api/kb/**` and `.../api/run/[id]/cancel` route handlers
this document had never once named, plus extending SELF-647's timer/
listener-cleanup audit (scoped to `packages/web` by its own title) to every
`setTimeout` in the engine packages and `scripts/`. Both came back clean.**

A basename check against this file (SELF-658's own method) turned up five
route handlers with zero prior mentions anywhere in this document, unlike
every one of their siblings: `api/kb/[id]/route.ts`, `.../graph/route.ts`,
`.../note/route.ts`, `api/kb/route.ts`, `api/run/[id]/cancel/route.ts`. Read
each end to end. All five are already narrow, already guarded by `guarded()`
(`lib/api-error.ts`), and already carry the defensive comment their own
shape calls for — `note/route.ts`'s doc comment states outright that `?path=`
never touches the filesystem, confirmed by reading `noteOf` (`lib/kb-from-
run.ts`) rather than taking the comment on faith: it is a plain lookup into
the run's own in-memory entity list, no `fs` call anywhere in the chain.
`api/kb/route.ts`'s one-line `isCompleted` filter matches the identical
filter `/kb`'s own page route uses, confirmed by reading both. Also read
`lib/zip.ts` (the hand-rolled store-only zip writer behind `api/kb/[id]/
export/route.ts`, itself already covered) and `lib/graphIcons.ts` — both
basenames absent from this document too. `zip.ts`'s local/central-directory/
EOCD field layouts check out field-by-field against the ZIP spec, and
`zip.test.ts` already round-trips every entry through a from-scratch reader
(central directory → offset → local header → data), not just asserting
fixed-offset signatures, so there is no gap here for a fresh read to close.
`graphIcons.ts`'s `IconCache` already documents, in its own header comment,
the exact tradeoff (`drawImage`-ing a cross-origin favicon taints the canvas,
so a PNG export is impossible — "do not add an export button") that this
fire went looking for as a candidate bug before finding it already written
down at the one call site (`GraphCanvas.tsx:1624-1626`).

Also read `lib/graph/search.ts`, `components/kb/layerMeta.tsx`, `app/
layout.tsx`, `app/page.tsx` and `app/kb/page.tsx` end to end — each already
carries a prior fire's full branch-by-branch trace in this document (SELF-
560 for the three route shells and `layerMeta.tsx`'s accessors; the `app/
layout.tsx` `viewport.colorScheme` comment documents its own production
measurement) even though the basename search that shortlists candidates
missed them, the same false-negative SELF-561 already named for this
method. Confirmed each still reads as those entries describe; no drift.

Second angle: SELF-647 audited every `addEventListener`/timer subscription
in `packages/web` for a missing cleanup or stale-response race and said so
in its own title — it never claimed the engine packages. Grepped
`setTimeout`/`setInterval` across `packages/{core,providers,sweep,swarm}/
src` and `scripts/` (14 non-test call sites). Eleven are plain `await new
Promise(r => setTimeout(r, ms))` backoff/idle sleeps with nothing to cancel
(`brightdata.ts:170,511`, `sweep.ts:2748,4260`). The other three are real
deadline timers racing a real operation and all three already clear
correctly: `agent.ts:1069`'s abort timer is cleared in `runInvestigator`'s
own `finally` (:1187) alongside the `AbortSignal` listener it chains to
(:1188); `orchestrator.ts:1314-1319`'s per-iteration wake timer is cleared
the line after its `Promise.race` resolves (:1324); `tools-paid.ts:446-450`'s
per-fetch deadline timer is cleared the line after its own race (:453) —
this exact chain (`attempt`/`landing`) already has its own SELF-607 entry
tracing why `landing`'s `.then` can never reject, so only the timer's own
cleanup was this fire's open question, and it is closed. `scripts/batch.ts`'s
two timers (:439, :514) are a CLI subprocess watchdog, cleared via a
`settled`-guarded `finish()` that both can reach; the second is an
unguarded one-shot but 500ms in a CLI process that exits when idle, not the
leak shape either sweep was looking for. No open timer anywhere in the
engine side of this codebase.

No code change — every file and call site checked was already correct.
`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3406 tests passing, 13 skipped —
identical to SELF-662's own count, as expected for a read-only fire.

Backlog item: SELF-663 - BLOCKED

**SELF-664 (2026-10-06 overnight fire) — the settledBy/reasoning/relationSpan
receipt-follows-owner rule SELF-662 just enforced on the stronger-merge
branch had a sibling gap in `tools-free.ts`'s OTHER kind/relation-rewriting
seam: recovery.** `rememberTool`'s merge has two places that change which
account owns a node's `kind`/`relation`: the `incomingStronger` branch
(line ~704, SELF-662's own target) and, in its `else`, the recovery branch
(line ~760) — "an unknown never outranks a supported claim: if the standing
relation was the downgrade and this account was admitted, the node
recovers." Read the recovery branch end to end on the same question SELF-662
asked of its sibling: recovery reassigns `existing.relation`/`existing.kind`
and deletes `existing.because`/`existing.unreadableReason`, but never
touched `settledBy`, `reasoning` or `relationSpan` at all — the exact three
fields the stronger-merge branch now guards, left untouched one branch over.

Confirmed this is reachable, not merely structurally symmetric: `tier` is
computed from evidence provenance alone (`tierOf`, own-page/page/snippet),
independent of which tool wrote the claim, and `settledBy` is independent of
tier too — "the judge-kernel passthrough… a claim may ARRIVE already
standing down… the harvest path lands unreadable hosts this way" (this
file's own `selfDowngraded` comment). So a harvest call can perfectly well
downgrade a host to unknown at `page` tier carrying `settledBy: "model"`,
and a LATER, non-stronger claim (snippet tier, or an equal-tier harvest call
with its own settledBy) can recover it through the `else` branch, not the
`incomingStronger` one SELF-662 fixed. Two concrete failures, mirroring
SELF-662's own two: (1) a plain lead claim (no settledBy slot in its
model-facing schema) recovering an unknown node left the prior harvest
call's stale `"model"`/`"predicate"` stamp in place, now describing a
relation the lead account set directly, never judged by predicate or model
arithmetic; (2) a weaker-or-equal-tier harvest claim recovering the SAME
node brought its own fresh settledBy/reasoning/relationSpan that were
silently discarded, leaving the FIRST call's receipts attributed to a
kind/relation the second call actually determined. Same `settledBy`
round-trip into `entities()`/`NoteView.tsx` SELF-662 already traced, so this
is the same class of user-visible provenance error, just the other door into
it.

Fixed by adding the identical three-field block (`settledBy`/`reasoning`/
`relationSpan`, same `if (n.X) existing.X = n.X; else delete existing.X`
shape) inside the recovery branch's existing `if`, right after the
`because`/`unreadableReason` handling already there. Added two tests to
`packages/swarm/tests/tools-free.test.ts`: a plain-lead recovery clearing a
harvested `settledBy`, and a harvest recovery overwriting one stamp with
another rather than leaving the first. Both use the existing "Pair 1" fixture
shape (`downgradedStronger`/`supportedWeaker` from the commutativity test
above) with `settledBy` added, since that pair already proves it lands in
the recovery branch specifically (weaker tier, non-stronger incoming) rather
than the `incomingStronger`/`downgradeIntoSupported` branch SELF-662 covers.
Verified non-vacuous by mutation: stashed just the `tools-free.ts` change
(kept the test file) and reran — both new tests failed, `"model"` surviving
where `undefined`/`"predicate"` was expected, exactly the two failure modes
above; restored the fix and reran clean before staging.

`pnpm install --frozen-lockfile` first (fresh clone, no `node_modules`).
`pnpm check && pnpm test` both exit 0: 3408 tests passing (up from 3406, two
new), 13 skipped — same gated census as SELF-662/663.

Backlog item: SELF-664

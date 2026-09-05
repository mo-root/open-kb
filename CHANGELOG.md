# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); this file is
maintained by hand from `git log`, not generated.

## [Unreleased] — hardening/overnight-2026-08-21 (2026-08-20 – 2026-09-05)

Several nights of hardening on top of `main`, driven by measured evidence from
real sweep runs rather than guesses. Grouped by what a user of the CLI, the
hosted web app, or the repo itself would actually notice.

### Pipeline defaults and performance

- **Triage, second-look, and listicle-harvest are now on by default**, in
  both `pnpm sweep` and the web app's `/api/map` route. Each shipped as an
  opt-in flag with an explicit "prove it before it defaults on" doc comment;
  all three now have measured A/B evidence they help (listicle-harvest found
  six rivals with zero direct search hits on a real run; second-look
  rescued roughly half of unplaced hosts across two runs; triage skipped
  123 of 926 hosts on one run at no real cost). `drop-confirm` stays
  opt-in — its own A/B rescued close to nothing. The env vars flip from
  enable- to disable-semantics (`OPENKB_TRIAGE=0` still turns a stage off);
  a fresh clone and the hosted demo now run the same pipeline.
- **The link phase — the single largest share of run time (43% on a
  measured run) — no longer stalls on its slowest batch.** Both link
  dispatch sites (paired-host batches and orphan batches) switched from
  chunk-then-barrier dispatch to a continuous worker pool, the same fix
  already applied to the search phase. Concurrency and batch sizes are
  unchanged — only the scheduling shape.
- **Link concurrency is now configurable** via `OPENKB_LINK_CONCURRENCY`
  (default raised from a hardcoded 8 to 16), matching the pattern already
  used by `OPENKB_RANK_CONCURRENCY`.
- **Link and orphan model calls carry a shorter timeout** (`OPENKB_LINK_CALL_TIMEOUT_MS`,
  default 60s vs. the global 120s) — two timed-out batches cost about four
  of the link phase's 12.3 minutes on a measured run; every other agent call
  keeps the original 120s ceiling.
- **`--quick`**, a new CLI flag on `scripts/sweep.ts`, trades a bounded first
  run (capped host count, no paid link pass) for a fast first look — a real
  first run was measured at ~28 minutes before a user sees anything. Prints
  what it traded away and how to run the full sweep.
- Search-phase pacing now narrows proactively on a sagging SERP success
  rate, instead of only reacting after the provider's own throttle message
  arrives — about 1 in 5 SERP requests across stored runs were retries the
  old reactive-only path did nothing about until an account-wide threshold
  had already been crossed.
- `assess` now varies page depth per product instead of a flat page count,
  deepening only the products whose second page kept turning up new hosts.
- `second-look` can now unlock one retry against a walled page for hosts
  that already earned their place twice over, instead of failing open on
  the first refusal.
- The free harvest pass (listicle-harvest) surfaces vendor names a roundup
  page mentioned but the search phase never issued a query for — this is
  how rivals with zero direct SERP hits (e.g. Windsurf on a cursor.com run)
  make it onto the map at all.

### Run economics and diagnostics

- **`OPENKB_DEADLINE_S`**, a CLI flag that reproduces the web route's
  clock-constrained run shape from a terminal — every run on disk before this
  carried `report.budget: null`, so the deadline-derived query budget
  (`queriesThatFit`) and its consequences were untestable without a real
  deployment.
- **`report.clock`** now records what the cost model predicted for a run
  (`predictedSeconds`, priced on the queries actually fired) beside what it
  took (`actualSeconds`) — the model was found to be 1.5-2x conservative by
  hand-checking three runs, and this makes that check automatic on every one.
- **A run doctor** (`scripts/run-doctor.ts`) reads a run file and flags
  whatever looks abnormal against a measured threshold for each of the
  report's thirty-odd fields, and now runs itself at the end of every sweep —
  a clean run stays quiet, a gap or a watch prints under the map.
- **The snippet-judged share** — the fraction of a map's hosts judged from a
  search-result snippet rather than a real read, previously measured once by
  hand — is now recomputed on every run instead of staying a stale one-off
  number.
- Search and judge can now overlap: judging starts once a host's evidence has
  arrived rather than waiting for the whole search phase to drain, which on
  a measured run reclaimed part of the 337 seconds rank spent doing nothing
  while the last SERP calls landed.
- The KB health section's answer-key overlap number is now shown beside the
  probe-page count it was found to move with (0.05 average under five
  probes vs. 0.20 above), instead of standing alone as if it were only a
  function of the anchor.

### Map quality

- Classify replaced its binary "does this belong" gate with a placement
  ladder: `none` now costs as much evidence as any other verdict, and a new
  `adjacent` relation captures real-but-not-substitutable businesses (a
  backup vendor, a support platform) that an audit found were being forced
  into `competitor` roughly a quarter of the time.
- Every classify verdict now carries a one-sentence `reasoning` (the
  decisive fact behind the call) and a `relationSpan` receipt for the
  relation itself, alongside the existing description and spans.
- The anchor domain can no longer be classified as its own competitor, and
  the "wrong door" withdrawal (a model naming a brand hosted on someone
  else's subdomain) was corrected against five measured false positives
  while keeping its original true positive.
- Edge `why` text is grounded in mechanism rather than bare discovery where
  the retrieved page actually supports one, on both the free naming pass
  and the paid inferred (link) pass — a naming-only page still says exactly
  that and nothing more.
- The free naming pass now considers every row on a host that named a
  target, not just the first one encountered, picking the richest
  candidate instead of whatever happened to sort first.
- `reasoning`'s low fill rate was traced to schema field order contradicting
  the prompt's own documented answer order; moved to match, so the model
  states its decisive fact before spending its output budget elsewhere.

### Web app

- Entity detail cards now surface `reasoning` (the decisive fact behind a
  classification) where present.
- Relation cards now surface `relationSpan` as a receipt on the relation
  itself, and mark ungrounded spans honestly rather than hiding them.
- `adjacent` — often the single largest relation on a modern map — is now a
  first-class citizen everywhere the web app enumerates relations: colour,
  order, and group copy in the "who's in this market" and ecosystem panels.
- A run that completes with zero entities no longer falls through into a
  bare one-node force graph; it now shows the same "nothing on the map"
  empty state used elsewhere in the app.
- `KbOverview` no longer treats a non-JSON error response as "unreachable".
- Five hand-copied palettes that key off `JUDGED_KINDS`/`JUDGED_RELATIONS`/
  `QueryFamily` were each found one or more members short of the real union
  — the missing member always fell through to a generic fallback colour
  rather than erroring, so it read as unclassified or as a different kind
  entirely. Fixed: `viewTypes.ts`'s `FAMILY_TONE` (missing `rival` — every
  rival-family query chip rendered in the same muted gray as an unrecorded
  family), `ResultPanel.tsx`'s `KIND_COLOR` and `ui.tsx`'s `KIND_TONES`
  (both missing `unknown`, indistinguishable from a `directory` entity),
  and `KbOverview.tsx`'s `RELATION_ORDER`/`RELATION_COLOR` (missing
  `lists`, `covers`, `discusses` and `unknown`). Each now carries a test
  pinning it against the real union so a new member fails loudly instead
  of landing in the fallback.

### Bug fixes

- The Next.js error boundary (`app/error.tsx`) crashed instead of rendering
  when the thrown error's `message` was not a string — the one failure a
  boundary must never have.
- The report's rival channel was counting queries the listicle channel fired
  as its own, inflating the rival channel's own query-efficiency numbers.
- A run's spent ceiling could stop the listicle harvest while it was still
  reading names off a page, discarding output it had already paid for
  instead of keeping what was read before the cap landed.
- Nine call sites across eight scripts that read `runs/` (`read.ts`,
  `bench.ts`, `run-doctor.ts`, `calibrate-kernel.ts`, `query-yield.ts`,
  `recall.ts` twice, `corroboration-arrival.ts`, and `export-kb.ts --all`,
  the last found in a follow-up pass) crashed with a raw `ENOENT` stack
  instead of the "nothing to read yet" message each was already written to
  print, when the gitignored directory does not exist at all — as it does
  not on a fresh clone.
- `bench`'s summary printed `"$undefined"` and `"undefinedx"` on an empty
  population, threw a `RangeError` on its provenance footer with zero runs,
  and printed `$Infinity` in a repeatability footnote — all on the empty or
  single-run inputs a first-time user is most likely to hit.
- `run-doctor` cited a range computed over seven of its eight runs while
  flagging the run that defines the range's own ceiling, and its own test
  had no gate, so it could fail silently.
- `package.json` had no `packageManager` field, an item C3 named as open and
  never closed.
- The web app's deadline watchdog (`withDeadline`, the ceiling that stops a
  run at the deployment's own `maxDuration`) reported an unbranded `Error`
  instead of a `NamedFault`, so a run the app itself stopped on schedule
  rendered the generic "the server could not handle this request" message —
  the exact ref-only fallback its sibling, the spend-cap watchdog, already
  had a dedicated `runCostCeiling` fault to avoid. Given its own
  `namedFaults.runDeadline` entry with the same three things a reader needs:
  not broken, kept, and the uncapped alternative.
- `run-doctor`'s second-look check vanished from the report entirely — not
  `ok`, not `unknown`, not `gap`, just missing — whenever second-look ran
  and placed everyone on the first pass (`sl.asked === 0`), the one shape
  its `if (sl === null) … else if (!sl) … else if (sl.asked) …` chain never
  matched. Worse than the misread-zero bug this file exists to catch, since
  even a wrong level would have been visible. Now reports `ok` with "0
  asked — every host placed on the first pass", matching how the
  `triage`/`listicleHarvest` blocks already treat "ran, found nothing to
  do" as a clean result.
- `run-doctor`'s triage-skip check hit the same 0/0 trap from the other
  side: a run whose search returned no candidate hosts at all (`t.hosts
  === 0`) computed `t.skipped / t.hosts` as `NaN` and printed the literal
  text "0/0 (NaN%) in 0 calls" instead of the "nothing found to triage"
  the case actually means. Now reports `ok` with "0/0 hosts — nothing
  found to triage", the same fix shape as the second-look gap above.

### Repo and docs

- Added `CONTRIBUTING.md` (workspace layout, the `pnpm check && pnpm test`
  gate, why the fixture suite is offline-only, core-purity rules).
- Added `SECURITY.md` and GitHub issue/PR templates.
- Added a License and Node-version badge to the README (no CI badge —
  `check.yml` has never run on GitHub), plus `homepage`/`bugs` fields in
  `package.json`.
- Various doc corrections: the README/ARCHITECTURE doctrine tables now
  list the classify-v2 fleet and the `07` stage; a stale relation count in
  a `RELATIONS` comment was corrected.
- `docs/overnight-backlog.md` — this branch's own internal fire-log — was
  untracked from git (it was force-added past the repo's own `.gitignore`
  rule that `docs/` is an internal engineering record); the six code
  comments that pointed at it for an item number now state their finding
  inline instead.
- `.env.example` was missing five dials this branch added and carried one
  stale default; the onboarding skill doc claimed all four pipeline stages
  default off when three of them now default on.
- `prompts/doctrine/07-query-families.md` — the doctrine the `catalog` and
  `assess` agents are taught query families from — named three of
  `QueryFamily`'s four members, silently dropping `rival`; the `prompts/
  README.md` doctrine index carried the identical gap. Both corrected, with
  a test pinning the doctrine's list against the real union.

### Also in this range

Assorted correctness and test-coverage fixes with no user-visible behavior
change worth calling out individually: a fixed relation-schema mismatch
between `remember`'s edge schema and the investigator prompt, a `discover()`
call that computed whether the agent finished and then discarded it, a
case-sensitivity bug in `nodeKey`'s scheme stripping, an overpromising
harvest tool description, a `read` script that opened its newest-run match
twice, a dead `HUB_DEGREE_FRAC` constant in `GraphCanvas.tsx` left behind by
an earlier fix that replaced its formula with `isHubDegree` but never
removed the superseded declaration, and new direct tests for
`anchorIdentityTheft`, the breaker's word-list fallback past six strikes,
and `fatal()`'s provider-message classifier.

A long tail of further self-discovered work followed the same pattern: one
concrete gap or fix per commit, each tagged `Backlog item: SELF-<n>` in its
own message rather than listed here. The great majority are direct test
coverage for a script, web component, or core function that had none —
`git log --grep 'zero test coverage'` on this branch finds them — with a
handful more of the same shape as the fixes above (a display bug on an
empty or single-run input, a stale figure in a doc comment). None changed
what the product does; they are why `pnpm check && pnpm test` staying green
on this branch means what it says.

# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); this file is
maintained by hand from `git log`, not generated.

## [Unreleased] — hardening/overnight-2026-08-21 (2026-08-21 – 2026-08-23)

Three nights of hardening on top of `main`, driven by measured evidence from
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

### Also in this range

Assorted correctness and test-coverage fixes with no user-visible behavior
change worth calling out individually: a fixed relation-schema mismatch
between `remember`'s edge schema and the investigator prompt, a `discover()`
call that computed whether the agent finished and then discarded it, a
case-sensitivity bug in `nodeKey`'s scheme stripping, an overpromising
harvest tool description, a `read` script that opened its newest-run match
twice, and new direct tests for `anchorIdentityTheft`, the breaker's
word-list fallback past six strikes, and `fatal()`'s provider-message
classifier.

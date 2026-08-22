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

- [ ] **P1-8. Free-settle is effectively off: 2 hosts of 926 settled by
  predicate.** `KERNEL_THRESHOLD = opts.aggregatorThreshold ?? null` (~line
  3877) ships null because `scripts/calibrate-kernel.ts` found no separation
  between vendor and directory front pages on the sample it had. Every other
  host pays a model call. Re-run that calibration reasoning over the runs now on
  disk (there are 17 sweeps, several far larger than when it was last tried) and
  report honestly whether a defensible threshold now exists. If it does, propose
  it with the measurement; **if it does not, say so and mark this BLOCKED** —
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

- [ ] **B1. `reasoning` is surfaced NOWHERE in the UI.** It is the one-sentence
  "why this call was made" on every classified entity, and 26% of entities
  carry one. Surface it on the entity detail card
  (`packages/web/components/kb/NoteView.tsx` and/or the GraphCanvas detail
  panel) — read how `what`/`why`/`spans` already render and follow that shape.
  Optional on the type, so absent renders as nothing, never an empty row.

- [ ] **B2. `relationSpan` and `relationGrounded` are surfaced NOWHERE.**
  `relationSpan` is the verbatim quote backing the RELATION, as `spans` backs
  the description; `relationGrounded` records whether it verified as a literal
  substring (85% present, 83% of those verified on the cursor run). Surface the
  quote as a receipt on the relation and mark ungrounded ones honestly rather
  than hiding them — receipts-on-everything is the whole pitch.

- [ ] **B3. Confirm `adjacent` is handled everywhere the UI enumerates
  relations** — colours, legend, glyphs, filters, sort orders, group labels. It
  has a blurb (`viewTypes.ts:39`) and a weight (`kb-from-run.ts:98`) but may be
  missing elsewhere. On a modern map it is the largest single relation, so an
  unhandled case is very visible.

- [ ] **B4. Audit error and empty states end to end**: a failed run, a map with
  zero entities, a missing run id, a non-JSON fetch response, a one-node graph.
  Precedent: a prior fire found `KbOverview` swallowing a non-JSON error body
  as "unreachable".

## C. GitHub — the repo a stranger lands on

- [ ] **C1. CONTRIBUTING.md** — none exists. Cover the pnpm workspace layout,
  `pnpm check && pnpm test` as the gate, prompts-as-markdown-without-rebuild,
  the core-purity rule enforced by `scripts/check-core-purity.mjs`, and that
  runs cost real money so tests are offline by design.

- [ ] **C2. SECURITY.md plus issue and PR templates** under `.github/`. The
  project takes API keys and fetches arbitrary web pages: say how to report a
  vulnerability and that keys live only in `.env`. Bug template should ask for
  the run artifact and anchor domain. Keep them short.

- [ ] **C3. README badge row and repo metadata.** `.github/workflows/check.yml`
  has NEVER RUN — origin/main is a squashed v0.1.0 ~215 commits behind. Do NOT
  claim CI is green. Do correct or remove any badge that would render broken or
  false on a public repo.

- [ ] **C4. CHANGELOG.md / release notes** for what this branch changed since
  main. Read `git log a7bbc57..HEAD` for the real list rather than trusting any
  summary. Group by what a user would notice.

## D. Deep architecture work

Only once A, B and C are done or BLOCKED. Areas nobody has swept: `core/src/
ledger.ts` and `spend-cap.ts`; `core/src/export-kb.ts` (the folder users
actually read); `scripts/*.ts` beyond sweep.ts; `web/lib/store/supabase.ts`;
the swarm orchestrator; doctrine contradictions; coverage gaps. Tag
`Backlog item: SELF-<n>`, continuing from wherever git log leaves off.

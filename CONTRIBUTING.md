# Contributing

## Layout

A pnpm workspace, five packages plus the CLI scripts that drive them:

| Package | Job | Depends on |
|---|---|---|
| `packages/core` | Evidence store, ports, tools, judge, ledger, breaker, scorecard. No network, no keys, no vendor names. | `ai`, `zod` |
| `packages/providers` | The only place vendor HTTP lives — Bright Data, OpenRouter. Credentials are a parameter. | core |
| `packages/sweep` | The breadth engine and its rank kernel, one file. | core, providers |
| `packages/swarm` | The depth engine: a lead, a funded board, six lanes. | core |
| `packages/web` | Next.js app — start a run, stream spans, browse the map. | core, providers, sweep |

`scripts/*.ts` are the CLI entry points (`sweep`, `swarm`, `export`, `diff`,
`audit`, …), thin wrappers that call into the packages above. `prompts/` and
`skills/` sit outside the workspace; see below and
[`prompts/README.md`](./prompts/README.md).

```bash
git clone https://github.com/mo-root/open-kb.git && cd open-kb && pnpm install
pnpm check && pnpm test
```

Both pass on a clean clone with no `.env` and no keys — that is deliberate,
read on.

## The gate: `pnpm check && pnpm test`

Everything you change has to clear both before it lands. Nothing here needs a
real Bright Data or OpenRouter account.

`pnpm check` runs, in order: `check-core-purity.mjs` (below),
`check-test-collection.mjs` (fails if a test file on disk isn't in the set
`vitest list` would actually run — this repo has shipped a test file sitting
outside `include` before, green over untested code), `check-skips.mjs` (fails
if a suite goes dark — every test in a file skipped — without a declared
reason), then `tsc -b` across the workspace plus each package's own
`tsconfig.tests.json`. Each of these is a guard file worth reading before you
touch it; they say why they exist in their own header comments.

`pnpm test` runs the vitest suite: 1,820 tests, offline, no network, no keys,
under a minute. `tests/live/*.live.test.ts` is the exception —
`describe.skipIf(!process.env.OPENKB_LIVE)`, real credentials, real HTTP,
skipped by default and skipped in CI. **Never make an offline test depend on
`OPENKB_LIVE`, and never add a fixture test that reaches the network.** A
sweep or swarm run costs real money — the README's bake-off numbers are
$0.0003–$0.71 per call depending on the agent — so the whole point of the
fixture suite is that anyone can run it for free, as many times as they want,
with nothing in their environment.

If you're adding an engine change that genuinely needs a live call to prove
(a new provider parameter, a real rate-limit response), write it as a
`tests/live/*.live.test.ts` file gated the same way the existing ones are, and
say in the PR that it needs `OPENKB_LIVE=1` plus real keys to run — don't
wire it into the default suite.

## Core purity

`packages/core` is pure judgement — no network, no DOM, no vendor names, no
`process.env`. `scripts/check-core-purity.mjs` enforces this by scanning
`packages/core/src` on every `pnpm check` for four patterns: `process.env`
(credentials are a parameter, not read from the environment inside core),
`document`/`window` (a DOM API in a headless engine), the literal names
`brightdata`/`openrouter`/`gemini` (a vendor name in core), and `fetch(...)` /
raw HTTP framing (core declares a `SearchPort`/`FetchPort`, a provider
implements it — see [`ARCHITECTURE.md`](./ARCHITECTURE.md)).

The scan root is not configurable by design — read the comment at the top of
the file before changing its shape. If you need core to do something that
looks like it needs one of the four forbidden things, the fix is almost
always a new port method on `packages/core/src/ports.ts`, implemented in
`packages/providers`, not an exception carved into the scanner.

## Prompts are markdown, not code

Every agent's judgement lives in [`prompts/`](./prompts) as markdown, loaded
from disk at runtime. Changing how an agent reasons is a text edit to a
`.md` file, not a TypeScript change — no rebuild, no redeploy. Read
[`prompts/README.md`](./prompts/README.md) before touching a prompt: it
covers the doctrine/agent split, the composition order, the house style
(every rule states the failure that motivated it, real numbers from real
runs, no numbered ladders), and the size ceiling `packages/core/tests/
prompts.test.ts` enforces.

## Style

- Match what's already there before introducing a new pattern. This
  codebase's comments explain *why*, citing the measured fact or the bug that
  motivated the line — not *what*, which the code already says.
- Minimal, surgical diffs. No drive-by refactors bundled into a fix.
- If you touch a number in a comment or `.env.example`, verify it yourself
  against a real run or the fixture that backs it — don't carry one forward
  unchecked.

## Before opening a PR

```bash
pnpm check && pnpm test
```

Both must exit 0 with zero failures and zero new skips. If you added a stage,
flag, or agent, update `.env.example` and the README's stage table so a
reader of either finds the same behaviour the code ships.

/**
 * Sweep: the shape the map actually wants.
 *
 *   1. read the company, free fetch, one model call -> what it sells
 *   2. write the catalog, one model call -> N queries, generated before any company
 *                                name is known, so a look-up query is impossible to write
 *   3. fire everything at once, parallel, cheap
 *   4. judge every host from its own front page, predicates first, a model
 *                                call only on the residue, one host at a time
 *
 * This is the library form of what `scripts/sweep.ts` used to be inline. It is
 * the same code the CLI and the web route run, the script is now a thin
 * argv-and-console wrapper, so a fix made for the browser is a fix the script
 * gets, and there is no second copy of the pipeline to drift.
 *
 * Everything it does is emitted onto a `SpanStream` as it happens rather than
 * only printed at the end: a phase boundary, one span per SERP call carrying
 * the real query text, one per model call carrying its token counts. Nothing
 * reads the stream in the CLI (`onLog` prints instead), and the browser reads
 * nothing else.
 */
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import {
  sniff,
  condense,
  isHtml,
  candidatesFromSitemap,
  candidatesFromLinks,
  isSitemapIndex,
  sitemapChildren,
  rivalsFromSitemap,
  discover,
  readPageFacts,
  renderPageFacts,
  dedupeFacts,
  openingHand,
  companyHand,
  rivalHand,
  banned,
  MEASURED_PHASE_COSTS,
  rankSeconds,
  answerKeyRecall,
  anchorAliasSet,
  registrableHost,
  anchorIdentityTheft,
  capReceipts,
  checkQuote,
  descriptionGrounding,
  wrongDoorName,
  type FetchPort,
  type ModelPricing,
  type PageFacts,
  type RivalLead,
  type SearchPort,
  type SearchResult,
  type SpanStream,
  type FamilyQuery,
  type QueryFamily,
  type UnreadableReason,
} from "@open-kb/core";
// Re-exported because `SweepOptions.pricing` is typed with it, and a package
// whose options name a type nobody can import from that package is a package
// you cannot write a caller for. It moved to core when the price table was
// consolidated into @open-kb/providers, and this keeps @open-kb/sweep's public
// surface what it was. Same move packages/swarm/src/agent.ts:126 already makes.
export type { ModelPricing };
import {
  brightDataSearch,
  brightDataFetch,
  priceForModel,
  type BrightDataCredentials,
} from "@open-kb/providers";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composePrompt, render } from "@open-kb/core";
import { judgeHosts, type HostCandidate, type Judged } from "./rank.js";
import { heldDeadline } from "./deadline.js";

/** The walk itself: from `start`, upwards, for a directory holding
 *  `prompts/doctrine`. `null` rather than a throw, because a miss is only fatal
 *  once every strategy below has missed. */
function walkUpForPrompts(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "prompts", "doctrine")))
      return join(dir, "prompts");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Where `prompts/` lives.
 *
 * Walked up from this file rather than taken from `cwd`, because the same
 * pipeline runs from the repo root (the CLI) and from `packages/web` (the Next
 * server), and a cwd-relative path is correct in exactly one of those.
 *
 * WHY THERE ARE THREE STRATEGIES AND NOT ONE, and the reason is measured rather
 * than defensive. Under a bundler `import.meta.url` is not a location, it is a
 * STRING LITERAL frozen at build time. A real `next build` of packages/web
 * compiles the line above into
 *
 *     dirname(fileURLToPath("file:///Users/moin/open-kb/packages/sweep/src/sweep.ts"))
 *
 * — verbatim, in `.next/server/chunks/873.js`. That is the path on the machine
 * that ran the BUILD. On any host that is not that machine (a Vercel lambda,
 * another developer's laptop, a container built elsewhere) the walk starts from
 * a directory that does not exist, every one of the eight candidates misses,
 * and the run dies on its first model call. The failure reads as "serverless
 * cannot run this" and is really "the walk started nowhere", which is why it is
 * worth this much comment: the two look identical from the outside and have
 * nothing to do with each other.
 *
 * So, in order of how much the environment has told us:
 *
 *   1. `OPENKB_PROMPTS_DIR`, when the layout is nobody's convention. The only
 *      strategy that works when the prompts are somewhere no walk would guess.
 *   2. The walk from this module, correct under plain `node` and `tsx`, where
 *      `import.meta.url` really is where the file is.
 *   3. The walk from `cwd`, correct inside a traced serverless bundle: the app
 *      runs in a copy of the repo tree, cwd is the app directory, and
 *      `prompts/` sits above it exactly as it does in the repo.
 *
 * (3) cannot replace (2): the CLI can be invoked from any directory, and cwd
 * then names the user's shell rather than the repo. (2) cannot replace (3), per
 * the literal above. Both are needed, and cheap — `existsSync` on a handful of
 * paths, once per run, memoised by `makePrompt`'s template cache thereafter.
 */
function promptsRoot(): string {
  // Taken as written and checked immediately, so a typo names itself here
  // rather than as a missing-agent error eight frames into the first model
  // call. The check is for `doctrine/` specifically because that is what the
  // walk looks for, so all three strategies agree on what "a prompts dir" is.
  const explicit = process.env.OPENKB_PROMPTS_DIR;
  if (explicit) {
    if (!existsSync(join(explicit, "doctrine"))) {
      throw new Error(
        `OPENKB_PROMPTS_DIR is set to ${explicit}, which has no doctrine/ in it`,
      );
    }
    return explicit;
  }

  const fromModule = walkUpForPrompts(dirname(fileURLToPath(import.meta.url)));
  if (fromModule) return fromModule;

  const fromCwd = walkUpForPrompts(process.cwd());
  if (fromCwd) return fromCwd;

  throw new Error(
    "cannot find prompts/ — the agents have no instructions to load",
  );
}

/**
 * A per-run prompt renderer: each agent's template is composed from disk once,
 * and only the placeholder fill happens per call.
 *
 * Composition is sync `readFileSync` work plus the `promptsRoot` walk, and the
 * classify call sits inside the rank pool — composing per call meant every
 * residue host re-read the same unchanging files from inside an async worker
 * (measured on the offline rehearsal: 18 compositions across three runs, one
 * per model call; a 740-host live run pays that per host). The files cannot
 * change mid-run, so the run composes each agent's template on first use and
 * renders from memory after that.
 *
 * Scoped to the run, not the module, on purpose: the prompts are editable
 * without a rebuild, and a process-wide memo would quietly end that for any
 * long-lived server — the next run must see the edited file.
 *
 * `compose` is injectable so a test can prove the arithmetic with a counting
 * fake; `sweep()` always uses the real files. It is synchronous, which is what
 * makes the memo race-free under the rank pool: the first classify call fills
 * the map before any other worker can look.
 */
export function makePrompt(
  compose: (agent: string) => string = (agent) => {
    const root = promptsRoot();
    return composePrompt(agent, join(root, "agents"), join(root, "doctrine"));
  },
): (agent: string, vars: Record<string, string | number>) => string {
  const templates = new Map<string, string>();
  return (agent, vars) => {
    let t = templates.get(agent);
    if (t === undefined) {
      t = compose(agent);
      templates.set(agent, t);
    }
    return render(t, vars);
  };
}

import { emitUi } from "./ui.js";

// ── the shapes ────────────────────────────────────────────────────────────────

export const INTENTS = [
  "pain",
  "switching",
  "evaluation",
  "build",
  "discovery",
  "integration",
  "hiring",
  "community",
] as const;
export type Intent = (typeof INTENTS)[number];

export const PLATFORMS = [
  "web",
  "reddit",
  "hackernews",
  "github",
  "stackoverflow",
  "producthunt",
  "x",
] as const;

/**
 * Where each platform actually lives, for `site:`.
 *
 * The enum above is filled in on every query the catalog agent writes and it
 * reached no query string. MEASURED over every run in `runs/` (1,999 query
 * records): 1,522 carry the hardcoded `platform: "web"` this file stamps on its
 * own templates, and the 477 where the model chose something else — reddit 162,
 * stackoverflow 117, github 105, hackernews 72, producthunt 14, x 7 — changed
 * nothing about what was bought. A field nobody renders is a field the model is
 * answering into a bin, and here it was answering into it 23.9% of the time.
 *
 * The hosts are the ones a search engine indexes, which is not always the one
 * the name suggests — `site:hackernews` matches nothing at all, the site is
 * `news.ycombinator.com`, and the catalog prompt spent months warning a model
 * about that in prose while no code rendered either. `x.com` is where the
 * platform's own links point now; posts
 * written before the rename are indexed under `twitter.com` and are not
 * reachable through this, because `site:` takes one host and guessing which
 * era a query wants is not something this table can do.
 *
 * `web` maps to no host on purpose: it is the absence of a scope, not a scope.
 */
export const PLATFORM_SITES: Record<string, string> = {
  web: "",
  reddit: "reddit.com",
  hackernews: "news.ycombinator.com",
  github: "github.com",
  stackoverflow: "stackoverflow.com",
  producthunt: "producthunt.com",
  x: "x.com",
};

/**
 * How long a query may be and still be worth scoping to one site.
 *
 * MEASURED, on the two corpora this engine is judged against: the hand-written
 * market queries median 5 words, open-kb's own median 4. A `site:` prefix
 * spends one of those terms on the scope, so a scoped query gets the
 * hand-written median for its actual question and no more. It is not a style
 * rule — a narrow site scope AND a sentence is the shape that returns an empty
 * page and bills for it anyway.
 */
export const MAX_SCOPED_WORDS = 6;

/**
 * Render a query's platform into the query, or leave it alone and say so.
 *
 * A LONG QUERY IS FIRED UNSCOPED RATHER THAN TRUNCATED. Cutting
 * "how do i find one request across a hundred containers" down to six words
 * leaves a fragment that means something else, so the choice here is between a
 * mangled scoped query and an honest unscoped one, and the unscoped one at
 * least still asks the question. The refusal is counted (`report.platform`),
 * because "the model keeps writing sentences at a platform" is a fact about
 * the prompt that only shows up if someone counts it.
 *
 * Idempotent: a query that already carries its own `site:` is left exactly as
 * written, and re-rendering a rendered query changes nothing. That matters
 * because this runs at fire time, where a query arrives by three different
 * roads — the opening hand, a reserve release, a freshly invented widening
 * query — and only one of them passes through the planner.
 *
 * THE ANCHOR'S OWN SITE IS NOT A PLATFORM, and `anchorHost` is what makes that
 * checkable. Six of the seven hosts in the table are companies this engine can
 * be pointed at, and one of them already is: `runs/` holds a github.com sweep
 * whose catalog tagged nine debranded queries `platform: "github"`. Rendered
 * blind, four of those become `site:github.com git leak prevention tool free`
 * and the like — a NON-BRANDED query naming the anchor and, worse, bounded to
 * the anchor's own pages, which is the one thing this engine exists not to do.
 * `banned()` cannot catch it: it runs in the planner, and this runs at the
 * wire. Replayed over the stored corpus the guard is the difference between 5
 * anchor-naming non-branded queries and the 1 that was already there.
 *
 * Refused BEFORE the length test, because the reason such a query goes out
 * unscoped is whose site it is, not how long it is, and a counter that said
 * `tooLong` would send the next reader to the prompt to fix the wrong thing.
 */
export function scopeToPlatform(
  q: string,
  platform: string,
  anchorHost = "",
): { q: string; scoped: boolean; tooLong: boolean; anchorOwned: boolean } {
  const host = PLATFORM_SITES[platform] ?? "";
  const body = q.trim();
  if (!host || !body || /\bsite:/i.test(body))
    return { q, scoped: false, tooLong: false, anchorOwned: false };
  if (anchorHost && registrableHost(host) === registrableHost(anchorHost))
    return { q, scoped: false, tooLong: false, anchorOwned: true };
  if (body.split(/\s+/).length > MAX_SCOPED_WORDS - 1)
    return { q, scoped: false, tooLong: true, anchorOwned: false };
  return {
    q: `site:${host} ${body}`,
    scoped: true,
    tooLong: false,
    anchorOwned: false,
  };
}

export const ENTITY_KINDS = [
  "company",
  "product",
  "community",
  "publisher",
  "directory",
  "noise",
  "unknown",
] as const;

/**
 * The kinds a host may be judged as — ENTITY_KINDS without `product`.
 *
 * `product` IS STILL A KIND, and nothing new is minted as one. It stays in the
 * vocabulary above because 81 runs on disk are full of it, the swarm's own node
 * kinds include it, and `Entity` above still has to parse a stored map. What
 * changed is that the model is no longer asked to choose.
 *
 * WHY THE CHOICE WAS A COIN FLIP. A front page is product marketing by
 * construction, so the page a judge is handed argues for `product` no matter
 * who owns it. Measured across nine runs: `company` share ran 0.0% to 1.1%.
 * Stripe's map said its market had ONE company and 1,273 products. The
 * distinction cost a real judgement per host and bought a number nobody could
 * defend.
 *
 * AND NOTHING DOWNSTREAM WANTED IT. `n.kind === "company" || n.kind ===
 * "product"` appears six times across core, sweep and swarm — verdict.ts's
 * COMPANY_LIKE, the swarm's live-node filters, seed-families, the edge
 * builders. Every consumer that acts on the kind already re-merges them. The
 * one place they were kept apart was the place they were guessed.
 *
 * What a company sells is not lost; it is the `what`, which is span-checked
 * against the page and was always the better place for it.
 */
export const CLASSIFY_KINDS = ENTITY_KINDS.filter(
  (k) => k !== "product",
) as unknown as readonly [string, ...string[]];

/**
 * The classify answer's size, output tokens. 350 before span-bound
 * descriptions; the spans field adds up to three ~120-char verbatim quotes
 * (~100 tokens, billed at six times the input rate — the reason the receipts
 * are capped at three spans and 360 stored chars, not "as many as help").
 * Note `call()` floors the wire ceiling at 6,000 because mandatory reasoning
 * spends from the same budget — this constant documents the answer's size and
 * feeds that max(); it is not itself the wire cap.
 */
export const CLASSIFY_MAX_OUTPUT_TOKENS = 450;

/** Hosts per triage call. Was 60: ~4k input tokens and ~1.5k of verdict rows,
 *  which runs/sweep-cursor-com-20260823064255.json showed timing out at the
 *  120s call ceiling four times in fourteen calls, each timeout costing its
 *  whole wave (see the dispatch below). Thirty halves the rows a slow answer
 *  has to stream before the ceiling, and halves what one failure fails open. */
export const TRIAGE_BATCH = 30;
/** A host this many distinct queries returned cannot be skipped by triage:
 *  that many roads in is the search itself vouching for it, and a title and
 *  description do not outrank the search. */
export const TRIAGE_KEEP_SEENIN = 5;
/** The verdict rows are short; this documents the answer's size the way
 *  CLASSIFY_MAX_OUTPUT_TOKENS does, and `call()` floors the wire cap anyway. */
export const TRIAGE_MAX_OUTPUT_TOKENS = 2_000;

/** How many unplaced hosts the second look may re-read. The stored runs carry
 *  23-260 `unknown` rows each, and every one over this cap would cost a fetch
 *  and a classify call on a host the front page already refused once — sixty
 *  bounds the stage to roughly what one triage pass costs. */
export const SECOND_LOOK_CAP = 60;

/**
 * The order a capped stage should spend its slots in: most-corroborated
 * first, ties broken by the best rank any query gave the host.
 *
 * WHY EVERY CAPPED STAGE NEEDS THIS. The stages that cap themselves used to
 * slice `entities` in array order, and that array is not in a neutral order —
 * it runs from least corroborated to most. Mean `seenIn` across its five
 * fifths, on three different anchors:
 *
 *   shopify   1.06  1.07  1.31  1.71  3.18
 *   stripe    1.10  1.17  1.17  1.53  3.32
 *   vercel    1.09  1.16  1.39  1.77  3.73
 *
 * Monotonic on all three. So `slice(0, CAP)` on that array does not take an
 * arbitrary sample, it takes the WEAKEST hosts the run found — and the two
 * stages that do it, the second look and drop-confirm, are both spending a
 * scarce budget on the question "is this host worth another look".
 *
 * Exported because the thing worth pinning is the ORDER, and the caps are 60
 * — a fixture with sixty hosts would exercise the slice while saying almost
 * nothing about the comparison inside it.
 *
 * `bestRank` is optional and sorts last when missing: a host no query ranked
 * is not evidence of a good host, and `undefined` must not win a tie by
 * arithmetic accident the way `Math.floor` once picked a median.
 */
export function mostCorroboratedFirst<T extends { seenIn: number; bestRank: number | undefined }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) => b.seenIn - a.seenIn || (a.bestRank ?? Infinity) - (b.bestRank ?? Infinity),
  );
}

/** How many second-look fetches may escalate to the unlocker in one run. About
 *  half of a real run's second looks landed on a page that was ALSO walled —
 *  the direct fetch the stage already spends is not a different door than the
 *  one the judge's front page hit. Only a host that earned its first look
 *  twice over (`seenIn>=2` or `bestRank<=5` — the rank phase's own corroboration
 *  bar, not a new one) gets the unlocker's ~$0.008.
 *
 *  SET BY YIELD, which it was not before. The number was ten by analogy —
 *  "roughly what the rank phase's own `OPENKB_RANK_UNLOCK` bar spends on one
 *  fresh map" — and ten was exhausted on both runs since the snippet gate
 *  shipped, so the analogy was bounding the stage without anyone knowing what
 *  the next escalation was worth. It is now measured:
 *
 *    an escalation recovers a page      91%  (10 of 11, unlocker on 4xx)
 *    a recovered page places the host   72%  (13 rescued of 18 that got one)
 *    so one $0.008 escalation buys      0.66 placed rows, about $0.012 each
 *
 *  Those are rows that otherwise do not exist — the host is unplaced and this
 *  is the last stage that will look at it — so a cent apiece is worth paying
 *  on a run that costs ~$0.90.
 *
 *  Twenty-five is the population, not a round number: the earned-and-4xx hosts
 *  left over after the stage ran number 23 and 14 on two shopify runs, plus
 *  the ten it had already spent. The ceiling only binds on maps that big.
 *  Stripe's run has ZERO earned-4xx hosts and would spend nothing at any
 *  ceiling, which is the property that makes raising this cheap: it is a
 *  ceiling on the runs that need it, not a floor on the ones that do not.
 *  Worst case is $0.20 against a $0.90 run, and only when 25 corroborated
 *  hosts really did wall their pages.
 *
 *  MEASURED ON A REAL RUN, this raise together with the 4xx-only shape check,
 *  against the two shopify runs either side of it:
 *
 *                       asked  rescued  failed  unlocked   pages got   cost
 *    thin-render + 10      60       13      42        10        30%   $1.038
 *    thin-render + 10      60       15      40        10        33%   $1.046
 *    4xx only + 25         60       24      32        14        47%   $1.036
 *
 *  Every column moved the same way at once, and the cost did not move at all —
 *  the four extra escalations were paid for out of the thin-render ones that
 *  stopped happening. `unlocked` landing at 14 rather than 25 is the useful
 *  detail: the budget is no longer what bounds this stage, so raising it
 *  further would buy nothing. `earnedUnlock` and the shape check bound it now.
 *
 *  WHAT THIS DOES NOT SHOW. One run against two, on an anchor whose own
 *  baselines disagree — the two runs above kept 1,242 and 1,034 entities and
 *  left 103 and 54 hosts unplaced. Map-level numbers are too noisy at this n
 *  to attribute to anything, and none are claimed here. What the three runs do
 *  support is the stage-level reading, because the second look's own metrics
 *  moved together rather than one of them moving alone.
 *
 *  It also predates `mostCorroboratedFirst`, which changed WHICH sixty hosts
 *  this stage sees. That is a further improvement on the same numbers and is
 *  not in the 47% above. */
export const SECOND_LOOK_UNLOCK_BUDGET = 25;

/** How many model-settled `relation: "none"` hosts the drop-confirm stage may
 *  re-ask about, on the same precedent SECOND_LOOK_CAP sets: bounds the stage
 *  to roughly what one triage pass costs, rather than re-litigating every
 *  refusal a large map produced. Batched at the link phase's own batch size
 *  (`BATCH`, `SweepOptions.batchSize`) rather than a constant of its own —
 *  that number already matches the "40 per call" this stage was measured
 *  against, and reusing it keeps the two in sync instead of drifting apart. */
export const DROP_CONFIRM_CAP = 60;

/** How long the planner will wait for in-flight searches to land before it
 *  assesses the map. One SERP round trip is ~5s and the port's own ceiling is
 *  30s; past this the planner proceeds on what it has rather than hanging.
 *  Argued where it is used, in `planner`. */
export const LANDING_GRACE_MS = Math.max(
  0,
  Number(process.env.OPENKB_LANDING_GRACE_MS ?? 45_000) || 45_000,
);

/** How many times to read the company before deciding what it sells. Argued
 *  at `understandByCall`: the call is not reproducible, the whole run descends
 *  from it, and three asks cost about a third of a cent and no wall clock
 *  because they run concurrently. 1 restores the old single-ask behaviour. */
export const UNDERSTAND_ASKS = Math.max(
  1,
  Math.floor(Number(process.env.OPENKB_UNDERSTAND_ASKS ?? 3) || 3),
);

/**
 * Gateway hosts never to route a model call to, by the gateway's own slug.
 * Measured, not guessed, and each for its own reason.
 *
 * `baidu` returns answers that miss the schema — 3 of 6 valid on the real
 * catalog call where seven other hosts were 6 of 6. See `openrouterOpts`.
 *
 * `wafer` answers, and answers differently every time. On the understand
 * call — the largest prompt the pipeline sends, and the one everything
 * downstream descends from — three IDENTICAL asks at temperature 0, pinned
 * per host, returned:
 *
 *   Wafer         17, 37, 32     spread 20
 *   DeepInfra     46, 54, 54     spread  8
 *   Reka          60, 61, 60     spread  1
 *   SiliconFlow   63, 63, 63     spread  0
 *
 * An earlier probe of the same prompt, served by Wafer throughout, returned
 * 14, then 1, then 19 — a fifty-product company collapsed to one. So the
 * instability that `understandByCall` reads three times to survive is not a
 * property of the call, it is a property of that host.
 *
 * The spread BETWEEN hosts is its own problem and is not solved here: 17 to
 * 63 products for one company, same prompt, same day. A run is internally
 * consistent because the first answer's host serves the rest of it
 * (`stickyHost`), but two runs that draw different hosts read the company
 * differently, which is most of the 43-to-51 spread across real shopify.com
 * runs. Pinning one host globally would fix it and is exactly what this file
 * removed this morning for going stale.
 *
 * `OPENKB_MODEL_HOST_IGNORE` (comma-separated) replaces the list.
 */
export const MODEL_HOST_IGNORE: string[] = (
  process.env.OPENKB_MODEL_HOST_IGNORE ?? "baidu,wafer"
)
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

/** How long one model call may take before it is abandoned. Argued at
 *  `withDeadline` in `call()`; overridable for a slow model or a slow host.
 *
 *  Was 120s, sized against "classify retries at 56 to 62 seconds" — and those
 *  were measured on the pinned provider that `openrouterOpts` has since
 *  stopped pinning. On the throughput-sorted route a one-host classify is
 *  2-3s and a 30-row triage ~6s, so 60s still clears the slowest legitimate
 *  call (the 51s single catalog call) while halving what one hung socket
 *  costs a run. (An earlier version of this comment blamed the 6.3-minute
 *  judge tail on runs/sweep-cursor-com-20260823064255.json on two chained
 *  120s timeouts; the log shows no timeout fired at all — see `withDeadline`
 *  for what actually happened. The per-host calls have their own, shorter
 *  ceiling in `RANK_CALL_TIMEOUT_MS` below.) */
export const CALL_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.OPENKB_CALL_TIMEOUT_MS ?? 60_000) || 60_000,
);

/**
 * The `understand` call's own deadline, and the reason it needs one.
 *
 * It is the largest prompt this pipeline sends — every anchor page condensed,
 * plus a line for each of up to 25 product pages — and it is the ONLY call
 * with no fail-open anywhere downstream: `sells`, `buyer` and the capability
 * list are what every later stage is built on, so a failure here is a dead
 * run rather than a narrower map. When CALL_TIMEOUT_MS came down from 120s to
 * 60s (100ae58) it took this call with it, and 60s was chosen against a
 * one-host classify that answers in 2-3s.
 *
 * MEASURED, the expensive way: a datadoghq.com run on 2026-08-23 read 25
 * product pages, spent 60s on the understand call, spent another 60s on its
 * retry, and died having bought nothing. An earlier datadoghq.com run the
 * same evening cleared 60s and finished — so the call sits right on the
 * boundary for a large anchor, which is the worst place for a deadline to be.
 *
 * Three minutes. One call per run, so the ceiling costs nothing in aggregate
 * even when it is never approached, and the alternative it guards against is
 * a run that ends before its first search.
 */
export const UNDERSTAND_CALL_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.OPENKB_UNDERSTAND_CALL_TIMEOUT_MS ?? 180_000) || 180_000,
);

/** The link and orphan calls' own deadline — was tighter than `CALL_TIMEOUT_MS`
 *  when that stood at 120s; the two now meet at 60s and this one is kept as
 *  its own knob. `docs/overnight-backlog.md`'s P0-4 finding: on the measured
 *  cursor.com run (runs/sweep-cursor-com-20260821105321.json) two timed-out
 *  link batches cost about 4 minutes of the 12.3-minute link phase — the same
 *  run that motivated `LINK_CONC` above. Unlike a one-off classify call, link
 *  and orphan calls are batched, uniform, and already retried once on the
 *  same original ceiling, so a hung call does not need 120s of runway before
 *  that retry fires. 60s halves the cost of a hang against the 120s default;
 *  the backlog's own suggested range was 45-60s and this takes the upper,
 *  safer end of it. */
export const LINK_CALL_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.OPENKB_LINK_CALL_TIMEOUT_MS ?? 60_000) || 60_000,
);

/** The per-host calls' own deadline — classify, triage, the second look and
 *  drop-confirm. These are the calls a run makes by the thousand (1,531 rank
 *  calls on runs/sweep-cursor-com-20260823064255.json), each a one-host
 *  question the throughput-sorted route answers in 2-3s (a 30-row triage in
 *  ~6s). A call of thirty seconds there is a sick host, not a hard question,
 *  and the retry goes out unrouted to a different one. Half the general
 *  ceiling: the pool's tail — the last few hosts, with nothing left to hide
 *  them behind — is bounded by one ceiling plus one retry, so this is the
 *  number that decides how long a run waits on its stragglers. */
export const RANK_CALL_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.OPENKB_RANK_CALL_TIMEOUT_MS ?? 30_000) || 30_000,
);

/** Roundup-shaped: the row's own title or description reads like a page that
 *  names several vendors rather than one. Cheap and deliberately loose — a
 *  false match costs nothing but a wasted line in one batched model call, a
 *  false miss costs a vendor this run never asks about at all. */
export const ROUNDUP_SHAPE = /alternatives|top \d+|best|vs\.?|comparison/i;

/** How many roundup-shaped rows the listicle-harvest call may read at once.
 *  One model call reads all of them, so this bounds that call's input rather
 *  than batching it — TRIAGE_BATCH's precedent, sixty rows of title and
 *  description is comfortably inside one call's input floor. */
export const LISTICLE_MAX_ROWS = 60;

/** How many fresh queries the listicle-harvest stage may fire in total. A
 *  small hand per name (`rivalHand`'s own two-thirds/one-third split) times
 *  a handful of names is already single digits on a normal run; this is the
 *  backstop for the run where the extraction call names an unreasonable
 *  number of vendors. */
export const LISTICLE_MAX_QUERIES = 20;

/**
 * How an entity stands to the anchor.
 *
 * Eight are commercial stances. Three cover hosts that have no commercial
 * stance but still relate: publications, directories, forums. `unknown` is
 * the downgrade for a claim the evidence refused — the host stays, wearing
 * the refusal. With only commercial words, 144 of 438 hosts on one run came
 * back `none` and dropped off the map, since a node with no relation gets no
 * edge.
 */
export const RELATIONS = [
  "competitor",
  "substitute",
  "adjacent",
  "dependency",
  "integration",
  "shaper",
  "buyer",
  "target",
  "covers",
  "lists",
  "discusses",
  "unknown",
  "none",
] as const;

/**
 * The three lenses the catalog is written through, in parallel.
 *
 * One model call writing the whole catalog took 51 seconds and had to hold
 * every intent at once, which is how a prompt ends up covering all of them
 * thinly. Three calls run concurrently, so the stage costs the slowest rather
 * than the sum, and each prompt argues for one thing.
 *
 * Split by WHO is searching, not by market: a market's competitors, its
 * substitutes and its communities are found by different people typing
 * different things, and one lens cannot reach all three. Every lens still
 * covers every market.
 */
/**
 * The lenses are gone: the PRODUCT is the unit now.
 *
 * Splitting the catalog three ways by persona -- the buyer in trouble, the
 * practitioner, where the market gathers -- meant a market covering three
 * products got one share between them, and the shapes each lens knew are
 * better expressed as shapes ONE product's call should spend across. Those
 * moved into prompts/agents/catalog.md, where they are editable without a
 * rebuild, and the demand-wave gate went with them.
 */

/**
 * How two found entities stand to EACH OTHER.
 *
 * The map was a star: on one run all 367 edges touched the anchor and none
 * joined two other companies. That is a list with a centre, not a market. A
 * reader wants to know that two vendors compete with each other, that a forum
 * argues about a specific one, that a directory lists a set.
 *
 * Same words as the anchor vocabulary, read from `from` to `to`. Direction is
 * load-bearing and is not symmetric for the channel relations: a publisher
 * covers a vendor, never the reverse.
 */
const PEER_RELATIONS = [
  "competitor",
  "substitute",
  "dependency",
  "integration",
  "covers",
  "lists",
  "discusses",
  "unknown",
] as const;

const EntityEdge = z.object({
  from: z.string().describe("the domain doing the relating, exactly as given"),
  to: z.string().describe("the domain being related to, exactly as given"),
  relation: z.enum(PEER_RELATIONS),
  why: z
    .string()
    .describe("how they relate, in one line. Not that they resemble."),
  /**
   * Borrowed from the graphify extraction spec, which requires a confidence on
   * every edge and forbids a lazy default. `measured` means a page we retrieved
   * put these two together; `inferred` means the model reasoned it from what
   * each one does. A reader can discount the second and not the first.
   */
  confidence: z
    .enum(["measured", "inferred"])
    .describe(
      "measured = a retrieved page named both; inferred = reasoned from what each does",
    ),
  /**
   * The paid link pass's counterpart to classify's `relationSpan`: link.md
   * already tells the model "'Both in web scraping' is worth nothing", but
   * that instruction was never checked against anything — a model free to
   * assert a mechanism is a model free to assert a generic one, and nothing
   * downstream could tell the two apart. Optional, and only the paid pass
   * fills it: the free naming pass above proves `why` a different way (it
   * quotes the naming row directly, in code, before an edge is ever pushed),
   * and every existing fixture answering the link schema without this field
   * must keep parsing.
   */
  whySpan: z
    .string()
    .min(8)
    .optional()
    .describe(
      "one quote copied character-for-character from either entity's description above, backing WHY specifically",
    ),
});

export type EntityEdge = z.infer<typeof EntityEdge> & {
  /** Whether `whySpan` verified as a literal substring of the two entities'
   *  own descriptions (the exact text `describe()` showed the model) — the
   *  same `checkQuote` containment check `relationGrounded` runs for the
   *  classify pass's `relationSpan`. Measured, never a gate: an edge with
   *  `whyGrounded: false` still ships, the same rule `descGrounded` and
   *  `relationGrounded` already live by. */
  whyGrounded?: boolean;
};

const Decomposition = z.object({
  sells: z
    .string()
    .describe(
      "what this company sells, in one plain sentence, no marketing words",
    ),
  buyer: z
    .string()
    .describe("who buys it and what has just gone wrong for them"),
  brand: z
    .string()
    .describe(
      "the company's name as it writes it, e.g. from its own header or footer",
    ),
  products: z.array(
    z.object({
      name: z.string(),
      does: z
        .string()
        .describe(
          "what this product does, stripped of the company's own naming",
        ),
      foundAt: z
        .string()
        .describe(
          "the url of the company's own page that establishes this product, copied from the pages given; empty string if none does",
        ),
    }),
  ),
  /**
   * The products, grouped into the markets they sit in.
   *
   * A SKU sheet is a pricing artifact. On one run, three proxy SKUs of a single
   * capability took 3 of 10 query slots while a separate product line with its
   * own rivals took 0. Grouping splits the budget by market instead.
   *
   * Group by "would these have different competitors", not by similar wording.
   */
  capabilities: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "the capability in the market's words, no brand, no product name",
          ),
        does: z.string().describe("the job it does for the buyer, one line"),
        covers: z
          .array(z.string())
          .describe("which of the products above this groups"),
        /**
         * Core or adjacent, because equal coverage misfires.
         *
         * Measured: a transactional email company lists an MCP server among its
         * products. Grouping made it a market, "give every market a query" gave
         * it a third of a three-query budget, and it returned eight hosts about
         * AI protocols and nothing about email. A side integration is a real
         * product and a real market; it is not worth the same share as the thing
         * the company is bought for.
         */
        centrality: z
          .enum(["core", "adjacent"])
          .describe(
            "core = what buyers come to this company for. adjacent = a side line, integration or add-on they would not switch vendor over.",
          ),
      }),
    )
    .describe(
      "the products grouped into distinct markets — the unit the search budget is split across",
    ),
  coinages: z
    .array(z.string())
    .describe(
      "words this company invented — product names, brand terms. Queries must never contain these.",
    ),
});

/**
 * The judgement the discovery agent does not make: brand + the market grouping.
 * Agent-mode phase one asks for exactly this over the agent's product list —
 * the same two fields, cut from the same schema, so the two discovery modes
 * cannot drift apart on what a capability is.
 */
const Grouping = Decomposition.pick({ brand: true, capabilities: true });

const PlannedQuery = z.object({
  q: z.string(),
  intent: z.enum(INTENTS),
  platform: z.enum(PLATFORMS),
  // The reason this query is worth buying, written where the query is composed.
  // A plan is a spend: a list of query strings tells a reader what was bought
  // and never why, and a reason reconstructed later from the query text is a
  // guess about our own plan rather than a record of it.
  why: z
    .string()
    .describe(
      "one short line: what this query is expected to surface that the others will not",
    ),
  /**
   * Which of the anchor's markets this query is for.
   *
   * Taken from v1, whose hand-written catalog tagged every one of its 602
   * queries with the products it served. Without it, "cover every market" is a
   * sentence in a prompt that nothing checks: a run can spend its whole budget
   * on one market and report only that it asked forty questions. With it the
   * gap is countable before a single search is paid for.
   */
  market: z
    .string()
    .describe(
      "the capability name this query is aimed at, copied exactly from the list above",
    ),
});

const Entity = z.object({
  name: z.string(),
  domain: z.string(),
  kind: z.enum(CLASSIFY_KINDS),
  what: z.string().describe("what it is, one line, from what the results say"),
  relation: z.enum(RELATIONS),
  why: z
    .string()
    .describe("why it belongs on this map, stated against the anchor"),
});

export type Decomposition = z.infer<typeof Decomposition>;
export type PlannedQuery = z.infer<typeof PlannedQuery>;

/** A query as the sweep fires it: the model's PlannedQuery plus the mechanical
 *  tags. Family and product are stamped in code, never asked of the model —
 *  a tag the model can forget is a tag the join cannot rely on. */
export type SweptQuery = PlannedQuery & {
  family: QueryFamily;
  product?: string;
  term?: string;
  /** The text the wire actually saw, when `scopeToPlatform` rendered a
   *  `site:` onto it. `q` stays the WRITTEN text: the widening dedupe and the
   *  result joins key on it, and overwriting it blinded the dedupe — the same
   *  wire string was bought twice when a widening round re-proposed a query
   *  whose record had been mutated to its scoped form. */
  fired?: string;
};

/**
 * `foundBy` is which of the anchor's markets' queries surfaced this host,
 * strongest first. Filled mechanically after classification — every hit knows
 * its query and every query knows its market — never by the model.
 *
 * This is the field that turns the graph from a star into a map. v1 attached
 * every finding to the product whose search surfaced it: search for the
 * unlocker's job, find Apify, and Apify hangs off the unlocker. That chain
 * existed here too, and was dropped between the sweep and the result, so the
 * reader got one hub with a hundred spokes and no way to see which market any
 * of them belonged to.
 */
export type Entity = z.infer<typeof Entity> & {
  foundBy?: string[];
  families?: QueryFamily[];
  /** The surfacing queries themselves, most-seen first, at most three — the
   *  layer-zero connection. `foundBy` names the markets and `families` the
   *  door-shapes; this is what was actually typed. */
  roads?: string[];
  /**
   * How prominent this host is IN THIS MARKET, from the search itself:
   * `seenIn` is how many distinct queries returned it, `bestRank` the highest
   * position any of them gave it. Neither is a judgement — both are counts of
   * what the engine did — and together they are the difference between a map
   * that lists a market and one that ranks it. Without them a leader and a
   * reseller sit level, because every other field says only what a host IS.
   */
  seenIn?: number;
  bestRank?: number;
} & {
  because?: string;
  /** `triage` marks a host skipped from search metadata alone — never fetched,
   *  never judged; `because` carries the model's one-line reason. */
  settledBy?: "predicate" | "model" | "triage";
  /** Unreadable hosts only: WHY the front page could not be read, as the
   *  sniffer's stable code (rank.ts stamps it beside the `because` sentence).
   *  Persisted with the run so a stored map can say "61 bot-walled, 40
   *  JS-only" instead of "127 unreadable". */
  unreadableReason?: UnreadableReason;
  /** Model-judged entities only: what fraction of the content terms in the
   *  what the model WROTE the page it saw actually contains, 2 decimals.
   *  The regression canary — the span ledger below is the gate. */
  descGrounded?: number;
  /** Model-judged entities only: how many of the verbatim page quotes the
   *  model claimed back its what were literal substrings of the page it saw,
   *  checked in code. A what with zero verified spans shipped as the span-free
   *  fallback sentence, never as the model's prose. */
  descSpans?: { verified: number; claimed: number };
  /** The verified quotes — the receipts, capped at 360 chars total. */
  spans?: string[];
  /** Model-judged entities only: one sentence, the single decisive fact that
   *  settled `kind` and `relation` — not the `why` restated, the fact that
   *  made the `why` true. */
  reasoning?: string;
  /** Model-judged entities only: `spans`'s counterpart for `relation` — one
   *  verbatim quote backing the RELATION specifically, not the `what`. */
  relationSpan?: string;
  /** Whether `relationSpan` verified as a literal substring of the page it
   *  was quoted from (the same `checkQuote` containment `spans` gets) — a
   *  measure, never a gate: this codebase's own rule for `descGrounded` is
   *  it is never used to reject, and `relationSpan` gets the same rule. */
  relationGrounded?: boolean;
};

export interface SweepStats {
  queries: number;
  results: number;
  hosts: number;
  kept: number;
  tokIn: number;
  tokOut: number;
  /** Output tokens the model spent thinking. Billed at the output rate and
   *  never shown to anyone, so it is worth being able to see. */
  tokReasoning: number;
  serpCalls: number;
  unlockerCalls: number;
  usd: number;
  seconds: number;
}

export interface SweepResult {
  anchor: string;
  decomposition: Decomposition;
  queries: SweptQuery[];
  entities: Entity[];
  /** How the entities relate to each other, not to the anchor. */
  edges?: EntityEdge[];
  stats: SweepStats;
  /**
   * The run's own summary, in exactly the shape the `complete` frame carries.
   *
   * Built once and both emitted and returned, so `GET /api/run/{id}` and the
   * `complete` frame cannot disagree. They used to be assembled independently,
   * which is the shape of bug where a browser that caught the frame and a
   * browser that asked afterwards render two different runs.
   */
  report: Record<string, unknown>;
}

export interface SweepOptions {
  domain: string;
  /** An override that clamps the catalog to a fixed count, for a bounded
   *  probe. Left unset — the normal case — every product is dealt its own
   *  opening hand instead, and the run's real ceiling is the spend limit, not
   *  a query quota. */
  queries?: number;
  /**
   * A ceiling on the queries this run may fire IN TOTAL — the opening hand and
   * every widening round together.
   *
   * NOT `queries`, and the difference is the whole point. `queries` clamps the
   * CATALOG: the opening is sliced to it and the widening loop then adds
   * whatever it likes on top, which on one measured run turned an opening of 10
   * into 77 fired queries. A caller with a clock cannot bound a run with a
   * number the run is free to multiply by seven, so this one is checked at both
   * places a query is bought.
   *
   * Left unset by the CLI, which has no deadline and should keep dealing its
   * own hand. Set by the web route, which knows its `maxDuration` and sizes the
   * run to it (`queriesThatFit`, @open-kb/core/clock).
   */
  maxQueries?: number;
  /**
   * The instant this run must be FINISHED by, epoch ms — not a duration, and
   * not a timeout that fires.
   *
   * Nothing here aborts on it. It is read at the two places a run can still
   * choose to be smaller: the planner will not open a widening round it cannot
   * afford to rank, and the rank pool stops judging with a tail's worth of
   * clock in hand so the map is written, linked and persisted rather than
   * killed mid-phase. A run that overshoots anyway ends the way it always did.
   *
   * It exists because the query budget above is arithmetic over MEDIANS, and
   * the measured spread on hosts-per-query is 7 to 17. The budget picks the
   * size of the run; this catches the runs the median got wrong.
   *
   * Left unset by the CLI: no clock, no checks, byte-identical behaviour.
   */
  deadlineAt?: number;
  spans: SpanStream;
  creds: BrightDataCredentials;
  /**
   * The two ports the run spends through, handed in rather than built.
   *
   * Left unset — which is every production caller — the engine builds them from
   * `creds` exactly as it always did: Bright Data SERP `pages` deep, Bright Data
   * fetch for everything else. Nothing on that path moved, and nothing about it
   * is conditional on this field beyond one `??`.
   *
   * BOTH OR NEITHER, and that is the whole reason this is one field rather than
   * two. A caller able to hand over only `search` would leave `fetch` built from
   * whatever `creds` happens to hold, so an "offline" test would still put ~900
   * front-page fetches and every unlocker retry on a real account while
   * believing it was offline. There is no half-injected state to arrive at by
   * accident: you replace the pair or you replace nothing.
   *
   * This is the seam the engine had none of. `sweep()` constructed its own ports
   * inside itself, which is why 2,119 lines of pipeline were reachable only by
   * paying for a run, and why the 46 artifacts in `runs/` were its test suite.
   * Three alternatives were weighed and lost:
   *
   *   - A `fetchImpl` passthrough (what `@open-kb/providers` already exposes to
   *     its own tests) puts the seam BELOW the port. Every sweep fixture would
   *     then have to speak Bright Data's wire — the SERP response envelope, the
   *     zone names, the status-to-error mapping, the retry-and-rate-limit ladder
   *     with its real sleeps — to say something about the widening loop. And it
   *     still could not express the case `SearchPort` exists to express: one
   *     query failing inside a batch that otherwise succeeded.
   *   - A factory (`makePorts(creds, { pages })`) is an indirection over a
   *     construction that happens once, at one place, from arguments already in
   *     hand. It buys nothing here and invites a caller to return a different
   *     port per call.
   *   - A module mock of `@open-kb/providers` — which one test in this package
   *     still uses, correctly, because it is proving the REAL port carries a
   *     signal to the socket. As a general seam it is file-global and hoisted,
   *     so one file cannot vary ports between cases; it is invisible from this
   *     type surface, so nothing tells a reader the engine is injectable; and it
   *     fails OPEN — rename the provider export and the mock silently stops
   *     mocking, so the test starts reaching the network instead of going red.
   */
  ports?: { search: SearchPort; fetch: FetchPort };
  model: LanguageModel;
  /** Names the model in the trace. `model` itself is an opaque object. */
  modelId?: string;
  runId?: string;
  /** Accounting only — nothing here bills anyone, and a wrong number makes the
   *  cost readout wrong rather than the run. Omit it and `modelId` is priced
   *  from `@open-kb/providers`; pass it only to price a model that table has
   *  not met. */
  pricing?: ModelPricing;
  /** Result pages read per query the FIRST time it is asked. Measured: one query
   *  across five pages returned 37 distinct hosts against 7 from the first page
   *  alone, and had not saturated. A page costs exactly what a query costs, so
   *  depth here buys more of a market than breadth does — but paying that depth
   *  on every query, including the ones whose second page only repeats the
   *  first, buys corroboration nobody asked for. See `deepPages`: every product
   *  opens at this depth, and only the ones `assess` names from a real page-2
   *  yield go deeper. */
  pages?: number;
  /** Result pages read per query for a product `assess` has asked to deepen —
   *  see `SweepOptions.pages`. Left at its default, this roughly doubles the
   *  read for a product whose second page kept finding hosts the first page
   *  did not; a product nobody names stays at `pages` for the whole run. */
  deepPages?: number;
  /** Ceiling on how many times the run may look at its own map and ask for more
   *  queries. It usually stops before this because the model says it has enough. */
  maxWaves?: number;
  /** A floor under the model's "enough": rounds before that verdict is
   *  accepted. Measured need: two runs of one anchor, identical code, went 87
   *  and 36 queries because the assess model's mood set the width. A gallery
   *  of maps must be comparable, so a floor makes width a setting rather than
   *  a temperament. Clock and spend caps still end a run regardless. */
  minWaves?: number;
  /** A wave adding fewer new hosts than this ends the run, more queries would be
   *  buying corroboration rather than coverage. */
  minNewHosts?: number;
  /** SERP calls in flight at once. */
  concurrency?: number;
  /** Co-occurring pairs per link-phase model call. */
  batchSize?: number;
  /** Outbound-link count above which a company-shaped front page is settled as
   *  a directory for free, without a model call. Left unset: calibration
   *  (`scripts/calibrate-kernel.ts`) found no separation between vendor and
   *  directory front pages on the measured sample, so the rule ships disabled
   *  (`null`) rather than shipping a guessed number. Set it once a real run
   *  produces a cutoff worth trusting. */
  aggregatorThreshold?: number;
  /** How many co-occurring entity pairs to ask about. 0 disables linking. */
  maxPairs?: number;
  /** Skip the paid pass that asks a model to label co-occurring pairs, keeping
   *  only the free edges from pages that name another player outright. */
  skipModelLinking?: boolean;
  /** How many of the company's own product pages to read. 0 uses the index only. */
  productPages?: number;
  /**
   * How many queries may actually carry their `site:` onto the wire. 0 — the
   * default — renders none. MEASURED on the two fresh runs: 12 of 87 and 6 of
   * 36 queries fired scoped and bought 3 and 0 new hosts against 10.6 and
   * 16.6 per unscoped debranded query — a site:-scoped query lands every hit
   * on the one platform host by construction, so it cannot widen a map. The
   * catalog agent still chooses platforms and `report.platform` still says
   * what it asked for; what changes is that the prefix stays off the wire and
   * the same words go out as an ordinary web search.
   */
  platformScope?: number;
  /**
   * Roughly how many distinct hosts this run should stop buying at — an
   * ESTIMATION STOP, not a cap on the map: every host already seen is still
   * judged, so the final count lands somewhat above it. The owner's sizing:
   * ~700 kept nodes is already a big map, and kept runs ~78% of hosts, so the
   * default of 900 hosts lands near it. Without this the only stops were the
   * model's judgement, the wave ceiling and the clock — a run on a crowded
   * market bought 1,309 hosts and every one of them cost rank time and rank
   * money after the map was already large enough to read.
   */
  maxHosts?: number;
  /**
   * How phase one reads the company: `"call"` (default) hands a model one
   * pre-fetched packet and takes its single answer; `"agent"` runs the
   * discovery agent from @open-kb/core, which pulls the corpus itself —
   * maps the product pages, reads the ones it judges worth reading, follows
   * what it learns, and submits products as it confirms them.
   *
   * A FLAG, NOT A MIGRATION. The two must run side by side on the same anchor
   * before either is declared the engine, because the case for the agent is a
   * measured one — a single call read three products off a company with dozens
   * — and the case has to survive being re-measured on the current engine.
   * `"call"` is byte-identical to the behaviour before this field existed.
   *
   * The agent finds products; it does not group them into markets. That
   * judgement — the grouping the whole search budget is divided by — stays a
   * separate call either way (`prompts/agents/group.md` in agent mode, folded
   * into the understand answer in call mode).
   */
  discovery?: "call" | "agent";
  /**
   * Ask a model, in batches of sixty and from search metadata alone, which
   * hosts are worth a fetch and a judgement at all — before either is spent.
   *
   * A FLAG, NOT A MIGRATION, on the `discovery` precedent — and the A/B it was
   * gated on has now run and survived: 123 of 926 hosts skipped unfetched on
   * the cursor.com run, for ~$0.02 of triage calls, roughly time-neutral once
   * the fetches and classify calls it buys back are counted. DEFAULT ON since
   * 2026-08-22; `false` (or `OPENKB_TRIAGE=0` at the CLI) still turns it off.
   *
   * Triage may only SKIP, never place: a skipped host becomes a `noise`/`none`
   * entity carrying `settledBy: "triage"` and the model's one-line reason, so
   * the run still records what it declined to judge and why. Every failure
   * fails OPEN — an unanswered batch, an unanswered host, a verdict for a host
   * that was never asked about — all of it goes to the judge unfiltered. And a
   * host that `TRIAGE_KEEP_SEENIN`-many distinct queries returned is exempt
   * from skipping in code: that many roads into one host is the search itself
   * saying the market keeps bringing it up, and a snippet does not outrank it.
   */
  triage?: boolean;
  /**
   * Spend one more free direct fetch on each host the judge left `unknown`,
   * on a page the search itself surfaced for it (`topHit`, the first hit's
   * URL — often a docs, pricing or comparison page deeper than the front
   * page the judge read), and re-ask the SAME classify question against it.
   *
   * A FLAG, NOT A MIGRATION, on the `discovery`/`triage` precedent — and the
   * A/B it was gated on has now run and survived: it rescued 12 of 23 and 13
   * of 22 unplaced hosts across two runs, for ~$0.005. DEFAULT ON since
   * 2026-08-22; `false` (or `OPENKB_SECOND_LOOK=0` at the CLI) still turns it
   * off.
   *
   * Rescue is the only power this stage has, and every failure fails OPEN: a
   * fetch that cannot be read, a call that fails or times out, a verdict that
   * still says `unknown`/`none`, or one whose quotes do not verify against
   * the page it read — all of it changes nothing, and the first judgement
   * stands. Capped at SECOND_LOOK_CAP hosts.
   *
   * A direct fetch that comes back blocked earns ONE unlocker retry — the
   * rank phase's own escalation (`unlockSeenIn`/`OPENKB_RANK_UNLOCK` in
   * judge.ts), re-asked here rather than reinvented — but only for a host
   * that already earned its place twice over: `seenIn>=2` or `bestRank<=5`.
   * About half of a real run's second looks landed on a page that was ALSO
   * walled, the same door the judge's front page already hit, and paying to
   * knock on it again is only worth it for a host the search corroborated.
   * Bounded at SECOND_LOOK_UNLOCK_BUDGET escalations per run.
   */
  secondLook?: boolean;
  /**
   * Ask a model, batched and from stored evidence alone, whether a host the
   * first pass judged `relation: "none"` really has no place on the map —
   * before the entity ships dropped for good.
   *
   * A FLAG, NOT A MIGRATION, on the `triage`/`secondLook` precedent: the case
   * for it is the same shape as theirs — a single model, one pass, one page,
   * decided a host has nothing to do with this market, and that verdict never
   * gets a second opinion. Unlike `secondLook`, this stage does not re-fetch:
   * the candidate's own `what`/`why`/`roads` — everything the first pass
   * already established from the page — is what it is asked to reconsider,
   * because that IS the page's content, already read once and paid for.
   *
   * UNLIKE `triage`/`secondLook`/`listicleHarvest`, THIS ONE STAYS OFF BY
   * DEFAULT. Its own A/B ran alongside theirs and did not survive it: 0 of
   * 12, 0 of 27 and 5 of 29 rescued across three runs — it rarely changes
   * anything, so the case to default it on is not made yet. `true` (or
   * `OPENKB_DROP_CONFIRM=1` at the CLI) still turns it on.
   *
   * Only model-settled `none` verdicts qualify (`settledBy === "model"`) —
   * never a predicate settlement (an unreadable host has no `what`/`why` to
   * reconsider) and never a triage skip (that host's page was never read at
   * all, so there is nothing here to give a second look). Sequenced AFTER
   * `secondLook`, deliberately: a rescue there can already move a host off
   * `none`, and asking about a host twice in the same run is two calls
   * answering one question.
   *
   * FAIL OPEN, the same three ways `secondLook` does: an unanswered batch, a
   * thrown call, or a host the model's answer never mentions all leave the
   * original verdict standing — the entity ships exactly as the first pass
   * left it. Capped at DROP_CONFIRM_CAP hosts, batched like the link phase.
   */
  dropConfirm?: boolean;
  /**
   * After the search phase, scan every hit's title and description for a
   * roundup-shaped row — "10 best X", "X alternatives", "X vs Y", a
   * comparison post — and ask a model, once, to pull out the vendor names
   * those rows mention that this run never searched for. Each fresh name is
   * dealt a small hand through `rivalHand` (`@open-kb/core/families`) — the
   * SAME machinery a name the anchor's own sitemap publishes already gets —
   * and those queries fire through the run's ordinary search path.
   *
   * A FLAG, NOT A MIGRATION, on the `triage`/`secondLook`/`dropConfirm`
   * precedent — and the A/B it was gated on has now run and survived: a real
   * cursor.com run found Windsurf, Zed, Tabnine, Codeium, Aider and Continue
   * with ZERO direct SERP hits — every one of them existed only inside
   * another hit's title or description, unextracted, because the search
   * phase follows `hit.url` and reads no further — and grundfos.com surfaced
   * 18 real pump vendors the same way, for one model call at ~4s and
   * ~$0.0003. DEFAULT ON since 2026-08-22; `false` (or
   * `OPENKB_LISTICLE_HARVEST=0` at the CLI) still turns it off.
   *
   * ADDITIVE ONLY: this stage only ever ADDS queries on top of what the plan
   * already bought, and every failure fails open — a call that throws or
   * finds nothing leaves the map exactly as the search phase built it.
   */
  listicleHarvest?: boolean;
  /** Bounds the model's per-product debranded ask (clamped to 2-3 regardless of
   *  a larger value here; the floor of 2 is not configurable). Templates cover
   *  plain and branded and are not affected — this only trims how many
   *  model-written debranded queries a product's opening hand carries. */
  perProduct?: number;
  /** What this deployment may spend, in total, cumulative since deploy — not a
   *  per-run figure. Read by the caller (the web route) from the provider's own
   *  usage and passed through so `report.cost.ceilingUsd` can say honestly
   *  whether a ceiling was in force, rather than always claiming there is none.
   *  Left unset on the CLI, which has no deployment-wide ceiling to report. */
  ceilingUsd?: number | null;
  /** The CLI's console. Left unset in the browser, where the span stream is the
   *  only output. */
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

/** The five stage names the UI's rail knows. Emitting anything else freezes it
 *  on the stage before, so the mapping is a name, not a free-text label. */
export type Phase = "understand" | "plan" | "sweep" | "rank" | "link" | "write";

/** Does this name exist at all? A DNS lookup is free, instant, and definitive —
 *  the one check that can tell a typo apart from a bad minute. */
async function resolves(host: string): Promise<boolean> {
  try {
    const { lookup } = await import("node:dns/promises");
    await lookup(host);
    return true;
  } catch {
    return false;
  }
}

/** A typo is nearly always a doubled or transposed letter in the TLD, so the
 *  useful reply is a concrete alternative rather than "check your spelling". */
function suggest(host: string): string {
  const parts = host.split(".");
  const tld = parts.at(-1) ?? "";
  const fixes = new Set<string>();
  for (const good of ["com", "io", "ai", "dev", "app", "co", "net", "org"]) {
    // one character away: a doubled letter, a missing one, or two swapped
    if (tld === good) continue;
    if (tld.replace(/(.)\1/, "$1") === good) fixes.add(good);
    if (tld.length === good.length + 1 && tld.includes(good)) fixes.add(good);
  }
  const alt = [...fixes][0];
  return alt ? `Did you mean ${[...parts.slice(0, -1), alt].join(".")}?` : "";
}

/**
 * The rank phase's line for the live reading panel, one per judged host.
 *
 * The batch classifier emitted exactly this per kept entity —
 * `${domain} — ${kind}/${relation}: ${why}` — and the per-host rewrite dropped
 * it, so the panel went silent through the longest phase of the run. Restored
 * per entity as each judgement lands: model-judged hosts arrive about one a
 * second, predicate-settled ones in a burst at the start, and one frame each
 * is the same volume the panel already absorbed per batch.
 *
 * Predicate-settled hosts are included, wearing their `because`. Chosen to
 * match both the history and the neighbouring frame: the batch era showed
 * every kept classification (the predicate concept did not exist to filter
 * on), and the `ranked` results frame built beside this line already streams
 * predicate-settled entities with `because ?? why` — the reading panel saying
 * less than the findings table would be two surfaces disagreeing about the
 * same event. Noise stays off the panel, as it always was.
 *
 * The model's name rides ahead of the domain when it gave one; a predicate
 * settlement has no name beyond its host, and prints as the host alone.
 */
/**
 * Is this host on the map, or did the judge just tell us it is not in this market?
 *
 * TWO FIELDS WERE SAYING THE SAME THING AND ONLY ONE WAS BELIEVED. `noise` is a
 * kind and `none` is a relation, and both mean "this host has nothing to do
 * with the anchor's market" — the prompt describes noise as the kind that
 * leaves the map and none as the relation that costs an entity its edge. In
 * practice the model reaches for the relation, because "how does this stand to
 * the anchor" is exactly the question and the honest answer is "it does not".
 *
 * MEASURED on figma.com: 28 hosts were called noise and left; 392 were given
 * `relation: none` and stayed. Same verdict, opposite outcome, decided by which
 * field the model happened to use. Across nine runs it is 2,776 rows, 17% of
 * every map.
 *
 * They are not borderline. Sampled from that run: Temporal (durable execution),
 * Setapp (Mac app subscriptions), Sessionize (conference management), Redokun
 * (document translation). The model got every one of them right and said so in
 * the `why` — "not a collaborative interface design", "a different market" —
 * and the map kept them anyway, padding its own size by a sixth with companies
 * from other markets.
 *
 * NOT `unknown`, which is the other empty-looking relation and stays. That one
 * means the page did not support a relation, not that there is none to support;
 * the host was found and half of those rows are named by other pages in the run
 * (1,214 of 2,439 appear in an edge). Refusing to place a host is not the same
 * as placing it outside.
 */
export function onMap(e: { kind: string; relation: string }): boolean {
  return e.kind !== "noise" && e.relation !== "none";
}

export function rankThinkLine(e: Judged): string | null {
  if (e.kind === "noise") return null;
  const head =
    e.name && e.name !== e.domain ? `${e.name} (${e.domain})` : e.domain;
  const reason = e.because ?? e.why;
  return `${head} — ${e.kind}/${e.relation}${reason ? `: ${reason}` : ""}`;
}

/**
 * A pool, not a barrier — the same fix the SEARCH phase already made (see the
 * "topping up as it goes" comment above `runOne`), now applied to the LINK
 * phase's two dispatch sites (pair batches and orphan batches).
 *
 * Both used to chunk their batches into groups of `LINK_CONC` and
 * `await Promise.all` each group before starting the next — a barrier per
 * group, costing that group its slowest member while finished workers idled.
 * Link is 43% of a measured run's wall time (12.3 of 28.5 minutes on
 * runs/sweep-cursor-com-20260821105321.json), the largest single phase, which
 * is exactly the shape the search phase's own chunked-dispatch fix was
 * written to describe. This is that fix, generalised: each worker takes the
 * next item the moment it frees up, so one slow batch delays only itself.
 * Same concurrency, same batch size, no barrier.
 */
export async function runPool<T>(
  items: T[],
  conc: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(conc, items.length) }, worker),
  );
}

export async function sweep(opts: SweepOptions): Promise<SweepResult> {
  const {
    domain: rawDomain,
    spans,
    creds,
    model,
    modelId = "model",
    runId = "run",
    // Omitted, the price is looked up from the id we were actually given.
    // It used to fall back to a fixed conservative row, which meant a caller
    // who named a model but left pricing unset was billed as if it were the
    // dearest one on the table. An unnamed model still lands on that row —
    // "model" is in no table — so the honest-pessimism default is intact.
    pricing = priceForModel(modelId),
    onLog,
    signal,
  } = opts;
  /**
   * The anchor, as a HOST and nothing else. The CLI hands over argv raw, and
   * `www.stripe.com` ran fine — the site resolves — while the anchor-name ban
   * silently tested the word "www" instead of the brand, so every accidental
   * anchor-naming query was bought for nothing. A scheme or a path fails the
   * same way. The web route normalizes on its own; the engine cannot depend on
   * every caller remembering to.
   */
  const anchor = rawDomain
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  // One renderer per run: templates composed on first use, rendered per call.
  // The prompts on disk cannot change mid-run, and the per-host classify call
  // used to recompose them inside the rank pool for every residue host.
  const prompt = makePrompt();
  const target = Math.max(1, Math.floor(opts.queries ?? 40));
  /**
   * How many queries may be in flight. RAISING IT DOES NOT MAKE THE SEARCH
   * FASTER, and that is measured rather than assumed.
   *
   * The search phase is the biggest block in a run — 613 of cloudflare's
   * 1,332 seconds, 54%, per `report.phases` — so it is the obvious place to
   * look for speed. The measurement says the width is not where it is.
   *
   * WHAT IS ESTABLISHED. On a run dispatched 32 wide, 32 workers really do
   * start (`Array.from({ length: CONC }, worker)`), the queue holds all 598
   * planned queries from the first tick so no worker starves, and the phase
   * still moved 408 billable requests in 613 seconds — 0.67 per second,
   * against 64 page-fetches nominally in flight. Whatever bounds it is not
   * this constant.
   *
   * WHAT IS NOT ESTABLISHED, and I first wrote here that it was: that the
   * bound is the port's own `pace()`. It is not, on this run. `pace()` only
   * bites once a response matches `THROTTLED` in the Bright Data port, and
   * none of this run's refusals do — they are "redirect location was
   * rejected", "response body was rejected", "No ready cookies", "recently
   * failed and cannot be attempted". So `minGapMs` stayed 0 and the pacing
   * explanation was an arithmetic story fitted to the gap, not a reading of
   * it. The bound is upstream of this process and invisible from here.
   *
   * WHICH IS WHY `report.serp.paced` MATTERS more than the number it usually
   * shows. A slow search with `paced.queries` at 0 is a ceiling somewhere in
   * the provider; a slow search with it high is one this client applied to
   * itself. Until f598a85 there was no way to tell those apart, which is
   * exactly how the wrong explanation survived being written down.
   *
   * A TEMPTING FIX THAT THE DATA DOES NOT SUPPORT: that firing 32 at once
   * trips a throttle the run then pays for all the way through, so opening
   * narrower would finish sooner. If that were happening the refusals would
   * be front-loaded. They are not — across three runs on two anchors the
   * slow-query count per fifth of the run runs 6/5/5/5/5, 3/5/9/8/3 and
   * 3/3/4/2/5, and the median query time is flat throughout. Whatever the
   * limit is, the run meets it at the first query and not because of the
   * burst.
   *
   * So this stays where it is, and a slow search is a fact about the account
   * rather than a setting to turn up.
   */
  const CONC = Math.max(1, Math.floor(opts.concurrency ?? 20));
  const BATCH = Math.max(1, Math.floor(opts.batchSize ?? 40));

  /** Every query's opening depth — see `SweepOptions.pages`. A flat depth
   *  bought a fixed number of pages for every query in a market regardless of
   *  whether the second page was still finding new hosts or just repeating
   *  the first — the same page count for a thin market and a crowded one.
   *  Lowered from 3 so a query opens cheap by default; `DEEP_PAGES` below is
   *  where the third-and-fourth page goes instead, spent only on the products
   *  `assess` has real per-page-yield evidence for (see the `deepen` field on
   *  its verdict and `depthByProduct` further down). */
  const SHALLOW_PAGES = Math.max(1, Math.floor(opts.pages ?? 2));
  /** The depth a product earns once `assess` names it — see
   *  `SweepOptions.deepPages`. */
  const DEEP_PAGES = Math.max(
    SHALLOW_PAGES,
    Math.floor(opts.deepPages ?? 4),
  );
  /** How many times the run may look at what it has and ask for more. A ceiling,
   *  not a target, most runs stop earlier because the model says enough. */
  // 8, raised from 4: on the measured run the wave ceiling was the binding
  // stop while the yield floor it defers to was 15x clear — MIN_NEW_HOSTS is
  // the stop that was written to do this job, so the ceiling backs off to
  // backstop distance and lets it.
  const MAX_WAVES = Math.max(1, Math.floor(opts.maxWaves ?? 8));
  /** See SweepOptions.minWaves — 0 keeps the model's own judgement. */
  const MIN_WAVES = Math.max(0, Math.floor(opts.minWaves ?? 0));
  /** A wave adding fewer new hosts than this is reaching ground already covered.
   *  The harness's backstop for a model that keeps asking while learning nothing. */
  const MIN_NEW_HOSTS = Math.max(1, Math.floor(opts.minNewHosts ?? 8));
  /** How many co-occurring pairs to ask a model about. Bounds the linking
   *  stage's cost, and is applied to what is left AFTER the free naming pass
   *  has answered what it can — a cap on paid questions, not on the pairs the
   *  selector found. */
  const MAX_PAIRS =
    opts.maxPairs !== undefined ? Math.max(0, Math.floor(opts.maxPairs)) : null;
  /** Most queries any single product may take. */
  const PER_PRODUCT = Math.max(1, Math.floor(opts.perProduct ?? 5));
  /** How many of the company's own product pages to read. */
  const PRODUCT_PAGES = Math.max(0, Math.floor(opts.productPages ?? 25));
  /** See SweepOptions.platformScope. */
  const PLATFORM_SCOPE = Math.max(0, Math.floor(opts.platformScope ?? 0));
  /**
   * See SweepOptions.maxHosts.
   *
   * A SIZE CHOICE, NOT AN EXHAUSTION POINT, and worth knowing which before
   * anyone moves it. On a large anchor this is the binding stop on the whole
   * search — shopify.com planned 373 queries and fired 147 before the ceiling
   * ended it — so the natural question is whether the queries it cut were
   * still buying anything. Measured on the runs, they were.
   *
   * New hosts per query, by position in the fired order (shopify, 147 fired):
   *
   *   1-25   12.8    26-50   8.7    51-75   8.6
   *   76-100  6.5   101-125  7.2   126-147  8.0
   *
   * The yield drops once early and then PLATEAUS — the last bucket buys as
   * much as the fifth. And the late hosts are not worse hosts. Share that
   * turn out to be market entities, by the query bucket that first surfaced
   * them, over three runs on two anchors:
   *
   *   shopify   77  77  73  68  75
   *   shopify   82  75  80  69  51
   *   openai    66  66  64  66  69
   *
   * Flat on two of three. So the search is not stopped because it stopped
   * finding things; it is stopped because the run has as many hosts as it
   * intends to pay to judge. That is a legitimate thing to stop on — every
   * host past this one costs a classify call and clock — but it means the
   * number is a budget, and "~900 is where the returns die" would be false.
   *
   * NOT CHANGED HERE, deliberately. Raising it roughly doubles the judging
   * this run does, which is most of its cost and minutes, in exchange for a
   * longer tail on a map that already keeps over a thousand entities. That is
   * a product call about how big a map should be and what it may cost, and
   * the measurement above is what it should be made on.
   */
  const HOST_CEILING = Math.max(50, Math.floor(opts.maxHosts ?? 900));
  /** The rank pool's actual width, read once and used both to run the pool
   *  and to price it — the clock's coefficient was measured at width 8, and a
   *  deployment ranking at 24 was reserving 3x the rank it needed. */
  const RANK_CONC = Math.max(
    1,
    Math.floor(Number(process.env.OPENKB_RANK_CONCURRENCY ?? 8) || 8),
  );
  /** The whole run's query ceiling, or null for "as many as the map wants" —
   *  which is every CLI run. See `SweepOptions.maxQueries`. */
  const QUERY_CEILING =
    opts.maxQueries === undefined
      ? null
      : Math.max(1, Math.floor(opts.maxQueries));
  /** The instant this run has to be over, or null for "no clock". */
  const DEADLINE = opts.deadlineAt ?? null;
  /** How much clock is left, in seconds. `Infinity` when nobody set a deadline,
   *  so every comparison below reads as "there is time" without a null check at
   *  each site. Goes negative once the deadline is past, which is a real state
   *  the comparisons need — `leftS()` is the one for prose. */
  const secondsLeft = () =>
    DEADLINE === null ? Infinity : (DEADLINE - Date.now()) / 1000;
  /** The same number, floored at zero and rounded, for a sentence. "-4s are
   *  left" is arithmetic leaking into a line meant for a person. */
  const leftS = () => Math.max(0, Math.round(secondsLeft()));
  /** What the run still owes after the last host is judged: the link batches
   *  and the write. Reserved out of the clock rather than discovered at the end
   *  of it — a map that is not written down is a map nobody has. */
  const TAIL_SECONDS = MEASURED_PHASE_COSTS.tailSeconds;
  // Unset is the production path, and it is the same expression it has always
  // been — see `SweepOptions.ports` for why the override is a pair and not
  // two independent fields. Two port instances now instead of one, because a
  // query fired for a deepened product must read four pages and every other
  // query must still read two: when `opts.ports` IS set (every test in this
  // package) both branches short-circuit to the SAME injected port, so which
  // one `runOne` picks changes nothing a fixture can see — only a real,
  // uninjected caller ever builds two distinct Bright Data ports here.
  const searchAt = {
    shallow: opts.ports?.search ?? brightDataSearch(creds, { pages: SHALLOW_PAGES }),
    deep: opts.ports?.search ?? brightDataSearch(creds, { pages: DEEP_PAGES }),
  };
  const fetcher = opts.ports?.fetch ?? brightDataFetch(creds);
  /** Which depth a product's queries fire at, updated only by `assess`'s
   *  `deepen` verdict (see the widening loop below). Absent means shallow —
   *  every product opens here, and only ones named from real page-2 yield
   *  move to `"deep"`, never back. */
  const depthByProduct = new Map<string, "shallow" | "deep">();

  const t0 = Date.now();
  const sec = () => Math.round((Date.now() - t0) / 1000);
  const el = () => String(sec()).padStart(3);
  let tokIn = 0;
  let tokOut = 0;
  let tokReasoning = 0;
  /** Model calls by the upstream host that served them, with the refusals
   *  among them — an answer that was empty, unparseable or off-schema. The
   *  gateway routes one model id across ~30 hosts of very different
   *  discipline (see `openrouterOpts`), and this is the only way a run can
   *  say which one kept refusing. `report.model.servedBy`. */
  const servedBy: Record<string, { calls: number; refused: number }> = {};
  /** The host that answered this run's first call, and every call after it —
   *  argued at `openrouterOpts`. Null until the first answer names one. */
  let stickyHost: string | null = null;
  const hostOf = (x: unknown): string | undefined => {
    const meta = (x as { providerMetadata?: { openrouter?: { provider?: unknown } } })
      ?.providerMetadata?.openrouter?.provider;
    if (typeof meta === "string" && meta) return meta;
    // A refused call still names its host: the AI SDK keeps the gateway's
    // response body on the error, and the gateway puts `provider` in it.
    const body = (x as { response?: { body?: { provider?: unknown } } })?.response?.body;
    return typeof body?.provider === "string" && body.provider ? body.provider : undefined;
  };
  const noteServed = (host: string | undefined, refused: boolean) => {
    const key = host ?? "(unnamed)";
    const row = (servedBy[key] ??= { calls: 0, refused: 0 });
    row.calls += 1;
    if (refused) row.refused += 1;
  };
  let serpCalls = 0;
  let unlockerCalls = 0;

  /** The itemised bill, accumulated as the run spends rather than reconstructed
   *  from the trace afterwards, the trace is capped for display and a
   *  reconstruction from it would quietly under-report a wide sweep. */
  interface Line {
    label: string;
    calls: number;
    failures: number;
    usd: number;
    ms: number;
    /** Model lines only; zero on serp/fetch lines. Kept per agent so "which
     *  agent spends the tokens" is a fact the report states rather than
     *  arithmetic someone re-derives from the span log after the fact. */
    tokIn: number;
    tokOut: number;
    tokReasoning: number;
  }
  const byKind = new Map<string, Line>();
  const byAgent = new Map<string, Line>();
  const bill = (
    kind: string,
    agent: string,
    usd: number,
    ms: number,
    ok: boolean,
    tok?: { in: number; out: number; reasoning: number },
  ) => {
    for (const [m, label] of [
      [byKind, kind],
      [byAgent, agent],
    ] as const) {
      const cur = m.get(label) ?? {
        label,
        calls: 0,
        failures: 0,
        usd: 0,
        ms: 0,
        tokIn: 0,
        tokOut: 0,
        tokReasoning: 0,
      };
      cur.calls += 1;
      if (!ok) cur.failures += 1;
      cur.usd += usd;
      cur.ms += ms;
      if (tok) {
        cur.tokIn += tok.in;
        cur.tokOut += tok.out;
        cur.tokReasoning += tok.reasoning;
      }
      m.set(label, cur);
    }
  };
  const lines = (m: Map<string, Line>) =>
    [...m.values()].sort((a, b) => b.usd - a.usd);

  /**
   * WHERE THE MINUTES WENT, per rail — the one thing the report could not say.
   *
   * `report.seconds` is the total and `cost.byKind[].ms` is BILLED time, which
   * on a 30-minute cloudflare run summed to 85 minutes of concurrent model
   * calls. Neither answers "which phase was slow", so the only way to find out
   * was to diff the timestamps in a terminal log — and when I did it from
   * memory instead, I blamed the second look for eleven minutes it did not
   * spend. It spent 73 seconds; `understand` spent 362.
   *
   * FIRST AND LAST NARRATION ON EACH RAIL, which is an honest approximation
   * and not a claim of exclusive occupancy. The pipeline is mostly sequential
   * — understand, then sweep, then rank, then link — so the spans line up with
   * the phases, but a stage that narrates late (the listicle harvest talks on
   * the sweep rail while the fold has already begun) can overlap the next.
   * Read them as "this rail was active from here to here", which is the
   * question a slow run actually raises.
   */
  const railClock: Record<string, { firstSec: number; lastSec: number; lines: number }> = {};
  const say = (agent: Phase, message: string) => {
    const at = sec();
    const c = railClock[agent];
    if (c) {
      c.lastSec = at;
      c.lines += 1;
    } else {
      railClock[agent] = { firstSec: at, lastSec: at, lines: 1 };
    }
    onLog?.(`${el()}s  ${message}`);
    emitUi(spans, runId, "progress", agent, {
      round: 1,
      agent,
      message,
      atSec: sec(),
    });
  };
  /** The model's own words, verbatim, to the panel that reads along. Not a
   *  paraphrase written here, the point is to show what came back. */
  const think = (agent: Phase, text: string) => {
    emitUi(spans, runId, "agent", agent, {
      type: "text-delta",
      delta: `${text}\n`,
    });
  };
  const emitResult = (agent: Phase, frame: Record<string, unknown>) => {
    emitUi(spans, runId, "results", agent, frame);
  };

  const usdFor = (inTok: number, outTok: number) =>
    (inTok / 1e6) * pricing.inUsdPerM + (outTok / 1e6) * pricing.outUsdPerM;

  /**
   * One model call, accounted and traced.
   *
   * `think` controls reasoning, and it is the single biggest lever on the bill.
   * Output is priced six times input and is 90% of the model cost, and on one
   * 642-entity run the classification stage emitted about 160,000 output tokens
   * while the entities it produced account for roughly 35,000. The rest is the
   * model thinking out loud, billed at the output rate, thrown away unread.
   *
   * Thinking earns that on the stages where the answer is a judgement: what a
   * company sells, which markets its products fall into, whether a map is done.
   * It earns nothing on the stages where the answer is a label drawn from a
   * fixed vocabulary, which is what classification and linking are.
   *
   * `maxOutputTokens` is set for a second reason. The default is 65,536 and
   * OpenRouter reserves credit for the full amount up front, so a key with a
   * dollar of headroom is refused a call that would have cost two cents.
   *
   * `usage` is optional on the AI SDK's result, and a missing count must read as
   * zero tokens rather than as a non-finite price the stream flags as a failure.
   */
  async function call<T extends z.ZodType>(
    // `"triage"`, `"second-look"`, `"drop-confirm"` and `"listicle"` ride
    // beside the rail's five: billing/span labels, not stages — their
    // narration goes out as `say("sweep"/"rank", …)` so the rail never sees a
    // name it does not know, while the bill's byAgent line and the span log
    // still say which calls were whose.
    agent: Phase | "triage" | "second-look" | "drop-confirm" | "listicle",
    label: string,
    schema: T,
    prompt: string,
    opts: {
      think?: "none" | "low" | "medium";
      maxOutputTokens?: number;
      /** Choose the upstream host by this criterion instead of sticking to
       *  the run's host. Only `understand` uses it — see `understandByCall`,
       *  which deliberately spreads its asks across hosts that disagree. */
      sort?: "throughput" | "latency" | "price";
      /**
       * Let a TIMEOUT stand rather than buying a second one.
       *
       * The retry below is worth its price for a schema miss — that fails in
       * seconds and usually succeeds on the second try with more room. A
       * timeout is a different animal: it costs the FULL ceiling again, on
       * the route that just proved too slow, and for `understand` that is
       * 180 seconds twice.
       *
       * MEASURED on cloudflare.com, where the phase reported "no answer in
       * 180s, retrying once" at 182s and finished at 362s — six minutes of a
       * thirty-minute run, spent on one ask while the other two sat already
       * answered behind `Promise.all`. shopify.com hit the same 182s line.
       *
       * Only a caller that can survive the loss should pass this, which is
       * why it is opt-in rather than the default: `understandByCall` asks
       * three times and keeps the middle, and its even-count rule was made
       * deliberate for exactly the case where one ask is missing. If all
       * three are lost it still falls back to a single retrying ask, so the
       * safety net is one layer down rather than gone.
       *
       * VALIDATED on the anchor that motivated it, cloudflare.com, which
       * times out one ask on both runs:
       *
       *   before   182s  no answer in 180s, retrying once
       *            362s  read it 2 times — 67, 67 products
       *   after    184s  no answer in 180s, and the other asks answer for it
       *            184s  read it 2 times — 67, 67 products
       *
       * 362s to 184s, and the SAME decomposition either way — 67 products
       * both times — so the three minutes bought a third opinion that would
       * not have changed the answer. That is the whole case for the flag, and
       * it is falsifiable rather than statistical: the phase either waits for
       * the retry or it does not.
       */
      acceptTimeout?: boolean;
    } = {},
  ): Promise<z.infer<T>> {
    const started = Date.now();

    /**
     * One retry, with room to think and less thinking to do.
     *
     * A model can spend its whole output budget reasoning and return nothing:
     * finishReason "other", no object, and the AI SDK throws
     * AI_NoObjectGeneratedError. That killed a run at its third assess call,
     * discarding 71 hosts and everything already paid for to reach them.
     *
     * A run that has spent money is not something to end over one bad response.
     * The retry doubles the ceiling and drops the effort, which attacks the
     * cause from both sides, and it happens once: a second failure is a real
     * one and should surface.
     */
    /* Reasoning is model-family business. Gemini refuses `enabled: false`
     * ("Reasoning is mandatory for this endpoint"), so `none` maps to the
     * minimal effort floor. DeepSeek honours the off switch — and treats
     * "minimal" as "reason a little", which measured at 471 hidden tokens
     * eating the whole answer budget: 11.1s and a truncated reply against
     * 4.9s clean with reasoning off. `none` must mean none where it can. */
    /* DeepSeek gets reasoning off at EVERY level, not only classify: the
     * probe showed think:"low" understand and assess calls stalling the same
     * way (budget eaten in secret, empty answer, retry). This pipeline's
     * thinking lives in the doctrine text, not in model rumination — a family
     * that honours the off switch runs it with the switch off. */
    const reasoningFor = (
      think: string | undefined,
    ): { enabled: false } | { effort: string } | { max_tokens: number } =>
      modelId.startsWith("deepseek/")
        ? process.env.OPENKB_DEEPSEEK_REASONING === "bounded"
          ? // The bake-off's contestant: a thinking allowance that cannot eat
            // the answer. Exists to be measured against off, not to be chosen
            // by argument.
            { max_tokens: 200 }
          : { enabled: false }
        : { effort: think === "none" ? "minimal" : (think ?? "low") };

    /* DeepSeek routes across 23 providers of very different speeds. This
     * used to PIN an order — parasail, novita, siliconflow — measured once at
     * 1.3s on Parasail against 6.3s on the default pick. The fast host then is
     * the slow host now: re-measured 2026-08-23 on a 60-row triage call,
     * Parasail took 28.6 / 34.7 / 31.3s where OpenRouter's own throughput
     * sort (Reka that day) took 10.0 / 9.5 / 13.0s, and 3.4 / 2.8s against
     * 1.9 / 2.8s on a one-host classify. A pinned order is a measurement
     * that goes stale; the sort is the provider re-measuring at every call.
     * runs/sweep-cursor-com-20260823064255.json is what the stale pin cost:
     * triage at 66s a call, and an 8% empty-answer rate on the judge.
     * Single-provider families are unaffected by the sort, so it only rides
     * where it was measured to matter. */
    const openrouterOpts = (
      think: string | undefined,
      // The retry changes the route. A host that answered nothing, or
      // answered with a body that would not parse, is the wrong host to ask
      // the same question twice; sorting by latency instead of sticking lands
      // on a different one, which is the cheapest way to make the second ask a
      // different ask. Everything else below holds for both attempts.
      routed = true,
    ) => ({
      reasoning: reasoningFor(think),
      ...(modelId.startsWith("deepseek/")
        ? {
            provider: {
              /**
               * ONE HOST FOR THE WHOLE RUN, discovered rather than hardcoded.
               *
               * `sort: "throughput"` re-picks per call, and a gateway serves
               * one model id from ~30 hosts at fp4, fp8 and bf16. The map then
               * disagrees with itself: MEASURED 2026-08-23 by asking the same
               * 27 pages the identical classify question three times over —
               *
               *   throughput sort, temperature unset   12 of 27 unstable (44%)
               *   throughput sort, temperature 0       12 of 27 unstable (44%)
               *   one pinned host, temperature unset    9 of 27 unstable (33%)
               *   one pinned host, temperature 0        3 of 27 unstable (11%)
               *
               * — where "unstable" means the same host got a different
               * `relation` across three identical asks. Nearly half the map's
               * relations were a coin flip, and temperature alone could not
               * fix it because the hosts disagree with each other.
               *
               * A HARDCODED pin is what this file already learned not to do
               * (see the parasail order removed this morning: fast when it was
               * written, 3x slower when it was measured again). So the pin is
               * per RUN: the first call goes out on the throughput sort, and
               * whichever host answers it is `stickyHost` for every call
               * after. Fresh every run, stable within one. `allow_fallbacks`
               * stays open, so a host going down degrades to another rather
               * than failing the run — and `report.model.servedBy` records
               * what actually answered, which is how a bad sticky host is
               * caught rather than assumed away.
               */
              ...(opts.sort
                ? // An explicit criterion outranks the run's host: the caller
                  // is asking for a DIFFERENT host on purpose.
                  { sort: opts.sort }
                : routed && stickyHost
                  ? { order: [stickyHost] }
                  : { sort: routed ? "throughput" : "latency" }),
              // Only hosts that support every parameter this request carries
              // — `response_format: json_schema` above all. The run on
              // 2026-08-23 (run D) had its catalog retry answered by a host
              // without it: the JSON came back inside a markdown fence.
              require_parameters: true,
              // Hosts MEASURED to stray from the schema they were handed.
              // Benched on the real catalog call, six asks each, same day:
              // Baidu 3 of 6 valid (truncated text, enum strays) while Reka,
              // SiliconFlow, Morph, DeepInfra, Parasail, AkashML and Decart
              // were 6 of 6. Baidu was the throughput leader that day, which
              // is what turned the sort into 25 refused classify calls and
              // 18 of 23 refused link batches on run C. An ignore list goes
              // stale like the old pinned order did — `report.model.servedBy`
              // now tallies calls and refusals per host on every run, so the
              // next bad host is read off the run file, not re-benched.
              ignore: MODEL_HOST_IGNORE,
            },
          }
        : {}),
    });

    /**
     * TEMPERATURE ZERO, on every call this pipeline makes.
     *
     * It was never set, so every call ran at whatever the host defaults to —
     * ~1.0 on an OpenAI-compatible endpoint. Nothing here wants a sampled
     * answer: each call is a judgement about a page, and two runs of the same
     * map disagreeing is a defect, not variety. Worth 33% -> 11% instability
     * on the measurement above, on top of the sticky host.
     */

    /**
     * A DEADLINE PER CALL, not just the run's cancel signal.
     *
     * `signal` is the run's own AbortController — it fires when a visitor
     * closes the tab or the host's clock runs out. It is not a timeout, so a
     * model call that never answers is a run that never ends. Measured: a
     * figma.com sweep sat in the link phase for 13 minutes at 0.1% CPU on one
     * unanswered call, 451 of 491 pairs done, and would have sat there until
     * something killed it. Bright Data's search and fetch have carried
     * `AbortSignal.timeout` all along; the model calls never did.
     *
     * It matters most where nobody is watching. A batch building fifty maps
     * loses the whole batch to one hung socket, and the run that hangs has
     * already paid for everything it bought.
     *
     * TWO MINUTES, against measured call times. The slowest legitimate calls in
     * `runs/` are classify retries at 56 to 62 seconds — the doubled-ceiling
     * retry after a model returns nothing — and the catalog call ran 51 seconds
     * when it was one call instead of three. Two minutes clears the slowest
     * real call by roughly 2x and still bounds a hang to something a batch can
     * absorb.
     *
     * FRESH PER CALL, deliberately. One shared `AbortSignal.timeout` would
     * start at module load and abort every call after the first two minutes of
     * the process.
     *
     * A timeout leaves `signal.aborted` false, so the caller's own check still
     * tells a host that stopped answering apart from a visitor who left.
     *
     * `link` alone gets the shorter `LINK_CALL_TIMEOUT_MS` — argued at its own
     * declaration above — because its calls are batched, uniform, and already
     * retried once; every other agent keeps the full two minutes this comment
     * measures against.
     */
    const timeoutMs =
      agent === "link"
        ? LINK_CALL_TIMEOUT_MS
        : agent === "rank" ||
            agent === "triage" ||
            agent === "second-look" ||
            agent === "drop-confirm"
          ? RANK_CALL_TIMEOUT_MS
          : agent === "understand"
            ? UNDERSTAND_CALL_TIMEOUT_MS
            : CALL_TIMEOUT_MS;
    /**
     * THE DEADLINE HAS TO BE HELD, OR THE RUNTIME DROPS IT — `heldDeadline`
     * (deadline.ts) is the pin and carries the argument. MEASURED in the wild
     * before it was understood: runs/sweep-cursor-com-20260823064255.json
     * judged 750 of 754 hosts by 1553s and the last four by 1933s, with NOT
     * ONE "no answer in 120s" line between — a ceiling that fired would have
     * written one. The 6.3 minutes were a deadline that had been collected,
     * not one that was too long. (e2e7ba3's commit message read that tail as
     * two chained timeouts; it was wrong, and the 60s ceiling it shipped
     * would have changed nothing here on its own.)
     */
    const withDeadline = () => heldDeadline(timeoutMs, signal);

    /**
     * What went wrong, in the model's own answer — the part `e.message`
     * leaves out. "No object generated: response did not match schema" says
     * a schema was missed and not which field; the AI SDK keeps the zod
     * issues on `cause.cause.issues` and the raw text on `text`, and before
     * this both were dropped on the floor. Measured: assess failed twice on
     * each of two cursor.com runs on 2026-08-23 with that one sentence and
     * nothing to act on. The first three issues, or the head of the text
     * when there are none (an empty or truncated answer).
     */
    const detailOf = (e: unknown): string => {
      const err = e as {
        text?: unknown;
        cause?: { cause?: { issues?: Array<{ path?: Array<string | number>; message?: string }> } };
      };
      const issues = err?.cause?.cause?.issues;
      if (Array.isArray(issues) && issues.length) {
        return issues
          .slice(0, 3)
          .map((i) => `${(i.path ?? []).join(".") || "<root>"}: ${i.message ?? "invalid"}`)
          .join("; ");
      }
      if (typeof err?.text === "string" && err.text.trim()) {
        return `text: ${err.text.trim().replace(/\s+/g, " ").slice(0, 160)}`;
      }
      return "";
    };

    const attempt = async (maxOut: number, think: string | undefined, rejected?: string) =>
      generateObject({
        model,
        schema,
        // A retry that knows why the first answer was refused is a different
        // ask. The schema's enums are where a model strays under a long
        // prompt — an `intent` or `platform` it invented — and re-asking the
        // identical prompt strays the same way. The issue is appended, not
        // woven in, so the prompt-size budget (`prompts.test.ts`) is untouched.
        prompt: rejected
          ? `${prompt}\n\nYour previous answer was rejected: ${rejected}. Answer again, keeping every field to the values the schema allows.`
          : prompt,
        abortSignal: withDeadline(),
        maxOutputTokens: maxOut,
        temperature: 0,
        // `attempt` is only ever the retry: rerouted, see `openrouterOpts`.
        providerOptions: { openrouter: openrouterOpts(think, false) },
      });

    const ceiling = Math.max(6_000, opts.maxOutputTokens ?? 8_192);

    try {
      const out = await generateObject({
        model,
        schema,
        prompt,
        abortSignal: withDeadline(),
        // Floored well above the answer's own size. Reasoning is mandatory on
        // this model and is spent out of the SAME output budget, so a cap sized
        // only for the answer starves it: a 1,680-token catalog call thought
        // until the connection timed out without emitting anything. The point of
        // the cap was never to be tight, only to stop reserving 65,536 tokens of
        // credit on every call.
        maxOutputTokens: Math.max(6_000, opts.maxOutputTokens ?? 8_192),
        temperature: 0,
        providerOptions: {
          openrouter: openrouterOpts(opts.think),
        },
      });
      const inTok = out.usage?.inputTokens ?? 0;
      const outTok = out.usage?.outputTokens ?? 0;
      // Recorded so the reasoning share stops being inferred from arithmetic.
      const reasoning =
        (out.usage as { reasoningTokens?: number } | undefined)
          ?.reasoningTokens ?? 0;
      if (reasoning) tokReasoning += reasoning;
      tokIn += inTok;
      tokOut += outTok;
      bill("llm", agent, usdFor(inTok, outTok), Date.now() - started, true, { in: inTok, out: outTok, reasoning });
      const host = hostOf(out);
      // The first host to answer becomes the run's host. Set from a SUCCESS
      // only: a host that refused is not one to route the rest of the map to.
      if (!stickyHost && host) stickyHost = host;
      noteServed(host, false);
      spans.emit({
        runId,
        agentId: agent,
        parentId: null,
        kind: "model",
        name: modelId,
        argsDigest: label,
        servedBy: host,
        ms: Date.now() - started,
        ok: true,
        tokensIn: inTok,
        tokensOut: outTok,
        usd: usdFor(inTok, outTok),
      });
      return out.object as z.infer<T>;
    } catch (e) {
      // The first answer was refused or never came: charged to its host
      // before anything else happens, so the tally counts the refusal even
      // when the retry below goes on to succeed.
      noteServed(hostOf(e), true);
      const empty = (e as Error).name === "AI_NoObjectGeneratedError";
      /**
       * A DEADLINE THAT KILLS THE RUN IS WORSE THAN THE HANG IT REPLACED.
       *
       * Measured, both ways, on the same anchor. Before the deadline existed a
       * figma.com sweep sat in the link phase for 13 minutes on one unanswered
       * call. With the deadline and no retry it did not hang — it DIED, at 412
       * of 492 pairs, and threw away $1.74 of finished work. Two of every three
       * dollars this repo spent on runs today went to those two failures.
       *
       * So a call the deadline stopped is retried once, exactly like a call
       * that came back empty. The retry keeps the ORIGINAL ceiling rather than
       * doubling it: doubling is the remedy for a model that ran out of room to
       * answer, and here the model had room and took too long — more room makes
       * it slower, which is the wrong direction.
       *
       * NOT WHEN THE RUN ITSELF WAS CANCELLED. `signal.aborted` means a visitor
       * closed the tab or the host's clock ran out, and retrying that would
       * spend money nobody is waiting for. A timeout leaves the run's own
       * signal clear, which is the whole reason `withDeadline` composes the two
       * instead of replacing one with the other.
       */
      const timedOut =
        !signal?.aborted &&
        ((e as Error).name === "TimeoutError" ||
          (e as Error).name === "AbortError" ||
          /aborted due to timeout/i.test(String((e as Error).message ?? "")));
      // Triage, the second look and drop-confirm narrate on the rank rail;
      // listicle harvest narrates on the sweep rail (it runs before the host
      // fold, still inside the search phase) — the rail's five names are a
      // closed set, and all four are billing labels, not stages.
      //
      // ONE COPY, because the accepted-timeout branch below needs the same
      // answer and I first gave it a second, divergent version that sent
      // triage to "sweep". A closed set with two mappings is a closed set
      // that will disagree with itself.
      const rail =
        agent === "triage" || agent === "second-look" || agent === "drop-confirm"
          ? "rank"
          : agent === "listicle"
            ? "sweep"
            : agent;
      if (timedOut && opts.acceptTimeout) {
        say(
          rail,
          `  ${label}: no answer in ${Math.round(timeoutMs / 1000)}s, and the other asks answer for it`,
        );
        throw e;
      }
      if (empty || timedOut) {
        say(
          rail,
          timedOut
            ? `  ${label}: no answer in ${Math.round(timeoutMs / 1000)}s, retrying once`
            : `  ${label}: the model's answer was refused${detailOf(e) ? ` (${detailOf(e)})` : ""}, retrying with more room`,
        );
        try {
          const firstDetail = empty ? detailOf(e) : "";
          const out = await attempt(
            timedOut ? ceiling : ceiling * 2,
            opts.think,
            // Only a schema miss carries a hint worth sending; a timeout or an
            // empty body has nothing to quote.
            firstDetail && !firstDetail.startsWith("text:") ? firstDetail : undefined,
          );
          const inTok = out.usage?.inputTokens ?? 0;
          const outTok = out.usage?.outputTokens ?? 0;
          const reasoning =
            (out.usage as { reasoningTokens?: number } | undefined)
              ?.reasoningTokens ?? 0;
          if (reasoning) tokReasoning += reasoning;
          tokIn += inTok;
          tokOut += outTok;
          bill("llm", agent, usdFor(inTok, outTok), Date.now() - started, true, { in: inTok, out: outTok, reasoning });
          const retryHost = hostOf(out);
          // A retry can be the first answer a run ever gets (the very first
          // call failing is exactly when there is no sticky host yet), so it
          // may set one — but it never REPLACES a host already chosen, or the
          // run's route would wander every time one call needed a second ask.
          if (!stickyHost && retryHost) stickyHost = retryHost;
          noteServed(retryHost, false);
          spans.emit({
            runId,
            agentId: agent,
            parentId: null,
            kind: "model",
            name: modelId,
            argsDigest: `${label} (retried)`,
            servedBy: retryHost,
            ms: Date.now() - started,
            ok: true,
            tokensIn: inTok,
            tokensOut: outTok,
            usd: usdFor(inTok, outTok),
          });
          return out.object as z.infer<T>;
        } catch (second) {
          // Fall through and report the original — with the second failure's
          // detail beside it when it has one, since that is the answer that
          // had the hint and still missed.
          noteServed(hostOf(second), true);
          const d = detailOf(second);
          const h = hostOf(second);
          if (d && e instanceof Error) e.message = `${e.message} — retry${h ? ` (${h})` : ""}: ${d}`;
        }
      }
      bill("llm", agent, 0, Date.now() - started, false);
      const firstDetail = detailOf(e);
      spans.emit({
        runId,
        agentId: agent,
        parentId: null,
        kind: "model",
        name: modelId,
        argsDigest: label,
        servedBy: hostOf(e),
        ms: Date.now() - started,
        ok: false,
        error:
          (e instanceof Error ? e.message : String(e)) +
          (firstDetail && !(e instanceof Error && e.message.includes(firstDetail)) ? ` — ${firstDetail}` : ""),
        usd: 0,
      });
      throw e;
    }
  }

  // ── 1. read the company ──────────────────────────────────────────────────
  say("understand", `reading ${anchor}`);
  const pages: string[] = [];
  const readPages: string[] = [];
  // The anchor's own pages, raw bytes kept: the anchor's half of the alias
  // reciprocity check (alias.ts) — its hreflang/canonical assertions live in
  // markup that `condense` strips from `pages`. The candidate half arrives
  // later for free, in `judged.probePages` (a reciprocating alias page names
  // the anchor by its backlink, so the rank probe gate keeps it).
  const anchorPages: Array<{ url: string; html: string }> = [];

  const read = async (url: string, mode: "direct" | "unlocked") => {
    // The run's signal, on every fetch. The sweep checks it at its own
    // checkpoints, but a checkpoint only stops the NEXT thing; the fetch already
    // in flight kept its socket — and its unlocker charge — running until it
    // finished. Cancel and destroy were the same button precisely because the
    // paid calls never heard the cancel.
    const raw = await fetcher.get(url, mode, { signal });
    if (mode === "unlocked") unlockerCalls += 1;
    const s = sniff(raw);
    // A `.txt` URL that answers with HTML did not have the file.
    //
    // Measured: one company's /llms.txt returns 200, content-type text/html, and
    // 608KB whose title is "Page not found" for a DIFFERENT company that acquired
    // it. The sniffer sees valid HTML with plenty of text and calls it found, so
    // that whole error page would be absorbed as the company's catalog. Status
    // codes lie, content-type lies, and length says nothing; the file extension
    // is the one thing here that states what the body was supposed to be.
    const wantedText = /\.(txt|md|xml)$/i.test(new URL(url).pathname);
    const gotHtml = isHtml(raw.body, raw.contentType);
    const wrongShape = wantedText && gotHtml;
    const found = s.status === "found" && s.text.length > 300 && !wrongShape;
    bill(
      mode === "unlocked" ? "unlocker" : "fetch",
      "understand",
      raw.usd,
      raw.ms,
      found,
    );
    spans.emit({
      runId,
      agentId: "understand",
      parentId: null,
      kind: "fetch",
      name: mode === "unlocked" ? "unlocker" : "fetch",
      argsDigest: url,
      ms: raw.ms,
      ok: found,
      // `s.status` alone said "blocked" and stopped there, while the response
      // was carrying the provider's sentence explaining it. Where there is one,
      // the span says what was actually refused and by whom.
      error: found
        ? undefined
        : wrongShape
          ? "html-for-text-url"
          : raw.providerError
            ? `${s.status}: ${raw.providerError}`
            : s.status,
      usd: raw.usd,
    });
    if (found) {
      const kept = condense(s.text);
      pages.push(`--- ${url} ---\n${kept}`);
      readPages.push(url);
      anchorPages.push({ url, html: raw.body });
      say(
        "understand",
        `  ${url} -> ${s.text.length} chars${kept.length < s.text.length ? ` (condensed to ${kept.length})` : ""}`,
      );
    }
    return found;
  };

  const surfaces = [
    `https://${anchor}/llms.txt`,
    `https://docs.${anchor}/llms.txt`,
    `https://${anchor}/`,
  ];
  for (const u of surfaces) {
    await read(u, "direct");
  }

  /**
   * Read the pages where the company says what it sells.
   *
   * The index alone recovers every product and eighty-nine things that are not
   * products: 96% recall at 20% precision, measured against ground truth. The
   * pages themselves score 72%, because a url says what exists and only a page
   * says what it is. Costs one to two seconds, concurrent, and nothing at all,
   * since a direct fetch is free.
   */
  const productPages: PageFacts[] = [];
  /**
   * Rivals the anchor named in its own comparison urls — see below for why this
   * is free, and `RivalLead` in core for why a lead is not an entity.
   */
  const rivalLeads: RivalLead[] = [];
  {
    const raw = async (u: string) => {
      const r = await fetcher.get(u, "direct", { signal });
      return r.httpStatus >= 200 && r.httpStatus < 300 ? r.body : "";
    };

    let candidates = [] as ReturnType<typeof candidatesFromSitemap>;
    let xml = await raw(`https://${anchor}/sitemap.xml`);
    // A sitemap of sitemaps: follow the children, ALL of them, and read their
    // bodies as one file. Following only the first `<loc>` let alphabetical
    // order decide what a run read — on resend.com that was the blog sitemap,
    // 166 posts, zero products, zero rivals, while `/migrate/sitemap.xml` five
    // entries away named customer-io, mailchimp, mailgun, postmark and
    // sendgrid. Concurrent and direct, so eleven children cost what one did.
    if (xml && isSitemapIndex(xml)) {
      const bodies = await Promise.all(sitemapChildren(xml).map(raw));
      xml = bodies.filter(Boolean).join("\n");
    }
    if (xml) candidates = candidatesFromSitemap(xml, PRODUCT_PAGES);

    /**
     * THE SAME BYTES, READ A SECOND TIME, FOR ZERO DOLLARS.
     *
     * `candidatesFromSitemap` keeps the product urls and drops
     * `/compare`, `/vs` and `/alternatives` — right, those namespaces hold no
     * products. Until now the drop was also the end of them: every run
     * downloaded a file in which the company names its rivals in plain text and
     * threw that half away.
     *
     * MEASURED on shopify.com/sitemap.xml, fetched 2026-08-12: 838 urls, 40 in
     * those namespaces, 26 distinct rival names out of them and no false
     * positives. Of those 26, five (magento, etsy, woocommerce, wix,
     * squarespace) appear as companies nowhere in the 4,251-entity map that
     * same run produced. A second market the same day, brex.com/sitemap.xml,
     * 2,330 urls: eight names — airbase, amex, bill, concur, divvy, expensify,
     * mercury, ramp — again with nothing that is not a company.
     *
     * WHAT IT DOES NOT REACH, so nobody reads a zero as a fact about the
     * company: a sitemap INDEX is followed one child deep and only into the
     * first child (see just above), so an anchor whose comparison pages live in
     * a later child yields nothing here. figma.com and notion.so are both that
     * shape. Fixing it means fetching more sitemaps, which is a different
     * decision from this one, which is free.
     *
     * Costs one function call over bytes already in memory. No fetch, no SERP,
     * no model. What it produces is NAMES — leads to be resolved and judged
     * like any other host, never rivals to be written onto the map.
     */
    if (xml) rivalLeads.push(...rivalsFromSitemap(xml, anchor));

    // The nav ALWAYS, merged rather than used as a fallback. One company's
    // sitemap has 118 urls of which twelve are products and another's has none,
    // but the case that decided this is a product named fifteen times on the
    // homepage and zero times in a 2,976-url sitemap. A sitemap is what a site
    // wants indexed; the nav is what it wants bought.
    {
      const home = await raw(`https://${anchor}/`);
      const fromNav = candidatesFromLinks(
        home,
        `https://${anchor}/`,
        PRODUCT_PAGES,
      );
      const seen = new Set(candidates.map((c) => c.url.replace(/\/+$/, "")));
      candidates = [
        ...candidates,
        ...fromNav.filter((c) => !seen.has(c.url.replace(/\/+$/, ""))),
      ].slice(0, PRODUCT_PAGES);
    }

    if (candidates.length) {
      const read = await Promise.all(
        candidates.map(async (c) => {
          const body = await raw(c.url);
          return body ? readPageFacts(c.url, body) : null;
        }),
      );
      for (const f of dedupeFacts(
        read.filter((f): f is PageFacts => f !== null),
      ))
        productPages.push(f);
      say(
        "understand",
        `read ${productPages.length} of the company's own product pages` +
          `${candidates.length > productPages.length ? ` (${candidates.length - productPages.length} said nothing)` : ""}`,
      );
      for (const f of productPages)
        think("understand", `${new URL(f.url).pathname} — ${f.heading}`);
    }

    if (rivalLeads.length) {
      say(
        "understand",
        `the company's own comparison urls name ${rivalLeads.length} other companies — ` +
          `leads to search for, not entities: ${rivalLeads
            .slice(0, 8)
            .map((r) => r.name)
            .join(", ")}${rivalLeads.length > 8 ? ", …" : ""}`,
      );
      for (const r of rivalLeads)
        think(
          "understand",
          `rival lead — ${r.name} (named in ${r.seen} comparison url${r.seen === 1 ? "" : "s"}, e.g. ${r.foundAt})`,
        );
    }
  }

  // A domain that does not resolve is settled, not unlucky. Retrying it and then
  // spending an unlocker call on it wastes time and money, and, worse, the
  // "probably a temporary blip, worth running again" message that follows turns a
  // typo into an apparent outage. `brightdata.ccom` cost six fetches, an unlocker
  // call, and a reader's confidence in the tool.
  if (!pages.length && !(await resolves(anchor))) {
    const err = new Error(
      `${anchor} does not resolve — there is no such domain. ${suggest(anchor)}`.trim(),
    );
    // READER-SAFE, and marked so the web layer knows it.
    //
    // This sentence is the whole value of the check: it names the typo and
    // suggests the fix. Unmarked, `failRun` cannot tell it from a provider
    // error that might carry a key or a request id, so it does the safe thing
    // and replaces it with "the server could not handle this request, quote
    // ref 4739e12c". Measured on the live surface with a mistyped domain: the
    // engine produced the right sentence and the visitor was shown a crash.
    //
    // `Symbol.for` is the global registry, so this marks the error for
    // `isNamedFault` in packages/web without either package importing the
    // other — which they must not, since core and sweep may not know a web
    // app exists.
    (err as unknown as Record<symbol, boolean>)[
      Symbol.for("open-kb.named-fault")
    ] = true;
    throw err;
  }

  // Try the free surfaces again before spending anything. A run once died here
  // reporting a company unreadable when all three direct fetches AND the unlocker
  // failed inside the same second, a network blip, not a fact about the site;
  // the same domain read fine minutes later. Direct fetches cost nothing, so
  // there was never a reason for one bad instant to end a run. Two seconds of
  // patience is cheaper than a wasted map.
  if (!pages.length) {
    say(
      "understand",
      `nothing readable on the first pass — waiting a moment and trying again`,
    );
    await new Promise((r) => setTimeout(r, 2_000));
    for (const u of surfaces) {
      if (signal?.aborted) throw new Error("aborted");
      await read(u, "direct");
    }
  }

  if (!pages.length) {
    // A site that refuses an anonymous GET is the common case, not an
    // exceptional one, and giving up here would end the run over a bot wall.
    // One unlocked fetch is ~$0.008 and 13-16s, so it is a fallback rather than
    // the default path.
    say(
      "understand",
      `direct fetch found nothing — retrying ${anchor} through the unlocker`,
    );
    await read(`https://${anchor}/`, "unlocked");
  }
  if (!pages.length) {
    throw new Error(
      `could not read ${anchor}. Tried ${surfaces.join(", ")} directly (twice, two seconds apart) and ` +
        `once through the unlocker; none returned readable text. If the site loads in a browser this is ` +
        `most likely a temporary block or a network blip — the same domain has read fine minutes later. ` +
        `Worth simply running again.`,
    );
  }

  /**
   * The reading — asked more than once, and the middle answer kept.
   *
   * THIS CALL IS NOT REPRODUCIBLE AND EVERYTHING DESCENDS FROM IT. Measured
   * on shopify.com with an IDENTICAL 28,634-character prompt, temperature 0,
   * and the same upstream host answering all three: 14 products, then 1, then
   * 19. Markets 8, 5, 8. The middle ask collapsed the whole company to a
   * single product, which would have dealt a one-product opening hand and
   * mapped a fraction of the market. Six real shopify.com runs on the same
   * day spread 43 to 51 products and 2 to 8 markets, and three separate A/Bs
   * this branch ran were swallowed by that spread rather than by anything
   * they changed.
   *
   * `temperature: 0` and a pinned host already went in (9cef607) and fixed
   * the classifier, which asks a small question about one page. They do not
   * fix this one, and the reason turned out to be narrower than "a 28k prompt
   * is unstable": it is unstable ON SOME HOSTS. Three identical asks pinned
   * per host returned 17/37/32 on Wafer against 63/63/63 on SiliconFlow, and
   * the 14/1/19 probe above was Wafer throughout. Wafer is now on
   * MODEL_HOST_IGNORE, which carries the table.
   *
   * That does not retire this, and it changes what the three asks are FOR.
   * The gateway serves this model from about thirty hosts and the ignore list
   * names only the two that have been measured, so the next unstable one gets
   * found the way these did — by a run coming back wrong.
   *
   * But the larger number is the disagreement BETWEEN hosts: 46/54/54 on
   * DeepInfra, 60/61/60 on Reka, 63/63/63 on SiliconFlow — steady hosts that
   * read the same company as a third bigger or smaller than each other. That
   * is most of the 43-to-51 spread across real shopify.com runs, because a
   * run's host is whichever answered first. So the asks are deliberately sent
   * to different hosts (`UNDERSTAND_ROUTES`) and the middle answer kept: three
   * asks to one host measure the host, three hosts asked once measure the
   * question.
   *
   * So it is asked UNDERSTAND_ASKS times, concurrently, and the answer with
   * the MEDIAN product count is kept. The median rather than the richest,
   * because both tails are failures — one product is a collapse and a hundred
   * and ten is a marketing-page inventory — and the middle of three is robust
   * to either without inventing anything the model did not say. Concurrent,
   * so the wall clock is one call rather than three; this is the largest
   * prompt the pipeline sends but it is sent once per run, and three of them
   * is about a third of a cent.
   *
   * A single ask is still available (`OPENKB_UNDERSTAND_ASKS=1`), and one
   * failing ask no longer ends the run: the others answer for it, and only an
   * empty set falls through to `call()`'s own retry.
   */
  const understandOnce = (
    sort?: "throughput" | "latency" | "price",
    /** One of several concurrent asks, so a timeout can be let go — see
     *  `acceptTimeout`. The lone fallback ask below passes nothing and keeps
     *  the retry, because there is nothing else left to answer for it. */
    oneOfSeveral = false,
  ) =>
    call(
      "understand",
      `read ${anchor} — ${pages.length} page${pages.length === 1 ? "" : "s"}`,
      Decomposition,
      prompt("understand", {
        pages: pages.join("\n\n"),
        productPages: productPages.length
          ? renderPageFacts(productPages)
          : "(none found: no sitemap or nav gave product urls, so work from the pages above)",
      }),
      // Worth thinking about: everything downstream descends from these sentences.
      { think: "medium", maxOutputTokens: 8_000, sort, acceptTimeout: oneOfSeveral },
    );

  /**
   * The asks go to DIFFERENT HOSTS on purpose, and this is why.
   *
   * Hosts do not merely differ in steadiness, they disagree about what the
   * company is. Three identical asks pinned per host, same prompt, same day:
   * DeepInfra 46/54/54, Reka 60/61/60, SiliconFlow 63/63/63. Asking one host
   * three times measures that host; asking three hosts once each measures the
   * question.
   *
   * The criteria pick the hosts, so no host is named here and none can go
   * stale the way a pinned order did this morning. Probed the same evening,
   * `throughput` landed on Reka, `latency` on DeepInfra and `price` on
   * OpenInference — three distinct hosts, and each criterion stable across
   * repeat asks.
   *
   * MEASURED against the thing it is for, simulating three runs' worth of
   * draws on shopify.com:
   *
   *   run 1   Reka 60   DeepInfra 55   Decart 56    -> 56
   *   run 2   Reka 60   Ambient 65     (price failed) -> 65
   *   run 3   Reka 60   Ambient 47     (price failed) -> 60
   *
   *   one host per run, as it was   47-65, spread 18 over 7 draws
   *   median across three hosts     56-65, spread  9 over 3 runs
   *
   * Half the spread, on three runs — enough to show the direction and not
   * enough to put a number on. Two caveats belong with it: `throughput`
   * answered Reka=60 every time, so the steadiness is partly one dependable
   * host, and `price` failed on two of three runs, which is why the even-count
   * rule below had to be decided rather than inherited.
   */
  const UNDERSTAND_ROUTES = ["throughput", "latency", "price"] as const;

  const understandByCall = async (): Promise<z.infer<typeof Decomposition>> => {
    if (UNDERSTAND_ASKS <= 1) return understandOnce();
    const asks = await Promise.all(
      Array.from({ length: UNDERSTAND_ASKS }, (_, i) =>
        understandOnce(UNDERSTAND_ROUTES[i % UNDERSTAND_ROUTES.length], true).then(
          (d) => d,
          // A refusal is one vote lost, not a dead run — unless every one of
          // them refuses, which falls through to the single-ask path below so
          // the failure surfaces the way it always did.
          () => null,
        ),
      ),
    );
    const got = asks.filter((d): d is z.infer<typeof Decomposition> => d !== null);
    if (!got.length) return understandOnce();
    got.sort((a, b) => a.products.length - b.products.length);
    /**
     * `Math.floor(n / 2)` on an ODD count is the middle. On an EVEN one —
     * which happens whenever an ask fails, and one did on two of three
     * simulated runs — it is the UPPER of the two, and that should be a
     * decision rather than an accident of the arithmetic.
     *
     * Upper is the right accident to keep. Both tails are failures but they
     * are not equally bad: a reading that collapses to one product maps
     * almost nothing and cannot be recovered downstream, while an inflated
     * one is only expensive, and since a9be42a deals the hand round-robin
     * even a hundred-product reading still searches every product's first
     * door. So when there is no true middle, lean away from the collapse.
     */
    const middle = got[Math.floor(got.length / 2)]!;
    if (got.length > 1) {
      const counts = got.map((d) => d.products.length);
      say(
        "understand",
        `read it ${got.length} times — ${counts.join(", ")} products; keeping the middle answer` +
          (counts[0] !== counts[counts.length - 1]
            ? ` (this call is not reproducible, so the spread is the point)`
            : ""),
      );
    }
    return middle;
  };

  /** How phase one actually read the company, for the report. Null on the
   *  call path — the packet above IS that story. Filled in agent mode, where
   *  the reading was an investigation whose shape (turns, pages, and what the
   *  docs said the products plug into) is a fact about this map. A holder
   *  rather than a bare `let`: the only writer is a closure, and the compiler
   *  cannot see into it, so a `let` reads as narrowed to `null` forever. */
  const discoveryFacts: {
    current: {
      steps: number;
      pagesRead: number;
      integrations: Array<{ with: string; does: string; foundAt: string }>;
    } | null;
  } = { current: null };

  const decomp: Decomposition = await (async () => {
    if (opts.discovery !== "agent") return understandByCall();

    // The agent pulls its own corpus: maps the product pages, reads what it
    // judges worth reading, submits products as it confirms them. See
    // `SweepOptions.discovery` for why this is a flag and not the engine.
    say(
      "understand",
      `investigating ${anchor} — the agent pulls its own pages (discovery: agent)`,
    );
    const dStarted = Date.now();
    const d = await discover({
      anchor,
      runId,
      parentId: null,
      model: opts.model,
      fetch: fetcher,
      spans,
      pricing,
      modelName: modelId,
      signal,
    });
    // Fold the agent's spend into this run's totals the same way call() does.
    // discover() emits its own per-turn spans; this is the run's ledger, which
    // reads tokIn/tokOut and the bill lines, and must not miss a phase.
    let agentIn = 0;
    let agentOut = 0;
    for (const s of d._steps ?? []) {
      agentIn += s.usage?.inputTokens ?? 0;
      agentOut += s.usage?.outputTokens ?? 0;
    }
    tokIn += agentIn;
    tokOut += agentOut;
    bill(
      "llm",
      "understand",
      usdFor(agentIn, agentOut),
      Date.now() - dStarted,
      true,
      // The same tokens the two lines above put in the run totals: in agent
      // mode this loop is the understand line's dominant spend, and a byAgent
      // token column that omits it would disagree with stats.tokIn by exactly
      // this amount. The discovery steps do not surface reasoning tokens.
      { in: agentIn, out: agentOut, reasoning: 0 },
    );
    discoveryFacts.current = {
      steps: d.steps,
      pagesRead: d.pagesRead,
      integrations: d.integrations,
    };
    say(
      "understand",
      `the agent read ${d.pagesRead} pages in ${d.steps} turns and submitted ${d.products.length} products` +
        (d.integrations.length
          ? ` and ${d.integrations.length} integrations from the docs`
          : ""),
    );
    for (const i of d.integrations)
      think("understand", `integration — ${i.with}: ${i.does} (${i.foundAt})`);

    // An investigation that found nothing is not a reading of the company; it
    // is a failed one. The packet for the single call is already in hand and
    // paid for, so the run falls back rather than shipping an empty market.
    if (!d.products.length) {
      say(
        "understand",
        `the agent submitted no products — falling back to the single-call reading`,
      );
      return understandByCall();
    }

    // The judgement the agent does not make: group the products into the
    // markets the search budget is divided across.
    const grouped = await call(
      "understand",
      `group ${d.products.length} products into markets`,
      Grouping,
      prompt("group", {
        anchor,
        sells: d.sells,
        buyer: d.buyer,
        products: d.products
          .map(
            (p) =>
              `- ${p.name} — ${p.does}${p.foundAt ? ` (${p.foundAt})` : ""}`,
          )
          .join("\n"),
      }),
      { think: "medium", maxOutputTokens: 8_000 },
    );
    return {
      sells: d.sells,
      buyer: d.buyer,
      brand: grouped.brand,
      products: d.products,
      capabilities: grouped.capabilities,
      coinages: d.coinages,
    };
  })();

  say("understand", `sells: ${decomp.sells}`);
  say(
    "understand",
    `${decomp.products.length} products → ${decomp.capabilities.length} distinct markets, ${decomp.coinages.length} coinages to avoid`,
  );
  for (const c of decomp.capabilities)
    think("understand", `capability — ${c.name}: ${c.does}`);
  think("understand", `sells — ${decomp.sells}`);
  think("understand", `buyer — ${decomp.buyer}`);
  for (const p of decomp.products)
    think("understand", `product — ${p.name}: ${p.does}`);
  if (decomp.coinages.length)
    think("understand", `never search — ${decomp.coinages.join(", ")}`);

  emitResult("understand", {
    kind: "understanding",
    brand: anchor,
    sells: decomp.sells,
    products: decomp.products.map((p) => ({
      slug: p.name,
      name: p.name,
      sells: p.does,
      because: "",
    })),
    buyer: { role: decomp.buyer, context: "", vocabulary: [], because: "" },
    coinages: decomp.coinages,
    marketConcepts: [],
    usd: usdFor(tokIn, tokOut),
  });

  // ── 2. write the catalog: the model writes debranded blind to the anchor's
  //      own name; branded templates name it on purpose (the exemption below) ──
  // "No fixed count" is the terminal's sentence and it must not be said on a
  // run that has a ceiling: the cut lands a few lines below, and a reader told
  // the templates decide and then shown four queries has been misled by the
  // narration rather than by the engine.
  say(
    "plan",
    opts.queries !== undefined
      ? `writing a catalog of up to ${target} queries — the model's own writing stays anchor-blind, branded templates name it on purpose`
      : QUERY_CEILING !== null
        ? `dealing every product an opening hand, then keeping the first ${QUERY_CEILING} — as many as this run's clock can finish`
        : `dealing every product an opening hand — no fixed count, the templates and the strip decide`,
  );
  /**
   * The names the run already holds, handed to the model that writes queries.
   *
   * The collision shape — "cross two or three players you already know" — was
   * measured failing ~50× against hand-written queries: third-party proper
   * nouns on 0.85% of model-written queries against 42.8% of hand-written
   * ones. One cause is structural, and this is its fix: the prompt asked for
   * names while the call carried none, so the model could only cross what it
   * happened to remember. The sitemap's rival leads and the docs' integrations
   * are exactly such names, published by the company itself — measured ground,
   * not model memory. Capped, because sixteen names is a hand and forty is an
   * inventory the model will dutifully work through instead of writing queries.
   */
  const knownPlayers = (() => {
    const seen = new Set<string>();
    const take = (ns: string[]) =>
      ns.filter((n) => {
        const k = n.trim().toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    // Each source has its own quota. One concatenated list sliced to sixteen
    // let a dense comparison namespace starve the integrations out entirely —
    // on exactly the runs that harvested both. And the sources are LABELED,
    // because a partner crossed as a rival buys a comparison page that does
    // not exist.
    const rivalNames = take(rivalLeads.map((r) => r.name)).slice(0, 10);
    const partnerNames = take(
      (discoveryFacts.current?.integrations ?? []).map((i) => i.with),
    ).slice(0, 6);
    const parts: string[] = [];
    if (rivalNames.length)
      parts.push(`rivals it published: ${rivalNames.join(", ")}`);
    if (partnerNames.length)
      parts.push(`integration partners from its docs: ${partnerNames.join(", ")}`);
    return parts.length
      ? parts.join(" · ")
      : "(none harvested — use names you know from this market)";
  })();

  /**
   * One call per PRODUCT, not one per lens.
   *
   * The unit of query generation is the thing a buyer chooses and pays for.
   * Splitting by market gave a market covering three products one share between
   * them, so a proxy network, a search API and a dataset marketplace competed
   * for the same handful of queries and the smallest lost. v1 stripped each
   * product and searched for THAT product's alternatives, which is why its
   * findings hung off the product rather than off the company.
   *
   * Every product gets its own call and its own budget, so a query about the
   * unlocker's job is written by a call that is thinking about nothing else.
   * The calls run concurrently, so the stage costs the slowest product rather
   * than the sum, exactly as the lens split did.
   *
   * Core products first: an adjacent line is a real market and is not what the
   * company is bought for, so it gets whatever the budget has left.
   */
  const ranked = [...decomp.capabilities].sort((a, b) =>
    a.centrality === b.centrality ? 0 : a.centrality === "core" ? -1 : 1,
  );

  /** A product row by the name a `covers` entry — or the adoption below —
   *  calls it. Trimmed and case-folded, because `covers` is the model quoting
   *  its own product list back to itself, and a quote that came back in a
   *  different case would otherwise cost that product both its `does` and its
   *  `foundAt` for no reason a reader could see. */
  const productNamed = (name: string) =>
    decomp.products.find(
      (p) => p.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );

  // Every product gets a hand. The funding contest died with the spec of
  // 2026-08-04: a product left unfunded is an entire market the map never
  // sees, which is the exact failure phase 3 exists to prevent. Core markets
  // still go first so the pool starts on what the company is bought for.
  const queues = ranked.map((c) => ({
    market: c,
    products: (c.covers.length ? c.covers : [c.name]).slice(),
  }));
  const funded: { market: (typeof ranked)[number]; product: string }[] = [];
  {
    let moved = true;
    while (moved) {
      moved = false;
      for (const q of queues.filter((x) => x.market.centrality === "core")) {
        const p = q.products.shift();
        if (p) {
          funded.push({ market: q.market, product: p });
          moved = true;
        }
      }
    }
    moved = true;
    while (moved) {
      moved = false;
      for (const q of queues.filter((x) => x.market.centrality !== "core")) {
        const p = q.products.shift();
        if (p) {
          funded.push({ market: q.market, product: p });
          moved = true;
        }
      }
    }
  }

  /**
   * A PRODUCT NO CAPABILITY CLAIMED IS STILL A PRODUCT.
   *
   * The queues above are built from `covers`, which is the model's grouping of
   * the product list — and the grouping drops some of the list. MEASURED over
   * the 25 runs on disk carrying a modern decomposition: 113 of 408 discovered
   * products (27.7%) appear in no `covers` entry, so they drew no catalog call,
   * no strip terms and not one query. cloudflare funded 1 of its 71 products,
   * supabase 7 of 29, github 12 of 24, linear.app 0 of 5. Nothing said so: the
   * coverage line below counts queries per MARKET, and a market whose one
   * remembered product got a hand reports itself covered while three of its
   * siblings were never asked about.
   *
   * So every name in `decomp.products` the drains above did not fund is adopted
   * by the capability it reads closest to and dealt the same hand as any other
   * product. Closeness is word overlap against that capability's own name, job
   * and covers list — free, deterministic, and re-derived from sentences this
   * run has already paid for. Ties keep the first capability in `ranked`, which
   * is core-ordered, so a product nothing matches lands in what the company is
   * bought for rather than in a side line.
   */
  const closestMarket = (p: { name: string; does: string }) => {
    const words = (s: string) =>
      new Set(
        s
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 2),
      );
    const mine = words(`${p.name} ${p.does}`);
    let best: (typeof ranked)[number] | undefined;
    let bestScore = -1;
    for (const c of ranked) {
      const theirs = words(`${c.name} ${c.does} ${c.covers.join(" ")}`);
      let n = 0;
      for (const w of mine) if (theirs.has(w)) n += 1;
      if (n > bestScore) {
        bestScore = n;
        best = c;
      }
    }
    return best;
  };
  const adopted: { market: (typeof ranked)[number]; product: string }[] = [];
  {
    const dealt = new Set(funded.map((f) => f.product.trim().toLowerCase()));
    for (const p of decomp.products) {
      const name = p.name.trim();
      if (!name || dealt.has(name.toLowerCase())) continue;
      dealt.add(name.toLowerCase());
      const market = closestMarket(p);
      // No capabilities at all is a decomposition with nothing to adopt into.
      // Every product is then already funded under its own market by the
      // drains above, so this loop simply has nothing to do.
      if (market) adopted.push({ market, product: name });
    }
    // Core first among the adopted, for the same reason the drains run core
    // first: the opening hand is sliced from the FRONT when a clock is on.
    for (const a of adopted)
      if (a.market.centrality === "core") funded.push(a);
    for (const a of adopted)
      if (a.market.centrality !== "core") funded.push(a);
  }
  say(
    "plan",
    adopted.length
      ? `${funded.length} products, every one dealt an opening hand — ${adopted.length} of them named by no capability`
      : `${funded.length} products, every one dealt an opening hand`,
  );

  // Debranded ask per product. Small on purpose: the templates already hold
  // the center, so the model's few are spent where templates cannot go.
  const debrandedAsk = Math.max(2, Math.min(PER_PRODUCT, 3));

  // The strip artifact (spec section "Strip"): per product, the terms it was
  // stripped to, whether the catalog call judged the name generic, and the
  // page that established it. Persisted so the audit trail the spec promises
  // ("the strip is a visible artifact on the map") actually exists — this used
  // to carry only `product`/`terms` and was never rendered anywhere.
  const strips: {
    product: string;
    terms: string[];
    generic: boolean;
    foundAt: string;
  }[] = [];
  const reserve = new Map<string, FamilyQuery[]>();

  // Bounded, not unleashed. The funding contest this change removes was the
  // thing that incidentally kept this fan-out small — `funded.length` used to
  // top out around the room a fixed query budget bought. Now every product is
  // funded, so `funded.length` is the company's whole product count, and a
  // bare `Promise.all` here would fire that many concurrent model calls at
  // once. A rate limiter does not know this is a planning stage: a 429 on any
  // one of them exhausts `call()`'s single retry, and `Promise.all` is
  // all-or-nothing, so one throttled product call kills a run that has
  // already paid for everything `understand` read. Same shape of fix used
  // elsewhere in this file: a small pool, not a wide one.
  const CATALOG_CONC = 6;

  // A POOL, not chunked waves — the same fix `runPool` documents for the link
  // phase, and TRIAGE_CONC's comment below it, applied here too: this used to
  // `await Promise.all` a slice of CATALOG_CONC products before starting the
  // next slice, a barrier per group that pays for its slowest member while
  // idle workers wait. `runPool` fixes that: each worker pulls the next
  // product the instant it frees up.
  //
  // WHY AN INDEXED ARRAY AND NOT A PUSH, unlike the link/orphan sites this
  // mirrors. `coreHands`/`restHands` below (search "pushed in `funded`
  // order") filter `catalogs` by `funded[i]`'s own centrality, which only
  // works if `catalogs[i]` is that same product's hand — a guarantee the old
  // code got for free by pushing whole chunks in slice order, since a single
  // chunk's `Promise.all` preserves its own input order even though the
  // calls inside it race. A continuous pool has no such chunk boundary, so
  // pushing in COMPLETION order would silently scramble that alignment.
  // Writing to `catalogs[i]` from the worker that was handed index `i` keeps
  // the guarantee by construction instead: every worker owns exactly one
  // slot, however the calls actually finish.
  const catalogs: SweptQuery[][] = new Array(funded.length);
  await runPool(funded, CATALOG_CONC, async ({ market, product }, i) => {
    const out = await call(
      "plan",
      `catalog: ${product}`,
      z.object({
        terms: z
          .array(z.string())
          .describe(
            "2-4 terms a buyer types for this job, ordered, closest first — each a different door into the market, not a rephrasing",
          ),
        generic: z
          .boolean()
          .describe(
            "true if this product's NAME alone reads as a common noun rather than this product — 'Datasets' is generic, 'Web Scraper API' is not",
          ),
        queries: z.array(PlannedQuery),
      }),
      prompt("catalog", {
        anchor,
        target: debrandedAsk,
        product,
        // THIS PRODUCT'S JOB, not its market's.
        //
        // `understand` is asked for `products[].does` — "what this product
        // does, stripped of the company's own naming" — which is exactly
        // the debranded sentence this call turns into search terms. It was
        // computed, paid for and then thrown away: every sibling in a group
        // was handed `market.does`, one capability one-liner, identical for
        // all of them, so three products sharing a capability were stripped
        // from the same description and asked to differ anyway.
        //
        // Falls back to the capability's line when the product carries
        // none — including the case where `covers` was empty and the
        // capability was funded under its own name, where there is no
        // product row to find.
        productDoes: productNamed(product)?.does.trim() || market.does,
        market: market.name,
        centrality: market.centrality,
        sells: decomp.sells,
        buyer: decomp.buyer,
        siblings:
          market.covers.filter((c) => c !== product).join(", ") ||
          "(nothing else in this market)",
        coinages: decomp.coinages.join(", "),
        knownPlayers,
      }),
      { think: "low", maxOutputTokens: 180 * debrandedAsk + 6_000 },
    );
    const terms = out.terms
      .map((t) => t.trim())
      .filter(Boolean)
      // FOUR, raised from three. The old cap was binding, not
      // generous: 436 of the 486 products stripped across `runs/`
      // returned exactly three terms, so the distribution was censored
      // at the ceiling and nobody could see what a fourth would have
      // been. And a fourth is worth having — measured over 5,381 pairs
      // of terms this agent wrote, two terms return the same host only
      // 11% of the time, so each one is close to a whole extra search
      // rather than a rephrasing of the last.
      .slice(0, 4);
    strips.push({
      product,
      terms,
      generic: out.generic,
      foundAt: productNamed(product)?.foundAt ?? "",
    });
    const hand = openingHand(product, terms, {
      branded: !out.generic,
      // A core market's second strip term opens with the hand — the
      // cursor.com lesson, argued at openingHand itself.
      core: market.centrality === "core",
    });
    reserve.set(product, hand.reserve);
    const asFired = (fq: FamilyQuery): SweptQuery => ({
      q: fq.q,
      intent: fq.family === "plain" ? "evaluation" : "switching",
      platform: "web",
      why: fq.why,
      market: market.name,
      family: fq.family,
      product: fq.product,
      term: fq.term,
    });
    const debranded: SweptQuery[] = out.queries.map((q) => ({
      ...q,
      market: market.name,
      family: "debranded" as const,
      product,
    }));
    catalogs[i] = [...hand.open.map(asFired), ...debranded.slice(0, debrandedAsk)];
  });

  // Deal the company-level hand once — the owner decision, and the densest
  // comparison pages a map has. Fired outside the per-product calls because it
  // is not about any one product, it is about the company itself.
  const company: SweptQuery[] = companyHand(
    decomp.brand || anchor.replace(/\..*$/, ""),
  ).map((fq) => ({
    q: fq.q,
    intent: "switching",
    platform: "web",
    why: fq.why,
    market: "",
    family: fq.family,
    product: undefined,
    term: undefined,
  }));

  /**
   * The rival-grounded hand, and THE CAP IT IS BOUGHT UNDER.
   *
   * These are new SERP purchases — the only part of this channel that is not
   * free — so the cap is derived rather than picked: a run may buy at most as
   * many rival-grounded queries as it already bought BRANDED ones. The channel
   * that names other people's brands may not cost more than the channel that
   * names the anchor's own, which is the same market read from the other side
   * and has never needed a bigger budget than this.
   *
   * That number is a fact about the run, not a constant: three from
   * `companyHand`, plus one per product whose name is not generic. It scales
   * with how many products the anchor sells, so a big catalog buys a big rival
   * hand — MEASURED as branded queries actually asked on the runs in `runs/`:
   * shopify 27, cloudflare 21, twilio 19, vercel 14, stripe/github/mongodb 11,
   * supabase 5, and 0 for a run whose products were all generically named. At
   * $0.0067-$0.0086 a query that is $0.00 to $0.23 of SERP per run, and nearer
   * $0.40 counting the ranking those extra hits pay for. A company that
   * publishes no comparison urls pays nothing, because `rivalLeads` is empty.
   *
   * Placed last, so a run under a query ceiling spends the ceiling on the
   * proven families first and this one loses its slots before they do.
   */
  const brandedBought = [...catalogs.flat(), ...company].filter(
    (q) => q.family === "branded",
  ).length;

  /**
   * WHAT "NAMING THE ANCHOR" MEANS FOR THIS RUN — decided once, used at every
   * gate: the opening-hand filter, the rival-name deal below, and the widening
   * loop's per-round check.
   *
   * The bare label is the ban that works for stripe and fails for customer.io:
   * "customer" is a word that company's own market cannot ask a question
   * without, and banning it killed the entire plain family for the core market
   * — the query families.ts calls the single highest-yield one — after the
   * catalog calls that wrote it were already paid for. The ban exists to stop
   * SELF-RETURN, and "customer engagement platform" does not return
   * customer.io; "customer.io" and "customerio" do. So when the label turns up
   * inside the run's own stripped market terms, the label yields to the market
   * and the ban tightens to the spellings that actually look the company up.
   */
  const anchorLabel = anchor.split(".")[0] ?? "";
  const labelIsMarketWord = strips.some((s) =>
    s.terms.some((t) =>
      t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).includes(anchorLabel),
    ),
  );
  const anchorBanName = labelIsMarketWord ? anchor : anchorLabel;
  /**
   * A coinage that IS one of the run's own market terms is not a coinage.
   *
   * The first live agent run listed "Email API" among resend's coinages — a
   * product name on that site, and also the exact term the strip returns for
   * its core market. Banning it kills the `email api` plain family: the same
   * self-inflicted wound as the customer.io label, arriving through the other
   * door. The model was told a coinage is a word no stranger would type;
   * this gate is for the times it lists one anyway. Exact match against the
   * stripped terms — a coinage merely CONTAINING a market word ("React
   * Email") is still a brand name and still banned.
   */
  const termSet = new Set(
    strips.flatMap((s) => s.terms.map((t) => t.trim().toLowerCase())),
  );
  const marketWordCoinages = decomp.coinages.filter((c) =>
    termSet.has(c.trim().toLowerCase()),
  );
  const keptCoinages = decomp.coinages.filter(
    (c) => !termSet.has(c.trim().toLowerCase()),
  );
  if (marketWordCoinages.length) {
    think(
      "plan",
      `${marketWordCoinages.length} coinages are the market's own terms and leave the ban — ` +
        marketWordCoinages.join(", "),
    );
  }
  const banCoinages = labelIsMarketWord
    ? [
        ...keptCoinages,
        anchor.replace(/\./g, " "),
        anchor.split(".").join(""),
      ]
    : keptCoinages;
  if (labelIsMarketWord) {
    think(
      "plan",
      `the anchor's label "${anchorLabel}" is a word its own market speaks — the ban tightens to ` +
        `"${anchor}" and its joined spelling, so the plain family survives`,
    );
  }

  const rivals: SweptQuery[] = rivalHand(
    // Names the ban would kill are not dealt: each rival slot is capped by the
    // branded hand, and a query generated only to be dropped at the filter
    // below spends a slot a clean published name never gets.
    rivalLeads
      .map((r) => r.name)
      .filter((n) => !banned(n, "rival", anchorBanName, banCoinages)),
    brandedBought,
  ).map((fq) => ({
    q: fq.q,
    // Same reading as the other hands make: a pair query is someone weighing
    // two vendors, a bare `alternatives` is someone about to leave one.
    intent: fq.q.includes(" vs ") ? "evaluation" : "switching",
    platform: "web",
    why: fq.why,
    market: "",
    family: fq.family,
    product: undefined,
    term: fq.term,
  }));
  if (rivalLeads.length) {
    say(
      "plan",
      `${rivals.length} rival-grounded queries from ${rivalLeads.length} names the company itself published — ` +
        `capped at ${brandedBought}, the size of this run's branded hand`,
    );
  }

  // Deduplicated across lenses: they were told to stay in their own lane, but
  // "best X alternatives" is reachable from two of the three, and a repeat is a
  // query bought twice.
  /**
   * ROUND-ROBIN ACROSS PRODUCTS, not product by product.
   *
   * `catalogs` is one hand per product and this used to be `catalogs.flat()`,
   * which lays product 1's whole hand down before product 2 gets a single
   * query. That is fine while a run fires everything it planned and silently
   * catastrophic when it does not — and it usually does not, because the
   * widening loop seals on `HOST_CEILING` and the workers abandon the queue's
   * tail.
   *
   * MEASURED on the six gallery runs: 130 of 245 products (53%) were stripped,
   * planned, given their own catalog model call, and then never searched at
   * all. It is entirely the large decompositions — 0% of products went unsearched
   * on the runs with 10 and 13 products, against 56%, 63% and 69% on those with
   * 50, 67 and 81. And the cut is not harmless. datadoghq.com searched 25 of
   * its 81 products and the 56 it dropped included Network Monitoring, Static
   * Code Analysis, Observability Pipelines, Product Analytics, Code Security
   * and Workload Protection — whole markets missing from the map, not spare
   * framings of ones it already had.
   *
   * Interleaved, the ceiling still cuts the same NUMBER of queries; it cuts
   * them from every product's tail rather than from the last thirty products
   * entirely. Every product gets its first strip term before any product gets
   * its second, so a run that can only afford a third of its plan spends that
   * third on a third of each market instead of all of one.
   *
   * WITHIN CENTRALITY, not across it. A run whose budget only stretches to
   * four queries must still spend them on the core market rather than
   * sampling the company's side lines — that is what `funded` deals for and
   * what `sweep-fits-the-clock-it-was-given` pins. So core products
   * round-robin among themselves first and adjacent ones after, which leaves
   * a tiny hand exactly where it was and only changes what happens once
   * there are more products than the run can afford.
   *
   * The order WITHIN a product's hand is untouched, so the openingHand
   * argument about which term leads still holds; only the order between
   * products of equal centrality changes.
   *
   * WHAT IT ACTUALLY BOUGHT, measured on the wire rather than on the plan,
   * shopify.com against three runs of the same anchor before it:
   *
   *              products   searched   queries   kept   recall
   *   before           50    25 (50%)       154   1226      71%
   *   before           43    19 (44%)       152   1220      86%
   *   before           50    22 (44%)       152   1236      79%
   *   after            45    41 (91%)       144   1100      79%
   *
   * The coverage is real and it is bought with FEWER queries, not more. The
   * map is 11% smaller, because spreading a fixed budget across every product
   * takes depth away from the first few — and recall did not move, though
   * shopify's own run-to-run recall spread is 15 points, so this run could not
   * have shown a small change either way.
   *
   * So this is not a win on shopify.com, and it is worth being plain about
   * why it stays. Its tail is Barcode generator and Image resizer, and
   * spending queries there costs a real map to reach nothing. datadoghq.com's
   * tail was Network Monitoring, Static Code Analysis, Observability
   * Pipelines and Product Analytics — 56 products dropped, whole markets
   * absent. A map missing 11% of its rows is smaller; a map missing entire
   * markets is wrong in the way a reader notices first. What decides which
   * case a run is in is `understand`, and nothing downstream can tell them
   * apart, so the ordering has to be safe for the bad case.
   */
  const interleave = (hands: SweptQuery[][]): SweptQuery[] => {
    const out: SweptQuery[] = [];
    for (let i = 0; ; i++) {
      const row = hands.filter((h) => i < h.length).map((h) => h[i]!);
      if (row.length === 0) return out;
      out.push(...row);
    }
  };
  // `catalogs[i]` is written by the worker that was handed `funded[i]` (see
  // the indexed-array note above the pool that fills it), so the two line up
  // index for index and the centrality of hand i is funded[i]'s market.
  const coreHands = catalogs.filter((_, i) => funded[i]?.market.centrality === "core");
  const restHands = catalogs.filter((_, i) => funded[i]?.market.centrality !== "core");
  /**
   * CORE FIRST, BUT NOT CORE ENTIRELY — the round-robin above only rotates
   * WITHIN a band, and concatenating the two bands put every core product's
   * whole hand ahead of the first door of every adjacent one.
   *
   * That is fine while the plan fires in full and fatal when it does not, and
   * on a large anchor it does not: the search stops at `HOST_CEILING`, not at
   * the end of the plan. shopify.com planned 373 queries and fired 147 — 39% —
   * and the plan positions show what the concatenation did with the other 61%:
   *
   *   idx   0   fired   Shopify
   *   idx   1   fired   Shopify POS
   *   ...
   *   idx 262   NEVER   Shopify Email
   *   idx 263   NEVER   Sidekick
   *   idx 265   NEVER   Shopify Inbox
   *   ...        (13 products in all, first door at 262 or later)
   *
   * Thirteen products whose FIRST door sat past index 262 were unreachable
   * before the run began. This is the same failure a9be42a fixed for products
   * inside one band, surviving between the bands.
   *
   * So a core product takes its OPENING — `openingHand` gives a core product
   * two front doors and each one's comparison field, which is four queries —
   * and then every adjacent product takes its opening, before any core product
   * takes a fifth query. Core still leads, and a small run still spends itself
   * on what the company is bought for, which is what the `maxQueries: 4`
   * contract pins. What changes is only that "core first" stops meaning "core
   * until core is exhausted".
   */
  const CORE_OPENING = 4;
  const head = (h: SweptQuery[]) => h.slice(0, CORE_OPENING);
  const tail = (h: SweptQuery[]) => h.slice(CORE_OPENING);
  const interleaved = [
    ...interleave(coreHands.map(head)),
    ...interleave(restHands.map(head)),
    ...interleave(coreHands.map(tail)),
    ...interleave(restHands.map(tail)),
  ];

  const seenQ = new Set<string>();
  const cat = {
    queries: [...interleaved, ...company, ...rivals].filter((q) => {
      const k = q.q.trim().toLowerCase();
      if (seenQ.has(k)) return false;
      seenQ.add(k);
      return true;
    }),
  };

  // The requested count is a sentence in a prompt, and a prompt is a request.
  // Gemini rejects array-length constraints in a structured-output schema, so
  // nothing in the schema holds the model to it either, meaning the number a
  // caller typed, the number they are billed for, and the number the model felt
  // like writing were three independent quantities.
  //
  // Clamped here instead. Over the ask is truncated, because the caller set a
  // budget and a run that quietly spends 2.5x it has broken a promise. Under the
  // ask is kept and said: a short catalog is a real outcome worth seeing, and
  // silently topping it up would hide that the market gave the model less to
  // work with than it was asked for.
  const planned = cat.queries;
  // opts.queries is now an override for scripts that want a bounded probe.
  // Left unset — the normal case — the opening is the product count times the
  // hand, and the ceiling on the RUN is the spend ceiling, not a query quota.
  //
  // Copied either way, never aliased to `planned`: the anchor-naming filter
  // below splices `queries` in place, and `written: planned.length` further
  // down has to keep reporting what the model actually wrote, not what
  // survived the drop.
  const opening =
    opts.queries !== undefined ? planned.slice(0, target) : [...planned];

  // The anchor-naming drop, BEFORE the ceiling slice. It ran after, and each
  // banned query ate a budget slot while a clean template query sat cut below
  // the line — measured on the fixture: a 6-slot run fired 5, with an adjacent
  // market's opener discarded unfired. A query that looks the anchor up is
  // bought for nothing, so it must not be allowed to buy a slot either.
  //
  // `banned` (packages/core/src/families.ts) is the one implementation of this
  // check — the widening loop below runs the identical predicate on
  // reserve-released and freshly-invented queries, so a strip term or coinage
  // dropped here cannot fire unfiltered later just because it arrived through
  // a different code path. The rival hand was pre-filtered at the deal, so a
  // name that dies here died before it could spend a rival slot.
  {
    const named = opening.filter((x) =>
      banned(x.q, x.family, anchorBanName, banCoinages),
    );
    if (named.length) {
      const drop = new Set(named.map((q) => q.q));
      for (let i = opening.length - 1; i >= 0; i--)
        if (drop.has(opening[i]!.q)) opening.splice(i, 1);
      say(
        "plan",
        `catalog: ${opening.length} queries (dropped ${named.length} that named the anchor without being branded)`,
      );
      for (const q of named) think("plan", `dropped, names the anchor: ${q.q}`);
    } else {
      say("plan", `catalog: ${opening.length} queries, none name the anchor`);
    }
  }

  // The clock's ceiling, applied to the opening as well as to the widening loop
  // below — a hand dealt before the first search is still a hand this run has
  // to be able to rank. Sliced rather than sampled: `funded` is core markets
  // first — the capabilities' own products core-before-adjacent, then the
  // products no capability claimed in the same order — so the first N are the
  // queries the company is bought for.
  const queries =
    QUERY_CEILING === null ? opening : opening.slice(0, QUERY_CEILING);
  if (QUERY_CEILING !== null && opening.length > queries.length) {
    say(
      "plan",
      `sized to the clock: the hand came to ${opening.length} queries and this run may fire ${QUERY_CEILING} — ` +
        `taking the first ${queries.length}, core markets first`,
    );
  }

  // Coverage, stated rather than assumed. A market with no query cannot put a
  // single competitor on the map, and until now that failed silently: on one
  // measured run three of nine products drew zero queries and nothing said so.
  {
    const asked = new Map<string, number>();
    for (const q of queries)
      asked.set(
        q.market.trim().toLowerCase(),
        (asked.get(q.market.trim().toLowerCase()) ?? 0) + 1,
      );
    const core = decomp.capabilities.filter((c) => c.centrality === "core");
    const missed = core.filter((c) => !asked.get(c.name.trim().toLowerCase()));
    for (const c of decomp.capabilities) {
      think(
        "plan",
        `${c.centrality} · ${c.name}: ${asked.get(c.name.trim().toLowerCase()) ?? 0} queries`,
      );
    }
    if (missed.length) {
      say(
        "plan",
        `no queries for ${missed.length} of ${core.length} core markets: ${missed.map((c) => c.name).join(", ")}`,
      );
    } else {
      say(
        "plan",
        `every one of the ${core.length} core markets got at least one query`,
      );
    }
    // A market-level count cannot see a product-level hole, which is why this
    // is said separately. The line above was true on every one of the 25 runs
    // measured and 113 of their 408 products still drew nothing, because the
    // capability that covered the market had one product in `covers` and the
    // rest of its siblings were nowhere. Stated here so a reader sees the
    // condition on the run that has it, rather than an auditor reconstructing
    // it from the files afterwards.
    if (adopted.length) {
      const shown = adopted
        .slice(0, 6)
        .map((a) => `${a.product} → ${a.market.name}`);
      say(
        "plan",
        `${adopted.length} of ${decomp.products.length} products were in no capability's covers list, ` +
          `and were dealt a hand under the nearest market: ${shown.join(", ")}` +
          (adopted.length > shown.length
            ? `, and ${adopted.length - shown.length} more`
            : ""),
      );
    }
    for (const a of adopted)
      think("plan", `adopted — ${a.product} → ${a.market.name}`);
  }
  // The truncation warning only applies when opts.queries actually clamped the
  // catalog — the normal, unset case never slices, so "using the first N"
  // would be a lie about a cut that never happened.
  if (opts.queries !== undefined && planned.length > target) {
    say(
      "plan",
      `catalog: model wrote ${planned.length} for a budget of ${target} — using the first ${target}`,
    );
  } else if (opts.queries !== undefined && planned.length < target) {
    say(
      "plan",
      `catalog: model wrote ${planned.length} of the ${target} asked for`,
    );
  }

  // The anchor-naming drop moved ABOVE the ceiling slice — see the block on
  // `opening`. Running here, each banned query had already eaten a budget slot
  // a clean query below the cut never got.

  emitResult("plan", {
    kind: "planned",
    slug: anchor,
    brand: anchor,
    queries: queries.map((q) => ({
      q: q.q,
      source: q.intent,
      rationale: q.why,
      concept: q.platform,
    })),
    // Priced from Bright Data's SERP rate, which is the only part of the bill
    // that is knowable before the run, the model half depends on how much text
    // comes back.
    //
    // `target` is the 40-fallback used only when `opts.queries` clamps the
    // catalog — reporting it as `requested` on the normal, uncapped path told
    // the reader a run was capped at 40 when nothing capped it at all.
    requested: opts.queries,
    written: planned.length,
    // The pre-run estimate: nothing has been asked yet, so no product has
    // earned `DEEP_PAGES` — every query is priced at its opening depth.
    estimatedUsd: queries.length * SHALLOW_PAGES * 0.0015,
    budgetUsd: 0,
    uncapped: opts.queries === undefined && QUERY_CEILING === null,
    // The whole run's ceiling and the clock it was derived from, so the reader
    // meeting a 200-entity map can tell "this host gave the run 4 minutes"
    // apart from "this engine found 200 things". Null on the CLI, which is
    // uncapped and says so.
    ceiling: QUERY_CEILING,
    clockSeconds: DEADLINE === null ? null : Math.round((DEADLINE - t0) / 1000),
  });

  // ── 3. fire, look, and decide whether to fire again ───────────────────────
  //
  // A query count fixed before the run has seen anything is a guess. The size of
  // a market is not knowable in advance, one anchor's 40 queries returned 104
  // things while another's 80 returned 88, so the run fires a wave, looks at
  // what it actually got, and decides whether that is enough.
  //
  // It stops when a wave stops paying: when new queries keep returning hosts
  // already on the map, more queries buy corroboration rather than coverage, and
  // the honest move is to stop rather than to spend the rest of the budget
  // proving what is already known.
  const hits: Array<{
    url: string;
    title: string;
    description: string;
    q: string;
    intent: string;
    family: QueryFamily;
    product?: string;
    /** Where the engine ranked this row, global across pages. */
    rank?: number;
  }> = [];

  /** What the platform field actually bought, counted at the wire rather than
   *  inferred from the query text afterwards. See `scopeToPlatform`. */
  /** Billable SERP requests, retries among them, and the provider's own words
   *  for why a page had to be re-bought. */
  let serpRequests = 0;
  let serpRetries = 0;
  /** Wall-clock the provider's own rate limit took, and how many queries paid
   *  it. A throttle is account-wide, so a run can lose most of its search
   *  phase to a ceiling nothing in the report mentioned. */
  let serpPacedMs = 0;
  let serpPacedQueries = 0;
  const serpBlocks: Record<string, number> = {};
  /** Queries that failed outright, by reason — the non-retryable half of the
   *  story `serpBlocks` tells for retries. See the tally beside it. */
  const serpFailures: Record<string, number> = {};
  let serpSuspendedSaid = false;
  /** Rows bought and unusable — see `SearchResult.redirects`. */
  let serpRedirects = 0;
  /**
   * Queries the port called a success while losing one of their pages.
   *
   * `ok` is `failures.length < mine.length` — a query whose first page
   * answered has produced results even if a later page did not, which is the
   * right call because the rows page one returned are real. What was missing
   * is any count of it: a two-page query that loses a page comes back with
   * roughly half its rows and says nothing. MEASURED across 3,771 queries on
   * disk: 939 of them, 24.9%, and 73% on the worst run. It is not even across
   * families either — debranded loses a page on 33% of its queries against
   * plain's 19% — so a per-query yield compared between families is compared
   * over different numbers of pages unless this is known.
   */
  let serpPartial = 0;
  /** Queries whose search was actually bought, counted where the money moves.
   *  `asked` is the QUEUE — seeded with the whole opening hand and grown at
   *  plan time — and the host-ceiling seal makes workers abandon its tail, so
   *  the two diverge on any run that stops early. Measured on one vercel run:
   *  `asked` claimed 137, the wire saw 83. `report.queries` reads this;
   *  `report.queued` keeps the old number under its honest name. */
  let firedCount = 0;
  /**
   * EVERY QUERY THAT ACTUALLY REACHED THE WIRE, lowercased.
   *
   * A plan and a purchase are different things and this branch confused them
   * three times in one night: a fourth strip term written into
   * `report.strips` and searched on none of fifty products; a reserve the
   * widening loop never draws from; a 258-query plan sealed at 100. Each time
   * the mechanism was verified and the wire was not, and each time it took a
   * hand-written script over `searched[]` to find out.
   *
   * `report.wire` is that script, kept. See where it is built.
   */
  const firedQueries = new Set<string>();
  let scopedQueries = 0;
  let scopeWithheld = 0;
  let tooLongToScope = 0;
  /** Queries whose platform was the anchor's own site, fired unscoped. Counted
   *  apart from `tooLong` because it is a fact about WHO this run is mapping,
   *  not about how the catalog agent writes. */
  let anchorOwnedScope = 0;
  const scopedBy: Record<string, number> = {};

  /**
   * The distinct hosts seen so far, maintained as results land rather than
   * folded out of `hits` on every question.
   *
   * It was that fold, which was fine when only the planner asked, once a round.
   * It is now also what the search workers check against the clock — hosts are
   * what the rank phase is charged for, so "can this run still judge what it
   * already has?" belongs wherever the run is about to buy more — and a fold
   * over several thousand rows, per worker, per query, is not a thing to put in
   * a hot loop. Filled in `runOne` beside the `hits.push` that was its only
   * source, so the two cannot come to disagree.
   */
  const hostsSeen = new Set<string>();
  /** What the last widening round actually bought, for the next assess call:
   *  rows returned, and how many were hosts the map had never seen. A model
   *  told "the last round was 83% ground you already hold" can steer; one
   *  told only the host total cannot. Zeroes before the first round. */
  const lastRound = { fired: false, hits: 0, gained: 0 };

  /**
   * Fire a wave, keeping the pipe full.
   *
   * This used to chunk the queries into groups of CONC and await each group, so
   * a group cost as much as its slowest member and nothing new started until
   * every one of them landed. Measured on an 80-query wave: four groups taking
   * 62s, 112s, 61s and 71s for 306s total. During the 112s group, nineteen
   * queries were finished and twenty more were waiting on one straggler.
   *
   * A pool instead. Each worker takes the next query the moment it frees up, so
   * one slow query delays only itself. Same concurrency, no barrier.
   */
  /** Search one query and record everything it produced. The pool below calls
   *  this; nothing here knows about batches or waves. */
  /**
   * HOW MANY QUERIES WERE EVER ACTUALLY IN FLIGHT AT ONCE.
   *
   * The search phase is the biggest block in a run and nothing explains its
   * rate. 32 workers start, the queue is full from the first tick, every
   * query reports a ~4.6s median — and the phase still moves 0.27 queries a
   * second, which is what one worker would do. Two very different faults look
   * identical from outside: a dispatch that never gets wide (workers blocked
   * on something before the wire) or a wire that is wide and slow (32 in
   * flight, each waiting on a provider that queues them).
   *
   * `pacedMs` ruled out one candidate — our own rate limiter never fired. This
   * rules on the other, and it is a counter rather than an inference: peak is
   * the high-water mark of concurrent `runOne` calls, `sum`/`samples` give the
   * mean so a single spike cannot read as sustained width.
   *
   * Cheap on purpose. Two integers around an await that already exists, no
   * timers, and nothing that can change what the phase does.
   */
  let inFlight = 0;
  let peakInFlight = 0;
  let inFlightSum = 0;
  let inFlightSamples = 0;
  const runOne = async (planned: SweptQuery) => {
    /**
     * THE PLATFORM, RENDERED WHERE THE QUERY IS BOUGHT.
     *
     * THE WRITTEN TEXT IS THE KEY; THE FIRED TEXT IS A FACT ABOUT THE WIRE.
     * `asked` holds these same objects, and `marketOf`/`familyOf`/`byQ` join a
     * result row back to its query BY `q` — so every hit below is recorded
     * under `planned.q`, and the scoped string lives in `planned.fired`. The
     * previous arrangement wrote the scoped text over `q` itself so record and
     * wire could not disagree; what it bought was the widening dedupe going
     * blind — `seen` is built from these objects, a re-proposed query no
     * longer matched its own mutated record, and the same wire string was
     * bought and billed twice.
     *
     * `site:` is also a strong medicine: on the generation before this one it
     * was on 31.9% of queries (426 distinct) and is on 2.1% now (1,490
     * distinct) — within the model's own debranded family, 31.9% -> 3.7%. That
     * collapse is why the field exists in the schema at all, and it is not an
     * argument for putting the prefix back everywhere: it goes on where the
     * catalog agent asked for a forum, and nowhere else.
     */
    let fired = planned.q;
    {
      const scope = scopeToPlatform(planned.q, planned.platform, anchor);
      if (scope.scoped && scopedQueries >= PLATFORM_SCOPE) {
        // The catalog asked for a platform and the run's allowance is spent
        // (or zero, the default): the words fire unscoped instead. Counted
        // apart from `scoped`, so the report still shows what was asked for.
        scopeWithheld += 1;
      } else if (scope.scoped) {
        // Onto `fired` and the record's `fired` field, never onto `q`.
        // Mutating `q` made the record agree with the wire by making the
        // dedupe and the joins disagree with the plan: the widening loop's
        // `seen` set is built from these objects, so a re-proposed query no
        // longer matched its own mutated record and the same wire string was
        // bought and billed twice.
        fired = scope.q;
        planned.fired = scope.q;
        scopedQueries += 1;
        scopedBy[planned.platform] = (scopedBy[planned.platform] ?? 0) + 1;
      } else if (scope.anchorOwned) {
        anchorOwnedScope += 1;
      } else if (scope.tooLong) {
        tooLongToScope += 1;
      }
    }
    // Untagged queries (the model's own free-form widening proposals carry no
    // `product`, only a `market`) have never been named by `assess`, so they
    // stay shallow — `depthByProduct` only ever holds product names, and a
    // lookup that finds nothing defaults exactly like one that finds "shallow".
    const depth = planned.product
      ? (depthByProduct.get(planned.product) ?? "shallow")
      : "shallow";
    const port = depth === "deep" ? searchAt.deep : searchAt.shallow;
    const [r] = await port.search([fired]);
    if (!r) return;
    // What the wire actually cost, beside what was asked for. A refusal bills
    // like an answer, so a throttled run pays for the throttling: measured at
    // 28% on one map, visible nowhere but in the total.
    serpRequests += r.requests ?? 0;
    serpRetries += r.retries ?? 0;
    serpPacedMs += r.pacedMs ?? 0;
    if ((r.pacedMs ?? 0) > 0) serpPacedQueries += 1;
    serpRedirects += r.redirects ?? 0;
    if (r.ok && /pages failed/.test(r.error ?? "")) serpPartial += 1;
    for (const b of r.blocked ?? []) {
      const key = b.replace(/\d{3,}/g, "N").slice(0, 60);
      serpBlocks[key] = (serpBlocks[key] ?? 0) + 1;
    }
    // A query that FAILED, tallied by the provider's own reason. `blocked`
    // above only ever carries the retry path's refusals, so a failure the
    // port does not retry — an account suspension is the measured case —
    // never reached the summary: runs/sweep-cursor-com-20260823064255.json
    // lost 18 of its last 19 queries to "Account is suspended" and the
    // terminal printed six retry reasons and not that one. The first sighting
    // of a suspension is said aloud at once, because every query after it
    // is known to fail and the reader is the only one who can fix it.
    if (!r.ok && r.error) {
      const reason = r.error.replace(/^\d+\/\d+ pages failed: /, "");
      const key = reason.replace(/\d{3,}/g, "N").slice(0, 60);
      serpFailures[key] = (serpFailures[key] ?? 0) + 1;
      if (/suspended/i.test(reason) && !serpSuspendedSaid) {
        serpSuspendedSaid = true;
        say(
          "sweep",
          `SEARCH PROVIDER REFUSED: ${reason} — every search from here will fail the same way`,
        );
      }
    }
    {
      const batch = [planned];
      const j = 0;
      {
        // Guarded on the same condition the port uses to decide whether to
        // dispatch at all. A blank query used to buy a full wave of `q=` pages,
        // so adding a page count unconditionally was true; the port now
        // refuses it locally for $0 and issues nothing, which would leave this
        // counter describing requests that were never made. `usd` was already
        // honest either way — this is the count catching up with it. The
        // depth billed is the SAME `depth` the port choice above already
        // decided — never re-derived, so this can never disagree with what was
        // actually fired.
        if (fired.trim()) serpCalls += depth === "deep" ? DEEP_PAGES : SHALLOW_PAGES;
        bill("serp", "sweep", r.usd, r.ms, r.ok);
        // One span per SERP call, carrying the query text, the only place a
        // reader can see which question the run just paid for.
        spans.emit({
          runId,
          agentId: "sweep",
          parentId: null,
          kind: "search",
          name: "serp",
          argsDigest: r.query,
          ms: r.ms,
          ok: r.ok,
          error: r.error,
          usd: r.usd,
        });
        for (const h of r.hits) {
          hits.push({
            ...h,
            // The WRITTEN text, not `r.query`: the wire answered the scoped
            // string, but every join downstream keys on the plan's own text,
            // and a hit filed under the scoped form would lose its market.
            q: planned.q,
            rank: h.rank,
            intent: batch[j]!.intent,
            family: batch[j]!.family,
            product: batch[j]!.product,
          });
          try {
            hostsSeen.add(
              new URL(h.url).hostname.toLowerCase().replace(/^www\./, ""),
            );
          } catch {
            // a row without a parseable URL is not a host, skip rather than count it
          }
        }

        // One fired query, counted beside the frame that proves it: this line
        // and the `searched` frame below are one event, so `report.queries`
        // always equals the number of `searched` frames a browser replayed.
        firedCount += 1;
        firedQueries.add(r.query.trim().toLowerCase());
        // The results themselves, not just the count. Everything downstream, the
        // hosts, the classifications, the map, is derived from these rows, and
        // without them a reader is asked to trust an aggregate: "580 results, 88
        // hosts" is not something anyone can check. This is the raw material.
        emitResult("sweep", {
          kind: "searched",
          query: r.query,
          intent: batch[j]!.intent,
          platform: batch[j]!.platform,
          family: batch[j]!.family,
          product: batch[j]!.product ?? "",
          why: batch[j]!.why,
          ok: r.ok,
          error: r.error,
          ms: r.ms,
          usd: r.usd,
          hits: r.hits.map((h) => ({
            url: h.url,
            title: h.title,
            // Trimmed, not dropped: a whole page of descriptions is what made a
            // previous design's context explode, and the first sentence is what a
            // reader actually reads anyway.
            description: (h.description ?? "").slice(0, 200),
          })),
        });
      }
    }
  };

  const distinctHosts = () => hostsSeen;

  const asked: SweptQuery[] = [...queries];
  /**
   * One queue, drained continuously, refilled while it drains.
   *
   * This used to run in waves: fire a batch, wait for all of it, ask the model
   * what is missing, fire the next batch. Two costs, both measured on one run.
   * The assess call is a serial stall, about 15 seconds each with every worker
   * idle. And a follow-up wave is small, so waves 2 to 4 spent 239 seconds
   * putting eleven queries through a twenty-wide pool.
   *
   * Here the workers never stop. The planner runs beside them and tops the queue
   * up when it drops below half the pool width, so by the time a worker wants
   * another query there is usually one waiting. Assessment overlaps searching
   * instead of interrupting it.
   */
  const queue: SweptQuery[] = [...queries];
  let taken = 0;
  let sealed = false;
  let rounds = 0;

  let ran = 0;
  const take = (): SweptQuery | null =>
    taken < queue.length ? queue[taken++]! : null;
  const pending = () => queue.length - taken;
  const idle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  say(
    "sweep",
    `${queries.length} queries × ${SHALLOW_PAGES} pages, ${CONC} at a time, topping up as it goes ` +
      `(a product assess names for its page-2 yield reads ${DEEP_PAGES} instead)`,
  );

  /** Said once, by whichever worker gets there first. Twenty workers reaching
   *  the same conclusion in the same second is one event, not twenty. */
  let outOfClock = false;

  const worker = async () => {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      /**
       * THE CLOCK, CHECKED WHERE THE MONEY IS SPENT.
       *
       * A query bought with less clock left than it takes to judge the hosts
       * already in hand is a query whose own hosts will certainly never be
       * judged: it costs SERP money to add rows to a list the rank phase will
       * not reach the end of. That is precisely what the measured run did for
       * its last minute of buying.
       *
       * The same expression the planner uses, so the two cannot disagree about
       * when a run is out of road — and O(1), which is why `hostsSeen` is a
       * running set rather than a fold.
       */
      /**
       * THE VERDICT BINDS EVERY WORKER. `outOfClock` is the out-of-time state,
       * distinct from `sealed` on purpose: `sealed` means the PLANNER is done
       * adding and the workers should drain what is queued — the normal end of
       * a run — while this means buying anything more is wrong. The two were
       * one flag, and the `!sealed` guard below meant the first worker to
       * notice the clock returned and every other worker sailed past the check
       * it had just disabled: a fixture run that started past its deadline
       * still bought all 12 queued queries and judged none of them.
       */
      if (outOfClock) return;
      // The estimation stop: enough market is in hand, so the next query buys
      // corroboration for a map already past its reading size. Binds every
      // worker exactly like the clock verdict, for the same reason.
      if (hostsSeen.size >= HOST_CEILING) {
        if (!sealed) {
          sealed = true;
          say(
            "sweep",
            `stopping the search: ${hostsSeen.size} distinct hosts is past this run's sizing of ~${HOST_CEILING} — ` +
              `the rest of the clock belongs to judging them`,
          );
        }
        return;
      }
      if (
        DEADLINE !== null &&
        secondsLeft() < rankSeconds(hostsSeen.size, undefined, RANK_CONC) + TAIL_SECONDS
      ) {
        outOfClock = true;
        sealed = true;
        say(
          "sweep",
          `stopping the search: ${hostsSeen.size} hosts already need about ` +
            `${Math.round(rankSeconds(hostsSeen.size, undefined, RANK_CONC) + TAIL_SECONDS)}s to judge and write, and ` +
            `${leftS()}s are left — buying more would only lengthen a list nobody gets to`,
        );
        return;
      }
      const planned = take();
      if (!planned) {
        // Nothing queued. Either the planner is about to add more, or it has
        // decided the map is done and this worker is finished.
        if (sealed) return;
        await idle(200);
        continue;
      }
      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      inFlightSum += inFlight;
      inFlightSamples += 1;
      try {
        await runOne(planned);
      } finally {
        inFlight -= 1;
      }
      ran += 1;
      // Every tenth, and the last. Not "whenever the queue is empty": with more
      // workers than queued queries that is true on every completion, and the
      // log becomes one line per query.
      if (ran % 10 === 0 || (sealed && ran === queue.length)) {
        say(
          "sweep",
          `  ${ran}/${queue.length} queries — ${hits.length} results so far`,
        );
      }
    }
  };

  const planner = async () => {
    while (rounds < MAX_WAVES) {
      // Wait for the queue to run low rather than empty: a refill that lands
      // while workers are still busy is a refill nobody waited for.
      while (!sealed && pending() > Math.floor(CONC / 2)) {
        if (signal?.aborted) return;
        await idle(250);
      }
      if (sealed || signal?.aborted) return;

      /**
       * AND THEN FOR WHAT IS STILL IN THE AIR TO LAND.
       *
       * `taken` advances when a worker PULLS a query (`take()`), not when the
       * search returns, so the wait above is satisfied while the whole round
       * is still in flight. Everything below reads `distinctHosts()` — the
       * host count handed to `assess`, the ceiling checks, the clock estimate
       * — and all of it was being read off a map whose results had not
       * arrived. MEASURED on runs/sweep-cursor-com-20260823082435.json: the
       * opening hand of 22 queries was dealt to 32 workers, every one was
       * taken within a second, and the first assess fired at 22s against
       * ZERO hosts. The model was told the map was empty and answered "No
       * hosts, no companies, no communities — all prior queries appear to
       * have returned nothing or failed to record any results", then widened
       * on that. Its next line, eight seconds later, was round 1 adding 72
       * hosts.
       *
       * `ran` is the landed counter — incremented after `runOne` returns, and
       * every `return` in the worker sits ABOVE `take()`, so a query that was
       * taken always reaches it. The queue is already drained to half here, so
       * the workers are mostly idle and this costs about one SERP round trip
       * rather than a round; it is emphatically NOT a wait for the round to
       * finish, which would serialise assess against searching and cost
       * minutes. Bounded, because a wait with no ceiling is a hang: past
       * LANDING_GRACE_MS the planner proceeds on what it has, which is the
       * old behaviour and still better than nothing.
       */
      const landingBy = Date.now() + LANDING_GRACE_MS;
      while (!sealed && ran < taken && Date.now() < landingBy) {
        if (signal?.aborted) return;
        await idle(250);
      }
      if (sealed || signal?.aborted) return;

      const before = distinctHosts().size;

      /**
       * CAN THIS RUN AFFORD ANOTHER ROUND — asked before the assess call, not
       * after it.
       *
       * Assessing is itself a model call of 15-25 seconds against a prompt
       * carrying sixty host names, and a run with no room left is a run that
       * must not pay for the opinion. Both refusals below therefore happen
       * here, above the spend, and both leave `sealed` set so the workers drain
       * what is queued and the run moves on to rank rather than stopping.
       *
       * The first is the budget the caller sized: queries fired, against the
       * ceiling. The second is the clock, and it is the one the budget cannot
       * do on its own — the budget is arithmetic over a MEDIAN yield of 13
       * hosts per query and the measured spread is 7 to 17, so a run that drew
       * the high end has already bought more rank work than its query count
       * predicted. Asking `can I still judge what I have?` reads the hosts that
       * actually landed instead of the ones a median said would.
       */
      if (distinctHosts().size >= HOST_CEILING) {
        say(
          "plan",
          `not widening: ${distinctHosts().size} distinct hosts is already past this run's sizing of ~${HOST_CEILING}`,
        );
        sealed = true;
        return;
      }
      if (QUERY_CEILING !== null && asked.length >= QUERY_CEILING) {
        say(
          "plan",
          `${asked.length} queries fired of the ${QUERY_CEILING} this run was sized for — not widening, ` +
            `the rest of the clock belongs to judging what came back`,
        );
        sealed = true;
        return;
      }
      if (DEADLINE !== null) {
        const need = rankSeconds(before, undefined, RANK_CONC) + TAIL_SECONDS;
        const left = secondsLeft();
        if (left < need) {
          say(
            "plan",
            `not widening: ${before} hosts still need about ${Math.round(need)}s to judge and write, ` +
              `and there are ${leftS()}s left`,
          );
          sealed = true;
          return;
        }
      }
      // Per-family and per-product yield, computed from what was actually
      // asked and what actually landed — the table the widening judgement
      // reads. O(asked + hits) per round via byQ below, not O(hits × asked):
      // every product now gets funded (no funding contest capping `asked`),
      // so a `.find` per hit over a several-thousand-row `asked` would make
      // this quadratic in the run's own size, rebuilt every round.
      const hostOfHit = (u: string) => {
        try {
          return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
        } catch {
          return "";
        }
      };
      const famTable = (() => {
        const rowsByFam = new Map<
          string,
          { asked: number; hosts: Set<string> }
        >();
        const rowsByProd = new Map<
          string,
          { asked: number; hosts: Set<string> }
        >();
        const byQ = new Map(asked.map((x) => [x.q, x]));
        for (const q of asked) {
          const f = rowsByFam.get(q.family) ?? {
            asked: 0,
            hosts: new Set<string>(),
          };
          f.asked += 1;
          rowsByFam.set(q.family, f);
          if (q.product) {
            const p = rowsByProd.get(q.product) ?? {
              asked: 0,
              hosts: new Set<string>(),
            };
            p.asked += 1;
            rowsByProd.set(q.product, p);
          }
        }
        for (const h of hits) {
          const q = byQ.get(h.q);
          if (!q) continue;
          const host = hostOfHit(h.url);
          if (!host) continue;
          rowsByFam.get(q.family)?.hosts.add(host);
          if (q.product) rowsByProd.get(q.product)?.hosts.add(host);
        }
        const famLines = [...rowsByFam.entries()].map(
          ([f, v]) =>
            `  ${f} — ${v.asked} queries, ${v.hosts.size} distinct hosts`,
        );
        const prodLines = [...rowsByProd.entries()].map(
          ([p, v]) => `  ${p} — ${v.asked} queries, ${v.hosts.size} hosts`,
        );
        return {
          families: famLines.join("\n"),
          products: prodLines.join("\n"),
        };
      })();
      /**
       * PAGE-2 YIELD, PER PRODUCT — the evidence `assess`'s `deepen` verdict is
       * asked to act on, not a guess.
       *
       * Every query opens at SHALLOW_PAGES, so by the time this runs a
       * product's queries already hold both of its first two pages: ranks 1-10
       * and 11-20. `rank` can be trusted as genuinely global across pages here
       * — `brightdata.ts` builds it from each page's own offset rather than
       * the wire's own `global_rank`, which restarts every page and was
       * measured to disagree (max observed `bestRank` was 16 across 10,218
       * stored entities from 4-page runs, impossible if page 3/4 hits carried
       * ranks 21-40 under the old field). A product whose second page kept
       * finding hosts the first did not is a market this run has not finished
       * reading at this depth; one whose second page mostly repeated the first
       * is already saturated here, and DEEP_PAGES on it would buy
       * corroboration, not coverage.
       *
       * Untagged queries (the model's own free-form `queries`, which carry no
       * `product` — see the `depth` lookup in `runOne`) are excluded the same
       * way `famTable`'s per-product rows are: there is no product to credit
       * the yield to.
       */
      const pageYield = (() => {
        const byQ = new Map(asked.map((x) => [x.q, x]));
        const byProd = new Map<
          string,
          { page1: Set<string>; page2: Set<string> }
        >();
        for (const h of hits) {
          const q = byQ.get(h.q);
          if (!q?.product || h.rank === undefined) continue;
          const host = hostOfHit(h.url);
          if (!host) continue;
          const b = byProd.get(q.product) ?? {
            page1: new Set<string>(),
            page2: new Set<string>(),
          };
          if (h.rank <= 10) b.page1.add(host);
          else if (h.rank <= SHALLOW_PAGES * 10) b.page2.add(host);
          byProd.set(q.product, b);
        }
        const lines = [...byProd.entries()].map(([p, b]) => {
          const fresh = [...b.page2].filter((h) => !b.page1.has(h)).length;
          return `  ${p} — page 1: ${b.page1.size} hosts, page 2 added ${fresh} not already on page 1`;
        });
        return {
          text:
            lines.join("\n") || "  (no product has two full pages of ranked results yet)",
          // The only product names `deepen` may act on — a name the model
          // invents that never asked a ranked query is silently ignored where
          // the verdict is applied, exactly like `draw` ignores an unknown
          // product against `reserve`.
          known: new Set(byProd.keys()),
        };
      })();
      const reserveLines =
        [...reserve.entries()]
          .filter(([, v]) => v.length)
          .map(
            ([p, v]) =>
              `  ${p} — ${v.length} held: ${v.map((x) => `"${x.q}"`).join(", ")}`,
          )
          .join("\n") || "  (all reserves released)";

      /**
       * AN OPINION ABOUT WHETHER TO BUY MORE MUST NOT BE ABLE TO END THE RUN.
       *
       * `call` retries once and then throws, and this planner runs inside the
       * same `Promise.all` as the search workers — so an assess call that
       * failed twice rejected the whole search phase and `sweep()` with it.
       * Measured: the cursor.com run on 2026-08-23 died at 796s with 618
       * hosts bought and $0.41 spent, on "No object generated: could not
       * parse the response" from its sixth assess call. Everything paid for
       * was discarded over a question whose worst honest answer is "stop
       * widening" — which is exactly what a failure now means. Sealed, the
       * workers drain what is queued and the run moves on to judge, the same
       * fail-open shape triage has for its own calls.
       */
      const AssessVerdict = z.object({
          enough: z
            .boolean()
            .describe(
              "is this a map worth showing, or is something obviously missing?",
            ),
          missing: z
            .string()
            .describe("what is thin or absent, one line. Empty if nothing is."),
          draw: z
            .array(z.object({ product: z.string(), n: z.number() }))
            .describe(
              "reserve template queries to release, per product. Empty if none.",
            ),
          queries: z
            .array(PlannedQuery)
            .describe(
              "fresh debranded queries aimed at what no template can reach. Empty if enough.",
            ),
          // Optional, unlike its three siblings above: this field is younger
          // than they are, and every existing assess fixture in this repo's
          // tests was written before it existed. Required would make every
          // one of those a validation failure over a field the test has no
          // opinion on; optional lets an absent answer mean exactly what a
          // model saying nothing about depth should mean — stay shallow.
          deepen: z
            .array(z.string())
            .optional()
            .describe(
              "products (name exactly as listed under page-2 yield) whose second page kept " +
                "finding hosts the first did not — read four pages instead of two for these " +
                "next wave. Empty or omitted if none earned it.",
            ),
      });
      const assessPrompt = prompt("assess", {
          anchor,
          sells: decomp.sells,
          buyer: decomp.buyer,
          capabilities: decomp.capabilities
            .map((c) => `  ${c.name}`)
            .join("\n"),
          waves: `${rounds + 1} round${rounds === 0 ? "" : "s"}`,
          hosts: before,
          asked: asked.length,
          angles: asked
            .map((q) => `  ${q.intent} · ${q.platform} — ${q.q}`)
            .join("\n"),
          sample: [...distinctHosts()].slice(0, 60).join(", "),
          families: `${famTable.families}\n${famTable.products}`,
          pageYield: pageYield.text,
          reserve: reserveLines,
          saturation: !lastRound.fired
            ? "(no widening round has fired yet)"
            : lastRound.hits === 0
              ? "the last round's queries returned no results at all — a different shape, not more of that one"
              : `${Math.round((100 * (lastRound.hits - lastRound.gained)) / lastRound.hits)}% of the last round's ${lastRound.hits} results were hosts already on the map (${lastRound.gained} new)`,
      });
      let verdict: z.infer<typeof AssessVerdict>;
      try {
        verdict = await call(
          "plan",
          "assess",
          AssessVerdict,
          assessPrompt,
          // A judgement about whether to spend more money. Cheap, and rare.
          // 20,000 because 8,000 was not enough: medium effort against a prompt
          // carrying sixty host names and every query already asked spent the
          // whole budget thinking and returned nothing.
          { think: "medium", maxOutputTokens: 20_000 },
        );
      } catch (e) {
        // `call` has already retried once; a second failure surfaces here.
        // This planner runs inside the same `Promise.all` as the search
        // workers, so letting it throw rejected the whole search phase and
        // `sweep()` with it. Measured: the cursor.com run on 2026-08-23 died
        // at 796s with 618 hosts bought and $0.41 spent, on "No object
        // generated: could not parse the response" from its sixth assess
        // call — everything paid for discarded over a question whose worst
        // honest answer is "stop widening". That is what a failure now means:
        // sealed, the workers drain what is queued and the run moves on to
        // judge, the same fail-open shape triage has for its own calls.
        say(
          "plan",
          `assess failed twice (${(e as Error).message.split("\n")[0]}) — not widening further; ` +
            `judging the ${distinctHosts().size} hosts already found`,
        );
        sealed = true;
        return;
      }

      // The world moved while this call was in flight — 15-25 seconds of it.
      // A worker that ran out of clock (or the run being cancelled) seals the
      // queue and goes home, and queueing behind an empty pool would add rows
      // to `asked` that nothing will ever buy: `report.queries` counts what was
      // FIRED, and a plan nobody executed must not inflate it.
      if (sealed || signal?.aborted) return;

      // Recorded before any of the stop rules below: a round that goes on to
      // seal this run should still keep what `assess` learned, and a round
      // that proceeds via the MIN_WAVES override a few lines down needs
      // `depthByProduct` already updated when it fires its own queries.
      // `pageYield.known` is the same guard `draws` below applies against
      // `reserve` — a product name the model invents that never asked a
      // ranked query is ignored rather than trusted. Deepening never reverts:
      // a product already `"deep"` just gets named again, which is a no-op.
      for (const p of verdict.deepen ?? []) {
        if (!pageYield.known.has(p) || depthByProduct.get(p) === "deep")
          continue;
        depthByProduct.set(p, "deep");
        say(
          "plan",
          `${p}: page 2 kept finding hosts page 1 did not — reading ${DEEP_PAGES} pages for it from here`,
        );
      }

      // queries.length === 0 alone no longer means "enough": the prompt now
      // tells the model to release reserve instead of inventing when a
      // template covers the gap, so a widening round can legitimately carry
      // zero fresh queries and a non-empty draw. Only seal here when there is
      // neither.
      const saidEnough =
        verdict.enough ||
        (verdict.queries.length === 0 && !verdict.draw?.length);
      // The floor outranks the mood, never the money: an "enough" before
      // MIN_WAVES rounds is noted and overridden, and the round proceeds on
      // whatever the model DID propose — or, when it proposed nothing, on
      // reserve alone via the draw-everything fallback below.
      if (saidEnough && rounds + 1 < MIN_WAVES) {
        say(
          "plan",
          `the model said enough after ${rounds + 1} round${rounds === 0 ? "" : "s"} — this run's floor is ${MIN_WAVES}, widening anyway`,
        );
      } else if (saidEnough) {
        say(
          "plan",
          `enough — ${before} hosts${verdict.missing ? ` (noted gap: ${verdict.missing})` : ""}`,
        );
        sealed = true;
        return;
      }

      // The floor's fallback: an overridden "enough" may arrive with nothing
      // proposed, and a widening round with no queries would stop the run at
      // the very gate the floor exists to hold open. Reserve is the honest
      // source — templates already judged worth their family — so draw two
      // per product that still holds any.
      const draws =
        saidEnough && !(verdict.draw?.length || verdict.queries.length)
          ? [...reserve.entries()]
              .filter(([, held]) => held.length > 0)
              .map(([product]) => ({ product, n: 2 }))
          : (verdict.draw ?? []);

      // Reserve first: a held template is a query already judged worth its
      // family, so it outranks a freshly invented one.
      const released: SweptQuery[] = [];
      for (const d of draws) {
        const held = reserve.get(d.product);
        if (!held?.length) continue;
        for (const fq of held.splice(0, Math.max(1, Math.floor(d.n)))) {
          released.push({
            q: fq.q,
            intent: fq.family === "plain" ? "evaluation" : "switching",
            platform: "web",
            why: fq.why,
            market: asked.find((x) => x.product === fq.product)?.market ?? "",
            family: fq.family,
            product: fq.product,
            term: fq.term,
          });
        }
      }

      // Never ask the same thing twice. The planner sees what has been asked,
      // but it is writing under time pressure against a moving map and a repeat
      // is a query bought for nothing.
      const seen = new Set(asked.map((q) => q.q.trim().toLowerCase()));
      // Untagged by product or template — the assess call widens on a gap it
      // named in prose, not a reserve slot, so "debranded" is the honest family
      // for a query written free-form rather than drawn from a hand. Reserve
      // draws above carry their own product and family through.
      const fresh: SweptQuery[] = verdict.queries
        .filter((q) => !seen.has(q.q.trim().toLowerCase()))
        // 20: a round's fresh-invention allowance, distinct from the reserve
        // releases above, which are pre-judged and uncapped here.
        .slice(0, 20)
        .map((q) => ({ ...q, family: "debranded" as const }));

      // Both the dedupe set and the anchor-naming filter, applied to
      // EVERYTHING this round wants to fire — reserve releases included. The
      // opening batch got both checks (`named`/`banned` above); before this
      // fix the widening loop gave reserve releases NEITHER (a strip term or
      // coinage whose opening query got dropped could still fire once its
      // reserve template was drawn later) and gave `fresh` only the dedupe,
      // checked once against a `seen` that never grew as items were accepted.
      // Two products drawing reserve text that collides ("best <term>" on a
      // shared term) could both land in `asked`, silently reassigning the
      // `byQ`/`marketOf`/`familyOf` last-write-wins maps built from it further
      // down. `seen` grows as each candidate is accepted, so a collision
      // between two released queries — not just between released and
      // already-asked — is caught too.
      const proposed = [...released, ...fresh];
      const widened: SweptQuery[] = [];
      // What the ceiling leaves for this round — at least 1, because a round
      // that begins with the budget already spent returned above without paying
      // for the assess call. Counted as the survivors are collected rather than
      // sliced off afterwards, so a query the budget could not afford is never
      // marked seen: it stays proposable, which matters only if a later round
      // happens and costs nothing if none does.
      const room =
        QUERY_CEILING === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, QUERY_CEILING - asked.length);
      let refused = 0;
      let unaffordable = 0;
      for (const q of proposed) {
        const k = q.q.trim().toLowerCase();
        if (seen.has(k) || banned(q.q, q.family, anchorBanName, banCoinages)) {
          refused += 1;
          continue;
        }
        if (widened.length >= room) {
          unaffordable += 1;
          continue;
        }
        seen.add(k);
        widened.push(q);
      }
      if (refused) {
        think(
          "plan",
          `round ${rounds + 1}: dropped ${refused} widened queries — duplicate or named the anchor`,
        );
      }
      if (unaffordable) {
        say(
          "plan",
          `round ${rounds + 1}: the model wanted ${unaffordable} more queries than this run's budget of ` +
            `${QUERY_CEILING} has left — firing ${widened.length}, which is the last of them`,
        );
      }
      if (!widened.length) {
        say(
          "plan",
          `round ${rounds + 1}: every suggested query had already been asked — stopping`,
        );
        sealed = true;
        return;
      }

      rounds += 1;
      say(
        "plan",
        `round ${rounds}: ${verdict.missing || "widening"} — ${released.length} drawn from reserve, ${fresh.length} freshly written — ${widened.length} queries queued`,
      );
      think(
        "plan",
        `after ${before} hosts the model wants more: ${verdict.missing}`,
      );
      asked.push(...widened);
      queue.push(...widened);
      // The mark for this round's saturation: rows in hand before any of the
      // round's own results land.
      const hitsAtRoundStart = hits.length;


      // Yield floor, measured once the round's queries have actually landed.
      // A round that adds almost nothing means the queries are reaching ground
      // already covered, and the next one would buy corroboration.
      const mine = queue.length;
      while (!sealed && taken < mine && !signal?.aborted) await idle(250);
      const gained = distinctHosts().size - before;
      // The saturation the NEXT assess call reads: of everything this round's
      // queries returned, what share was ground already covered. hits.length
      // moves as results land, so the round's share is measured against the
      // mark taken when the round was queued.
      const roundHits = hits.length - hitsAtRoundStart;
      lastRound.fired = true;
      lastRound.hits = roundHits;
      lastRound.gained = gained;
      say(
        "sweep",
        `round ${rounds} added ${gained} new hosts (${distinctHosts().size} total)`,
      );
      if (gained < MIN_NEW_HOSTS) {
        say(
          "plan",
          `round ${rounds} added only ${gained} — stopping, further queries are buying corroboration`,
        );
        sealed = true;
        return;
      }
    }
    sealed = true;
  };

  await Promise.all([...Array.from({ length: CONC }, worker), planner()]);

  // ── 3¼. listicle harvest: vendors a roundup named but this run never asked
  // about ──────────────────────────────────────────────────────────────────
  //
  // See `SweepOptions.listicleHarvest` for the contract. DEFAULT ON since
  // 2026-08-22: the A/B this flag was gated on found Windsurf, Zed, Tabnine,
  // Codeium, Aider and Continue on cursor.com with zero direct SERP hits
  // across 66 queries, and 18 real vendors on grundfos.com, for one model
  // call at ~4s and ~$0.0003 — a clear win kept opt-OUT-able for
  // `OPENKB_LISTICLE_HARVEST=0`. Additive only, and every failure fails
  // open — a call that throws, or a scan that finds nothing worth asking
  // about, leaves the map exactly as the search phase already built it. Run
  // here, before the host fold below, so whatever it buys folds and judges
  // exactly like everything else the search phase found — no second path
  // through the pipeline for what it surfaces.
  const LISTICLE_HARVEST = opts.listicleHarvest !== false;
  let listicleRowsScanned = 0;
  let listicleVendorsFound = 0;
  let listicleQueriesFired = 0;
  if (LISTICLE_HARVEST) {
    const roundupRows = hits
      .filter((h) => ROUNDUP_SHAPE.test(h.title) || ROUNDUP_SHAPE.test(h.description ?? ""))
      .slice(0, LISTICLE_MAX_ROWS);
    listicleRowsScanned = roundupRows.length;
    if (roundupRows.length > 0) {
      say(
        "sweep",
        `listicle harvest: ${roundupRows.length} roundup-shaped rows may carry vendor names this run never searched for`,
      );
      try {
        const rows = roundupRows
          .map((h) => `"${h.title}" — ${(h.description ?? "").slice(0, 200)}`)
          .join("\n");
        const out = await call(
          "listicle",
          `listicle harvest: ${roundupRows.length} rows`,
          z.object({
            vendors: z
              .array(z.string())
              .describe("distinct vendor/company names the rows mention, each written once"),
          }),
          prompt("listicle", { anchor, rows }),
          { think: "none", maxOutputTokens: 1_500 },
        );
        // A name already IN this run's own hand buys nothing: `hostsSeen`
        // holds every host the search phase has found so far, and a vendor
        // whose normalized label already shows up inside one of those hosts
        // already has a query running for it somewhere in this run.
        //
        // SUBSTRING, AND CHECKED RATHER THAN ASSUMED SAFE. This file's judge
        // learned the hard way that substring matching counts "radio.com" as
        // naming "io.com", and boundary-matched it. The rule here looks like
        // the same mistake and mostly is not. Measured over 1,177 entity
        // names on a cloudflare run, twelve are matched only through a host
        // that is not their own registrable domain, and eleven of the twelve
        // are RIGHT: go.lightnode.com really is LightNode, info.nvidia.com is
        // NVIDIA, cpl.thalesgroup.com is Thales, classic-app.nft.storage is
        // NFT.Storage. Substring is what catches those, and a boundary rule
        // would send the harvest off to re-search vendors the run already has.
        //
        // One of the twelve is a genuine false drop: "Geo", swallowed by
        // edGEOne.ai and imaGEOptim.com. That is the whole failure mode —
        // names of three or four characters — and it costs one query out of
        // twenty on a name the roundups barely mentioned.
        //
        // Left alone deliberately. The cheap "fix" is a boundary match, and
        // the measurement says it would break eleven correct drops to save
        // one wrong one.
        const knownLabel = (name: string): boolean => {
          const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (!norm) return true;
          for (const host of hostsSeen)
            if (host.toLowerCase().replace(/[^a-z0-9]/g, "").includes(norm)) return true;
          return false;
        };
        const fresh = [...new Set(out.vendors.map((v) => v.trim()).filter(Boolean))].filter(
          (v) => !knownLabel(v) && !banned(v, "rival", anchorBanName, banCoinages),
        );
        listicleVendorsFound = fresh.length;
        /**
         * MOST-MENTIONED FIRST, because this cap cuts hard and the model's
         * own order is thematic rather than ranked.
         *
         * `rivalHand(fresh, LISTICLE_MAX_QUERIES)` only ever touches
         * `fresh.slice(0, 14)` — two thirds of the budget goes to
         * `<name> alternatives` and the rest to `vs` pairs drawn from the
         * same prefix — so 14 of the 54 names one shopify run harvested got
         * a query and 40 got nothing.
         *
         * Which 14 was decided by the order the model happened to write them
         * in, and that order groups by category. On that run it listed
         * fourteen point-of-sale vendors, then four tax vendors, then the
         * ecommerce platforms — so the prefix was spent entirely on POS and
         * tax, and Adobe Commerce (21st), Magento (22nd) and Medusa (23rd)
         * were cut. Those are shopify's most direct rivals, and Magento and
         * Adobe Commerce were the second and third MOST corroborated names in
         * the whole list.
         *
         * The corroboration is free and the run already paid for it: how many
         * of the scanned roundup rows name the vendor. Across that harvest it
         * ran 6 for Square POS, 5 for Magento, 3 for Adobe Commerce and 1 for
         * most of the tail, which is enough to lift the handful that several
         * roundups agree on above the ones a single row mentioned in passing.
         *
         * Substring matching, deliberately crude: these are names read off
         * the same rows they are being counted in, so a name that appears at
         * all appears verbatim. It is a tie-break on an existing list, not a
         * gate — a name matched zero times keeps its place in the order the
         * model gave it, behind the ones that were corroborated.
         *
         * WHAT THE CUT ACTUALLY COST, on the two most recent shopify maps.
         * Neither contains Magento. Both contain seven vendors from Magento's
         * ECOSYSTEM — Meetanshi, Mageplaza, Amasty, Magestore, Webkul and
         * others, the extension shops and agencies that exist only because
         * Magento does — and no query on either run ever named the platform
         * at the centre of them. A map that knows the ecosystem and not the
         * thing it grew around is wrong in the way a reader notices first,
         * and this cap is why: the harvest found the name, ranked it second
         * for corroboration, and dropped it at list position 22.
         */
        const mentions = new Map<string, number>();
        for (const v of fresh) {
          const needle = v.toLowerCase();
          mentions.set(
            v,
            roundupRows.filter((h) =>
              `${h.title} ${h.description ?? ""}`.toLowerCase().includes(needle),
            ).length,
          );
        }
        // Stable: `sort` preserves the model's order inside a tie, and most of
        // the tail ties at one mention.
        fresh.sort((a, b) => (mentions.get(b) ?? 0) - (mentions.get(a) ?? 0));
        if (fresh.length > 0) {
          // The SAME machinery a name the anchor's own sitemap publishes
          // already gets — see `rivalHand` — not a second query-shape
          // generator for a second kind of third-party name.
          const harvested: SweptQuery[] = rivalHand(fresh, LISTICLE_MAX_QUERIES).map((fq) => ({
            q: fq.q,
            intent: fq.q.includes(" vs ") ? "evaluation" : "switching",
            platform: "web",
            why: fq.why,
            market: "",
            family: fq.family,
            product: undefined,
            term: fq.term,
          }));
          const room =
            QUERY_CEILING === null ? harvested.length : Math.max(0, QUERY_CEILING - asked.length);
          const toFire = harvested.slice(0, room);
          listicleQueriesFired = toFire.length;
          if (toFire.length > 0) {
            asked.push(...toFire);
            await Promise.all(toFire.map((q) => runOne(q)));
          }
          say(
            "sweep",
            `listicle harvest: ${fresh.length} unsurfaced vendor${fresh.length === 1 ? "" : "s"} named ` +
              `(${fresh.join(", ")}), ${toFire.length} fresh quer${toFire.length === 1 ? "y" : "ies"} fired`,
          );
        } else {
          say("sweep", "listicle harvest: no vendor named in those rows was new to this run");
        }
      } catch (e) {
        say("sweep", `listicle harvest call failed (${(e as Error).message}); no vendors added`);
      }
    }
  }

  /**
   * One entry per COMPANY, not per hostname.
   *
   * A docs or blog subdomain is the same company as its parent, and classifying
   * it separately produced a map where `docs.apify.com` was a competitor while
   * `apify.com` sat eleven rows above it. Measured on one map: three of the four
   * subdomain entities were exact duplicates of a parent in the same slice, and
   * the fourth was a blog whose actual vendor had never been captured at all.
   *
   * So a subdomain folds into its parent, and its rows come along: they are the
   * same company's evidence and the parent is the thing a reader can act on. A
   * parent nobody searched up still gets created, which is how the blog case
   * recovers the vendor rather than losing it.
   *
   * Only a documentation-shaped first label folds. Stripping every subdomain
   * would turn `news.ycombinator.com` into `ycombinator.com`, and Hacker News is
   * a community while Y Combinator is an accelerator: that is one company
   * swallowing a completely different entity. These labels name a section of a
   * site rather than a thing in its own right.
   *
   * `parentOf` is asked TWICE, and both places have to agree or the fold is
   * half a fold: here, where a row becomes a company's evidence, and in the
   * co-occurrence selector below, which read the raw host for as long as this
   * comment has existed and silently dropped every folded row it saw.
   */
  const SECTION = new Set([
    "docs",
    "doc",
    "documentation",
    "blog",
    "help",
    "support",
    "developer",
    "developers",
    "dev",
    "api",
    "learn",
    "kb",
    "guides",
    "changelog",
    "status",
  ]);
  const parentOf = (host: string): string => {
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    if (!SECTION.has(parts[0]!)) return host;
    return parts.slice(1).join(".");
  };

  const byHost = new Map<string, typeof hits>();
  let folded = 0;
  for (const h of hits) {
    let host: string;
    try {
      host = new URL(h.url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    const parent = parentOf(host);
    if (parent !== host) folded += 1;
    if (!byHost.has(parent)) byHost.set(parent, []);
    byHost.get(parent)!.push(h);
  }
  say(
    "sweep",
    `${hits.length} results, ${byHost.size} distinct hosts${folded ? ` (${folded} rows folded into a parent domain)` : ""}`,
  );

  // ── 4. judge every host from its own page ─────────────────────────────────
  /** Every query's own record, for the judge. The join existed at report time
   *  — "attribute every entity to the markets whose queries surfaced it" — and
   *  was withheld from the one model that could use it as evidence: a host
   *  that arrived through "mailchimp alternatives" (rival family) and one that
   *  arrived through a reddit thread are different claims about the same page. */
  const qMeta = new Map(asked.map((q) => [q.q, q]));
  /**
   * THE ANCHOR CANNOT COMPETE WITH ITSELF. MEASURED on a live cursor.com run:
   * the anchor's own host reached the judge and came back `kind: company,
   * relation: competitor` — the model arguing Cursor competes with Cursor.
   * Excluded HERE, before triage or `judgeHosts` ever sees the row, so the
   * fetch and the classify call are both saved rather than paid for and then
   * filtered from the verdict.
   *
   * Folded the same way the triage stage's own anchor exemption is (a few
   * dozen lines below): `hostList`'s keys are already `parentOf`-folded, so
   * comparing against `parentOf(anchor)` keeps an anchor given as
   * docs.foo.com excluding the foo.com row it folds into.
   */
  const anchorFolded = parentOf(anchor);
  const hostList = [...byHost.entries()]
    .filter(([host]) => host !== anchorFolded)
    .map(([host, hs]) => {
    const qs = [...new Set(hs.map((h) => h.q))];
    const foundBy =
      qs
        .slice(0, 3)
        .map((q) => {
          const m = qMeta.get(q);
          const bits = [
            m?.family,
            m?.market ? `market: ${m.market}` : undefined,
            m && m.platform !== "web" ? `on ${m.platform}` : undefined,
          ]
            .filter(Boolean)
            .join(", ");
          return `  "${q}"${bits ? ` (${bits})` : ""}`;
        })
        .join("\n") + (qs.length > 3 ? `\n  …and ${qs.length - 3} more` : "");
    return {
      host,
      /**
       * HOW MANY QUERIES SURFACED THIS HOST — and the reason judging cannot
       * start before the search finishes, which is worth stating here because
       * this line is where that constraint actually lives.
       *
       * Overlapping the judge with the search tail is a standing ~3-minute
       * idea (the search phase is ~9 minutes of a cloudflare run and the judge
       * ~6). It costs more than it did when it was first costed, because
       * `seenIn` is only final once every query has landed, and four separate
       * decisions now read it:
       *
       *   TRIAGE_KEEP_SEENIN  a host triage votes to DROP is kept anyway at 5+
       *   unlockSeenIn        the judge's own unlock ladder, at 3+
       *   earnedUnlock        the second look's escalation, at 2+
       *   mostCorroboratedFirst  the order both capped stages spend in
       *
       * Judge a host at seenIn 2 that the finished search would have put at 8
       * and all four misfire at once. The first is the one that cannot be
       * undone: triage's override exists precisely so a well-corroborated host
       * survives a bad verdict, and a host dropped there never reaches the
       * judge, the second look, or the map. The other three cost escalations
       * and ordering, which are recoverable in principle.
       *
       * So the three minutes are real and so is the price. Anyone attempting
       * it should either freeze nothing on `seenIn` until the search seals, or
       * only start early on hosts already past the highest bar of the four.
       */
      seenIn: qs.length,
      foundBy,
      intents: [...new Set(hs.map((h) => h.intent))],
      titles: [...new Set(hs.map((h) => h.title))].slice(0, 3),
      desc: hs[0]!.description?.slice(0, 190) ?? "",
      topHit: hs[0]?.url,
    };
  });

  // ── 3½. triage: which hosts are worth a judgement at all ─────────────────
  //
  // The judge's question, asked cheaper: not "what is this host" but "could it
  // plausibly belong on this map", answered in batches of TRIAGE_BATCH from
  // the search engine's own title and description, before any fetch is spent.
  // Skip is the only power this stage has, and every failure fails open — see
  // `SweepOptions.triage` for the contract, and the guard below for the one
  // code-side exemption. DEFAULT ON since 2026-08-22: the A/B this flag was
  // gated on skipped 123 of 926 hosts on the cursor.com run, buying back
  // their fetch and classify calls for ~$0.02 of triage calls — roughly
  // time-neutral, and kept opt-OUT-able for `OPENKB_TRIAGE=0`.
  const TRIAGE = opts.triage !== false;
  const triagedOut: Array<{ host: string; seenIn: number; why: string }> = [];
  /** Batches ATTEMPTED — incremented before the call, so this reconciles with
   *  the bill's byAgent line instead of publishing a second, smaller count
   *  when a batch fails open. `triageFailures` is the failed subset. */
  let triageCalls = 0;
  let triageFailures = 0;
  let judgeList = hostList;
  // The link pass's clock rule, applied at the head of the funnel too: with
  // only the write reserve left there is no judging phase for triage to
  // shrink, so the calls it would spend buy nothing. Null DEADLINE never
  // gates.
  const triageAffordable = DEADLINE === null || secondsLeft() > TAIL_SECONDS;
  if (TRIAGE && hostList.length > 0 && !triageAffordable) {
    say(
      "rank",
      `triage withheld: only the write reserve is left on the clock, every host goes to the judge`,
    );
  }
  if (TRIAGE && hostList.length > 0 && triageAffordable) {
    say(
      "rank",
      `triage: asking whether ${hostList.length} hosts belong on this map, from search metadata alone`,
    );
    const verdictByHost = new Map<string, { keep: boolean; why: string }>();
    const batches: Array<typeof hostList> = [];
    for (let i = 0; i < hostList.length; i += TRIAGE_BATCH)
      batches.push(hostList.slice(i, i + TRIAGE_BATCH));
    // Six in flight, the catalog stage's width: wide enough that twenty-odd
    // batches cost the slowest few, narrow enough that a rate-limited model
    // answers with pacing rather than a failed wave. A POOL, not chunked
    // waves — the same fix `runPool` documents for the link phase. Chunked,
    // this stage took 8.5 minutes on runs/sweep-cursor-com-20260823064255.json:
    // fourteen calls in three waves, and every wave waited out its slowest
    // member's 120s timeout plus retry while the other five workers idled.
    const TRIAGE_CONC = 6;
    await runPool(batches, TRIAGE_CONC, async (batch) => {
      const lines = batch
        .map(
          (h) =>
            `${h.host} — seen in ${h.seenIn} queries — "${(h.titles[0] ?? "").slice(0, 90)}" — ${h.desc.slice(0, 160)}`,
        )
        .join("\n");
      try {
        triageCalls += 1;
        const out = await call(
          "triage",
          `triage ${batch.length} hosts`,
          z.object({
            verdicts: z
              .array(
                z.object({
                  host: z.string().describe("the host, exactly as given"),
                  keep: z.boolean(),
                  why: z
                    .string()
                    .describe(
                      'one line making a skip plain; "kept" is enough for a keep',
                    ),
                }),
              )
              .describe("one row per host, every host answered"),
          }),
          prompt("triage", {
            anchor,
            sells: decomp.sells,
            buyer: decomp.buyer,
            hosts: lines,
          }),
          { think: "none", maxOutputTokens: TRIAGE_MAX_OUTPUT_TOKENS },
        );
        const askedHosts = new Set(batch.map((b) => b.host));
        for (const v of out.verdicts) {
          // A verdict for a host this batch never asked about is noise
          // from the model, not a decision about the map.
          if (askedHosts.has(v.host)) verdictByHost.set(v.host, v);
        }
      } catch (e) {
        triageFailures += 1;
        // Fail open: an unanswered batch is judged in full. The judge is
        // the stage that must not be skippable by an outage.
        say(
          "rank",
          `  a triage call failed (${(e as Error).message}); its ${batch.length} hosts go to the judge unfiltered`,
        );
      }
    });
    judgeList = [];
    for (const h of hostList) {
      const v = verdictByHost.get(h.host);
      // The exemption is code, not prompt: a host the market kept returning
      // is not skippable on a snippet, whatever the model thought of its
      // title. The anchor's own host needs no exemption of its own here any
      // more — hostList's construction (above) already excludes it before
      // triage or judgeHosts ever sees the row, so `h.host` can never equal
      // `parentOf(anchor)` at this point. The comparison stays as a second,
      // free line of defense: if that exclusion ever moved or narrowed,
      // triage would still refuse to be the reason the anchor disappears.
      if (
        v &&
        v.keep === false &&
        h.seenIn < TRIAGE_KEEP_SEENIN &&
        h.host !== parentOf(anchor)
      ) {
        triagedOut.push({ host: h.host, seenIn: h.seenIn, why: v.why });
      } else {
        judgeList.push(h);
      }
    }
    say(
      "rank",
      `triage kept ${judgeList.length} of ${hostList.length} hosts; ` +
        `${triagedOut.length} skipped unfetched, for ${triageCalls} calls` +
        (triageFailures ? ` (${triageFailures} failed open)` : ""),
    );
  }

  // Left null unless the caller supplies a real one. Calibration
  // (`scripts/calibrate-kernel.ts`) found no separation between vendor and
  // directory front pages on the measured sample, so shipping a guessed 12
  // would be arithmetic dressed as evidence. `report.kernel.threshold` below
  // carries this value through honestly, null included.
  const KERNEL_THRESHOLD = opts.aggregatorThreshold ?? null;
  say(
    "rank",
    `judging ${judgeList.length} hosts from their own front pages, predicates first` +
      (KERNEL_THRESHOLD === null
        ? ", aggregator rule off"
        : `, aggregator threshold ${KERNEL_THRESHOLD}`),
  );
  if (DEADLINE !== null) {
    const need = rankSeconds(judgeList.length, undefined, RANK_CONC) + TAIL_SECONDS;
    say(
      "rank",
      `about ${Math.round(need)}s of judging and writing left to do, ${leftS()}s of clock` +
        (need > secondsLeft()
          ? " — this will stop short and ship what it has"
          : ""),
    );
  }

  const entities: Entity[] = [];
  let judgedCount = 0;
  let rankedBuffer: Judged[] = [];
  const flushRanked = () => {
    const kept = rankedBuffer.filter(onMap);
    if (kept.length) {
      emitResult("rank", {
        kind: "ranked",
        candidates: kept.map((e) => ({
          domain: e.domain,
          name: e.name || e.domain,
          kind: e.kind,
          relation: e.relation,
          what: e.what,
          why: e.because ?? e.why,
          breadth: byHost.get(e.domain)?.length ?? 0,
        })),
      });
    }
    rankedBuffer = [];
  };

  /**
   * The judge's one paid question, hoisted out of the `judgeHosts` deps so the
   * second-look stage below can re-ask EXACTLY it — same prompt, same schema —
   * against a deeper page. Two hand-typed copies of this schema would drift;
   * the only thing a caller chooses is the billing label the call is booked
   * under, so the bill's byAgent line can say which spend was whose.
   */
  const classifyHost =
    (agent: "rank" | "second-look") =>
    async (h: HostCandidate, pageText: string) => {
      const out = await call(
        agent,
        `classify ${h.host}`,
        z.object({
          name: z.string(),
          kind: z.enum(CLASSIFY_KINDS),
          what: z
            .string()
            .describe("what it is, one line, from the page itself"),
          relation: z.enum(RELATIONS),
          // Declared here, right after `relation` and before `why`/`spans`,
          // because classify.md:65-66 has always told the model to answer in
          // exactly this order — state the decisive fact, THEN back it with
          // evidence — but the schema used to declare `reasoning` after
          // `spans`, contradicting its own prompt. Structured-output decoding
          // fills fields in schema-declaration order, not prompt-mention
          // order: a model asked for the mechanism only after it had already
          // spent its output on two required fields (`why`, `spans`) had
          // every incentive to treat this trailing optional field as done.
          // Measured on the cursor.com run (docs/overnight-backlog.md,
          // P1-6): 202 of 776 entities (26%) carried a `reasoning`, against
          // 85% for `relationSpan` — the other optional field, which sits
          // right after its own required counterpart (`spans`) rather than
          // after an unrelated one. Not `.min(1)`, and still optional: every
          // existing fixture and test script across this suite answers the
          // classify schema without it, and a required field the mock model
          // never supplies fails `generateObject`'s own zod parse before the
          // engine sees a response — the same failure a real provider that
          // dropped a field would cause.
          reasoning: z
            .string()
            .optional()
            .describe(
              "one sentence: the single decisive fact that settled kind and relation",
            ),
          why: z
            .string()
            .describe("why it belongs on this map, stated against the anchor"),
          spans: z
            .array(z.string())
            .min(1)
            .max(3)
            .describe(
              "1-3 short quotes copied character-for-character from the page, together backing the what",
            ),
          relationSpan: z
            .string()
            .min(8)
            .optional()
            .describe(
              "one quote copied character-for-character from the page, backing the RELATION specifically, not the what",
            ),
        }),
        prompt("classify", {
          anchor,
          sells: decomp.sells,
          buyer: decomp.buyer,
          host: h.host,
          seenIn: String(h.seenIn),
          foundBy: h.foundBy ?? "  (road not recorded)",
          page: pageText,
        }),
        { think: "none", maxOutputTokens: CLASSIFY_MAX_OUTPUT_TOKENS },
      );
      // `relationSpan` gets the same containment check `spans` gets inside
      // judgeHosts (checkQuote: a literal substring of this exact page text,
      // whitespace-squashed, case-folded) — done here, not there, because this
      // closure is the one place that still holds `pageText` once judgeHosts'
      // rigid `JudgeDeps.classify` return type has narrowed it away. Measured,
      // never gating: `relationGrounded` records the fact and nothing below
      // ever reads it to reject a verdict, the same rule `descGrounded` lives
      // by two calls downstream of this one.
      return {
        ...out,
        relationGrounded: checkQuote(pageText, out.relationSpan ?? "") === "ok",
      };
    };

  const judged = await judgeHosts(judgeList, {
    fetcher,
    anchor,
    aggregatorThreshold: KERNEL_THRESHOLD,
    // A blocked front page on a host three distinct queries surfaced earns
    // one unlocked retry (~$0.008) before settling as unreadable — measured
    // at ~$0.11 a run against 17% of the map shipping as blank nodes.
    // OPENKB_RANK_UNLOCK=0 turns it off.
    unlockSeenIn: Math.max(
      0,
      Math.floor(Number(process.env.OPENKB_RANK_UNLOCK ?? 3) || 0),
    ),
    // The rank pool is the run's longest phase: free direct fetches plus one
    // short model call per residue host. 8 was the kernel's launch width;
    // OPENKB_RANK_CONCURRENCY raises it when the model provider's rate allows
    // — doubling the pool roughly halves the phase, and a provider that
    // objects answers with 429s the caller will see, not silent loss.
    concurrency: RANK_CONC,
    signal,
    /**
     * THE BACKSTOP, and the last place a run can still choose to be smaller.
     *
     * Every earlier check is a prediction — the caller's budget, the planner's
     * projection — and both are arithmetic over a median host yield with a
     * two-and-a-half-fold spread. This one is not a prediction: it reads the
     * clock between hosts and leaves with what it has when only the tail is
     * left. The alternative, which is what the measured run did, is to be
     * killed mid-phase with every host judged so far thrown away along with the
     * money that bought them.
     *
     * Undefined on the CLI, where `DEADLINE` is null and the pool runs the
     * whole list exactly as before.
     */
    stop: DEADLINE === null ? undefined : () => secondsLeft() <= TAIL_SECONDS,
    onFetch: (url, ok, ms) => {
      bill("fetch", "rank", 0, ms, ok);
      spans.emit({
        runId,
        agentId: "rank",
        parentId: null,
        kind: "fetch",
        name: "fetch",
        argsDigest: url,
        ms,
        ok,
        usd: 0,
      });
    },
    onJudged: (e) => {
      rankedBuffer.push(e);
      judgedCount += 1;
      // The judgement itself, to the reading panel, as it lands — the batch
      // classifier's think line, restored to the per-host path.
      const line = rankThinkLine(e);
      if (line) think("rank", line);
      if (rankedBuffer.length >= 25) flushRanked();
      if (judgedCount % 50 === 0)
        say("rank", `  judged ${judgedCount}/${judgeList.length}`);
    },
    classify: classifyHost("rank"),
  });
  flushRanked();
  if (signal?.aborted) throw new Error("aborted");
  entities.push(...judged.entities.map((e) => ({ ...e }) as Entity));
  // The triage skips, recorded beside the judged: same host census, honest
  // provenance. `noise`/`none` keeps them off the map exactly as a judged
  // noise verdict would; `settledBy: "triage"` plus the model's sentence says
  // this one was never fetched, so a reader can tell a $0 skip from a $ judged
  // rejection.
  for (const t of triagedOut) {
    entities.push({
      name: t.host,
      domain: t.host,
      kind: "noise",
      relation: "none",
      what: "",
      why: t.why,
      settledBy: "triage",
      because: `triage: ${t.why}`,
      seenIn: t.seenIn,
    });
  }
  say(
    "rank",
    `${judged.stats.settledFree} hosts settled by predicate for $0; ${judged.stats.modelJudged} judged by the model` +
      (TRIAGE ? `; ${triagedOut.length} skipped by triage unfetched` : ""),
  );
  /** Hosts the run found and never judged, because the clock ran out on the
   *  pool. Zero on every run that finished the list — which is every run
   *  without a deadline. Reported rather than absorbed: a map of 300 entities
   *  drawn from 900 hosts is a different claim from a map of 300 entities. */
  const unjudged = judgeList.length - judged.entities.length;
  if (unjudged > 0) {
    say(
      "rank",
      `stopped ${unjudged} hosts short of the ${judgeList.length} kept for judging — the clock ran out, so the run is ` +
        `writing the ${judged.entities.length} it judged instead of losing all of them`,
    );
  }

  // ── 4½. second look: one more page for the hosts the judge left unplaced ──
  //
  // The judge answers from the front page, and a front page that answers
  // nothing leaves the host on the map as `unknown` — wearing the refusal.
  // The search itself already surfaced a better page for most of them:
  // `topHit`, the first hit's URL out of `byHost`, often a docs, pricing or
  // comparison page deeper than the front door the judge read. One more free
  // direct fetch each, the SAME classify call, and only a verdict that places
  // the host with quotes verified against the page it read may replace the
  // first judgement — see `SweepOptions.secondLook` for the contract.
  // DEFAULT ON since 2026-08-22: the A/B this flag was gated on rescued 12
  // of 23 and 13 of 22 unplaced hosts across two runs, for ~$0.005 — kept
  // opt-OUT-able for `OPENKB_SECOND_LOOK=0`.
  const SECOND_LOOK = opts.secondLook !== false;
  /** Attempts, counted before the fetch — the same convention as
   *  `triageCalls`, so the report reconciles with the bill when a look fails
   *  open partway through. `secondLookRescued` is the replaced subset. */
  /** How many hosts the stage HAD to choose from, against the `asked` it could
   *  afford. The cap binds on every run since the snippet gate — 151 unplaced
   *  against 60 looks on one — and until now that only appeared in a `say()`
   *  line, so a reader of the report alone could not tell a run that looked at
   *  everything from one that looked at a third of it. Same reason `PAIR_CAP`
   *  learned to report its own cut. */
  let secondLookUnplaced = 0;
  let secondLookAsked = 0;
  let secondLookRescued = 0;
  /** Looks that failed OPEN — an unreadable page or a thrown call. Counted so
   *  the census can say so, the triage stage's own convention. */
  let secondLookFailed = 0;
  /** Unlocker escalations spent on a second-look fetch that came back blocked.
   *  Bounded by SECOND_LOOK_UNLOCK_BUDGET, checked before every escalation so
   *  the count never runs past it. */
  let secondLookUnlocked = 0;
  // The same clock rule as the paid link pass: a deadline-bound run that is
  // down to its write reserve ships what it judged rather than spending the
  // reserve on second chances. Null DEADLINE — every CLI run — never gates.
  const secondLookAffordable =
    DEADLINE === null || secondsLeft() > TAIL_SECONDS;
  if (SECOND_LOOK && !secondLookAffordable) {
    say(
      "rank",
      `second look withheld: only the write reserve is left on the clock, so the first judgements stand`,
    );
  }
  /** The host row behind an entity, for the two capped stages below that both
   *  need to know how well corroborated a host was before they choose which
   *  ones to spend on. Hoisted out of the second look when drop-confirm turned
   *  out to need exactly the same read. */
  const rowOf = new Map(hostList.map((h) => [h.host, h]));
  /** The same `bestRank` the report section computes on entities later —
   *  earlier here, because both capped stages below need it before that
   *  section runs. `byHost` is the one source they read; a second field
   *  restated on `Entity` would just be this, cached. */
  const bestRankOf = (domain: string): number | undefined => {
    const rows = byHost.get(domain) ?? [];
    const ranks = rows
      .map((h) => h.rank)
      .filter((n): n is number => typeof n === "number");
    return ranks.length ? Math.min(...ranks) : undefined;
  };
  if (SECOND_LOOK && secondLookAffordable) {
    const unplaced = entities.filter(
      (e) => e.settledBy === "model" && e.relation === "unknown",
    );
    /** Is this URL just the front door again? The judge already read the
     *  front page; a second look at the identical page re-buys the identical
     *  refusal. Path, query or a subdomain all make it a different page. */
    const frontDoorAgain = (url: string, domain: string): boolean => {
      try {
        const u = new URL(url);
        return (
          u.hostname.replace(/^www\./, "") === domain &&
          (u.pathname === "/" || u.pathname === "") &&
          !u.search
        );
      } catch {
        return true; // an unparseable URL is not worth a fetch either
      }
    };
    /** Earned a second knock on a page that came back blocked: corroborated
     *  by more than one query, or ranked well by at least one — the same
     *  read `unlockSeenIn` gives the rank phase, applied here because a
     *  second-look fetch is a fresh door, not a retry of the judge's own.
     *  Reads `row.seenIn`, not `e.seenIn`: the entity's own `seenIn` is not
     *  filled in until the report section below this stage runs. */
    const earnedUnlock = (row: HostCandidate, domain: string): boolean =>
      row.seenIn >= 2 || (bestRankOf(domain) ?? Infinity) <= 5;
    /**
     * BY MERIT, NOT BY ARRAY ORDER.
     *
     * The cap binds — since the snippet gate every run has had more unplaced
     * hosts than looks to spend — so WHICH hosts fill it is the whole game,
     * and until this sort it was whatever order `entities` happened to be in.
     *
     * That order is not neutral. Measured on the run where the cap bound
     * hardest, 103 unplaced and 60 looks:
     *
     *   the 60 it took     13 earned an unlock   mean seenIn 1.08
     *   the 43 it skipped  22 earned an unlock   mean seenIn 4.07
     *   the best 60        35 earned an unlock   mean seenIn 3.28
     *
     * It was systematically looking at the WORST candidates — the hosts it
     * skipped were corroborated four times over, the ones it took barely
     * once. Sorting first takes the escalation-eligible population inside the
     * cap from 13 to 35 for exactly the same sixty fetches and the same
     * unlock budget. Nothing here costs more; the same money buys better odds.
     *
     * The key is `earnedUnlock`'s own, deliberately: the stage should look
     * first at the hosts it would actually be willing to pay to rescue, since
     * a look at a host it would never escalate is a look that fails open the
     * moment the page is walled. `row.seenIn`, not `e.seenIn` — the entity's
     * own is not filled in until the report section below this stage runs,
     * which is the same trap `earnedUnlock` documents just above.
     */
    const ranked = unplaced
      .flatMap((e) => {
        const row = rowOf.get(e.domain);
        return row?.topHit && !frontDoorAgain(row.topHit, e.domain)
          ? [{ e, row, url: row.topHit }]
          : [];
      })
      .map((c) => ({ ...c, seenIn: c.row.seenIn, bestRank: bestRankOf(c.e.domain) }));
    const lookAt = mostCorroboratedFirst(ranked).slice(0, SECOND_LOOK_CAP);
    // Set whether or not any look is affordable below: the population is a
    // fact about the run, and a stage that looked at none of it should say so
    // with the same number as one that looked at all of it.
    secondLookUnplaced = unplaced.length;
    if (lookAt.length > 0) {
      say(
        "rank",
        `second look: ${unplaced.length} hosts left unplaced; re-reading a search-surfaced page for ${lookAt.length} of them`,
      );
      // Six in flight — the triage stage's width, for the same reason: wide
      // enough that sixty hosts cost the slowest few, narrow enough that a
      // rate-limited model answers with pacing rather than a failed wave.
      // A POOL, the last chunked-wave site in this file to become one:
      // measured on runs/sweep-cursor-com-20260823064255.json, 414s of billed
      // second-look work took 191s of wall at six wide — 2.2 in flight, the
      // other four waiting on each wave's slowest fetch.
      const SECOND_LOOK_CONC = 6;
      await runPool(lookAt, SECOND_LOOK_CONC, async ({ e, row, url }) => {
        secondLookAsked += 1;
        try {
          let raw = await fetcher.get(url, "direct", { signal });
          let s = sniff(raw);
          bill("fetch", "second-look", 0, raw.ms, s.status === "found");
          spans.emit({
            runId,
            agentId: "second-look",
            parentId: null,
            kind: "fetch",
            name: "fetch",
            argsDigest: url,
            ms: raw.ms,
            ok: s.status === "found",
            usd: 0,
          });
          // The search-surfaced page can be walled the same as the front
          // door was — about half of one real run's second looks were —
          // so a corroborated host earns one unlocker retry before the
          // look fails open, the same bar (not a new one) and the same
          // blocked-shape check (`unlockSeenIn`) the rank phase applies
          // to the judge's own front-page fetch.
          //
          // 4xx only. `thin-render` was admitted here too until it was
          // priced on this exact population — the hosts THIS stage left
          // unplaced — and recovered 2 of 12 pages, one of them usable,
          // against 10 of 11 for 4xx. The reasoning is in judge.ts beside
          // the ladder this one deliberately mirrors; it matters more here
          // because this budget is the tighter of the two and binds every
          // post-gate run.
          if (
            s.status !== "found" &&
            /^http-4/.test(s.reason) &&
            secondLookUnlocked < SECOND_LOOK_UNLOCK_BUDGET &&
            earnedUnlock(row, e.domain)
          ) {
            secondLookUnlocked += 1;
            const retried = await fetcher.get(url, "unlocked", { signal });
            const s2 = sniff(retried);
            bill("unlocker", "second-look", retried.usd, retried.ms, s2.status === "found");
            spans.emit({
              runId,
              agentId: "second-look",
              parentId: null,
              kind: "fetch",
              name: "unlocker",
              argsDigest: url,
              ms: retried.ms,
              ok: s2.status === "found",
              usd: retried.usd,
            });
            if (s2.status === "found") {
              raw = retried;
              s = s2;
            }
          }
          if (s.status !== "found") {
            secondLookFailed += 1;
            return;
          }
          const pageText = condense(s.text, 6_000).slice(0, 4_000);
          // The {{page}} var carries a one-line header naming the URL and
          // saying the front page left this host unplaced — the template
          // frames the var as "its front page, condensed", and a model
          // told it is reading the front door again would judge the wrong
          // claim.
          const out = await classifyHost("second-look")(
            row,
            `second look at ${url} — the front page left this host unplaced; this is a page the search itself surfaced for it.\n${pageText}`,
          );
          // Rescue is the stage's only power: an answer that still
          // refuses to place the host changes nothing.
          if (out.relation === "unknown" || out.relation === "none")
            return;
          // THE JUDGE'S WITHDRAWALS HOLD HERE TOO. judgeHosts withdraws a
          // verdict whole when the model answers with the anchor's own
          // identity, or with a brand whose home is another registrable
          // domain — and it emits exactly the relation:"unknown" rows this
          // stage targets. A second look that skipped these guards was
          // re-admitting the withdrawn verdicts on a second page; the
          // guards are the judge's own exports, one implementation.
          if (
            anchorIdentityTheft(out.name ?? "", row.host, anchor) ||
            wrongDoorName(out.name ?? "", row.host)
          )
            return;
          // The judgeHosts path re-checks spans in code; this call went
          // around it, so the same check happens here — quotes verified
          // against the fetched page's own condensed text (never the
          // header), or the rescue does not stand.
          const verified = out.spans.filter(
            (sp) => checkQuote(pageText, sp) === "ok",
          );
          if (verified.length === 0) return;
          secondLookRescued += 1;
          e.name = out.name || e.name;
          e.kind = out.kind;
          e.relation = out.relation;
          e.what = out.what;
          e.why = out.why;
          // Stored receipts obey the judge's own budget, and the
          // grounding meter is re-measured against the page this
          // description was actually written from — a rescued row
          // carrying the front page's meter would grade new prose
          // against text that no longer backs it.
          e.spans = capReceipts(verified);
          e.descGrounded =
            Math.round(descriptionGrounding(out.what, pageText).score * 100) / 100;
          e.descSpans = {
            verified: verified.length,
            claimed: out.spans.length,
          };
          // reasoning/relationSpan/relationGrounded are per-VERDICT, not
          // per-entity: they describe why THIS relation holds, so a
          // rescue that overwrites the relation must overwrite them too,
          // or the stored reasoning goes on describing a verdict this
          // entity no longer carries. classifyHost already computed them
          // against this call's own page — carry what it returned.
          e.reasoning = out.reasoning;
          e.relationSpan = out.relationSpan;
          e.relationGrounded = out.relationGrounded;
          // The trail, appended rather than replaced: the first
          // judgement's refusal is part of how this entity was settled.
          e.because = [e.because, `second look at ${url}`]
            .filter(Boolean)
            .join("; ");
        } catch (err) {
          // An abort must stay an abort — the same rule as the judge
          // pool: settling on through a cancel would hand back a run
          // nobody is waiting for.
          if (signal?.aborted) throw err;
          // Fail open: a fetch or model failure leaves the first
          // judgement standing, exactly as if this look never happened —
          // but counted, so the closing line and the census can say so.
          secondLookFailed += 1;
        }
      });
      say(
        "rank",
        `second look rescued ${secondLookRescued} of ${secondLookAsked} unplaced hosts` +
          (secondLookFailed ? ` (${secondLookFailed} looks failed open)` : "") +
          (secondLookUnlocked ? ` (${secondLookUnlocked} escalated through the unlocker)` : ""),
      );
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  // ── attribute every entity to the markets whose queries surfaced it ───────
  // Free: byHost already maps host -> hits, each hit carries its query, and
  // each query carries its market. The join was simply never done.
  {
    /**
     * Snap each query's market onto a declared one, or drop it.
     *
     * The prompt asks for a character-for-character copy and a measured run
     * still returned its LENS there ("Who solves it a different way", 25
     * entities), a market the planner invented mid-round, and the same market
     * in two casings. A rule the model can miss needs a check that cannot.
     *
     * Case-insensitive match against the declared list, and anything that does
     * not match resolves to nothing: an entity with no market falls back to the
     * anchor, which is honest, where a made-up market node is not.
     */
    const declared = new Map(
      decomp.capabilities.map((c) => [c.name.trim().toLowerCase(), c.name]),
    );
    const canonical = (m: string | undefined) =>
      m ? declared.get(m.trim().toLowerCase()) : undefined;
    const marketOf = new Map(asked.map((q) => [q.q, canonical(q.market)]));
    const familyOf = new Map(asked.map((q) => [q.q, q.family]));

    const stray = new Set(
      asked.map((q) => q.market).filter((m) => m && !canonical(m)),
    );
    if (stray.size) {
      say(
        "rank",
        `${stray.size} queries named a market that was never declared; their hosts fall back to the anchor`,
      );
      for (const m of stray)
        think("rank", `undeclared market on a query: ${m}`);
    }
    for (const e of entities) {
      const rows =
        byHost.get(e.domain.toLowerCase().replace(/^www\./, "")) ?? [];
      const counts = new Map<string, number>();
      for (const h of rows) {
        const m = marketOf.get(h.q);
        if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
      }
      if (counts.size) {
        e.foundBy = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([m]) => m);
      }
      const fams = new Map<QueryFamily, number>();
      for (const h of rows) {
        const f = familyOf.get(h.q);
        if (f) fams.set(f, (fams.get(f) ?? 0) + 1);
      }
      if (fams.size)
        e.families = [...fams.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([f]) => f);
      // The roads themselves — the actual query texts that surfaced this
      // host, most-seen first, capped like the judge's own view of them.
      // `foundBy` says which MARKETS this entity hangs on and `families`
      // which door-shapes found it; neither answers the reader's first
      // question, "what did you type to get this?", except by digging
      // through the trace. The basic connection of this graph is the query,
      // so the stored entity carries it.
      const qCounts = new Map<string, number>();
      for (const h of rows) qCounts.set(h.q, (qCounts.get(h.q) ?? 0) + 1);
      if (qCounts.size)
        e.roads = [...qCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([q]) => q);
      if (rows.length) {
        e.seenIn = qCounts.size;
        const ranks = rows.map((h) => h.rank).filter((n): n is number => typeof n === "number");
        if (ranks.length) e.bestRank = Math.min(...ranks);
      }
    }
  }

  // ── 4¾. drop-confirm: a second opinion on every host the first pass dropped ──
  //
  // The judge's `relation: "none"` is a real verdict — model-settled, page in
  // hand — and also the one verdict this run never gets a second look at: it
  // costs the entity its place on the map entirely (`onMap`, above), and
  // nothing downstream ever revisits it. This stage asks, once more and
  // batched, whether that verdict holds — from the SAME evidence the first
  // pass already paid for (the entity's own `what`/`why`/`roads`), never a
  // re-fetch: that stored summary IS the page's content, already read once.
  // Sequenced last, after the second look, on purpose — a rescue there can
  // already move a host off `none`, and asking about a host twice in one run
  // is two calls answering the same question. See `SweepOptions.dropConfirm`
  // for the contract; the shape below repeats triage's and the second look's:
  // off unless asked for, and every failure fails open.
  const DROP_CONFIRM = opts.dropConfirm === true;
  let dropConfirmAsked = 0;
  let dropConfirmRescued = 0;
  let dropConfirmConfirmed = 0;
  // The same clock rule as triage and the second look: a deadline-bound run
  // down to its write reserve ships what it has rather than spending the
  // reserve on one more opinion. Null DEADLINE — every CLI run — never gates.
  const dropConfirmAffordable =
    DEADLINE === null || secondsLeft() > TAIL_SECONDS;
  if (DROP_CONFIRM && !dropConfirmAffordable) {
    say(
      "rank",
      `drop-confirm withheld: only the write reserve is left on the clock, so the first refusals stand`,
    );
  }
  if (DROP_CONFIRM && dropConfirmAffordable) {
    // Model-settled only: a predicate settlement (an unreadable host) has no
    // `what`/`why` worth reconsidering, and a triage skip never had its page
    // read at all — see `SweepOptions.dropConfirm`.
    const dropped = entities.filter(
      (e) => e.settledBy === "model" && e.relation === "none",
    );
    // Most corroborated first, for the reason set out at
    // `mostCorroboratedFirst`: sliced in array order this cap spent its sixty
    // questions on the least-surfaced hosts the run found. A host many queries
    // surfaced and ranked well, that the model then ruled off the map
    // entirely, is the more consequential refusal to re-examine.
    //
    // A LATENT FIX, and worth saying so. This stage is opt-in — `DROP_CONFIRM`
    // is `opts.dropConfirm === true`, which the CLI sets only under
    // OPENKB_DROP_CONFIRM=1 — so it ran on none of the runs on disk. The
    // "94, 155, 172 and 338 dropped hosts against sixty slots" that first
    // argued for this are counts of the candidates it WOULD have had, not of
    // questions it actually asked badly. The ordering bug was real and is
    // fixed; its cost so far has been zero, and it would have been paid the
    // first time anyone turned the stage on.
    const candidates = mostCorroboratedFirst(
      dropped.map((e) => ({
        e,
        seenIn: rowOf.get(e.domain)?.seenIn ?? 0,
        bestRank: bestRankOf(e.domain),
      })),
    )
      .slice(0, DROP_CONFIRM_CAP)
      .map((c) => c.e);
    if (candidates.length > 0) {
      say(
        "rank",
        `drop-confirm: asking whether ${candidates.length} hosts truly have no place on this market's map at all`,
      );
      const byDomain = new Map(candidates.map((e) => [e.domain, e]));
      const blockFor = (e: Entity) =>
        `${e.domain}\n` +
        `  what: ${e.what || "(nothing said)"}\n` +
        `  why: ${e.why || "(nothing said)"}\n` +
        `  roads: ${(e.roads ?? []).join("; ") || "(none recorded)"}`;
      // The rendered per-host block is the only text this call hands the
      // model — there is no page to re-read — so it is also the only text a
      // returned `spans` quote can be checked against. Built FROM blockFor,
      // not reconstructed alongside it: a separately-joined string here once
      // omitted the "what:"/"why:"/"roads:" labels blockFor renders, so a
      // quote that legitimately included label text the model was shown
      // would fail a check against text it was never shown.
      const contextOf = new Map(
        candidates.map((e) => [e.domain, blockFor(e)]),
      );
      const batches: Array<typeof candidates> = [];
      for (let i = 0; i < candidates.length; i += BATCH)
        batches.push(candidates.slice(i, i + BATCH));
      await Promise.all(
        batches.map(async (batch) => {
          dropConfirmAsked += batch.length;
          try {
            const out = await call(
              "drop-confirm",
              `drop-confirm ${batch.length} hosts`,
              z.object({
                placements: z
                  .array(
                    z.object({
                      host: z.string().describe("the host, exactly as given"),
                      kind: z.enum(CLASSIFY_KINDS),
                      relation: z.enum(RELATIONS),
                      what: z
                        .string()
                        .describe(
                          "what it is, one line — empty when relation is none",
                        ),
                      why: z
                        .string()
                        .describe(
                          "the evidence for the placement, or the one line confirming nothing fits",
                        ),
                      spans: z
                        .array(z.string())
                        .max(3)
                        .describe(
                          "1-3 quotes copied from this host's what/why/roads below, backing a real placement; empty when relation is none",
                        ),
                    }),
                  )
                  .describe("one row per host, every host answered"),
              }),
              prompt("drop-confirm", {
                anchor,
                sells: decomp.sells,
                buyer: decomp.buyer,
                hosts: batch.map(blockFor).join("\n\n"),
              }),
              { think: "none", maxOutputTokens: TRIAGE_MAX_OUTPUT_TOKENS },
            );
            const askedHosts = new Set(batch.map((e) => e.domain));
            for (const v of out.placements) {
              // A verdict for a host this batch never asked about is noise
              // from the model, not a decision about the map — the same
              // guard triage's verdict loop applies.
              if (!askedHosts.has(v.host)) continue;
              const e = byDomain.get(v.host);
              if (!e) continue;
              if (v.relation === "none") {
                dropConfirmConfirmed += 1;
                e.because = [e.because, `drop-confirmed: ${v.why}`]
                  .filter(Boolean)
                  .join("; ");
                continue;
              }
              // Same discipline `spans` gets in the main classify path: a
              // literal substring of the exact text this call handed the
              // model, or the rescue does not stand — the second look's own
              // rule (`if (verified.length === 0) return`), repeated here.
              const ctx = contextOf.get(v.host) ?? "";
              const verified = v.spans.filter(
                (sp) => checkQuote(ctx, sp) === "ok",
              );
              if (verified.length === 0) continue;
              dropConfirmRescued += 1;
              e.kind = v.kind;
              e.relation = v.relation;
              e.what = v.what;
              e.why = v.why;
              e.spans = capReceipts(verified);
              // The first pass's reasoning/relationSpan described the "none"
              // verdict this rescue just overwrote — left standing, they
              // would go on explaining a relation this entity no longer
              // carries, which is worse than carrying nothing. This call's
              // schema asks for no fresh relationSpan (there is no page to
              // draw one from — see the stage's own doc comment), so the
              // honest move is to clear rather than leave a stale one.
              e.reasoning = undefined;
              e.relationSpan = undefined;
              e.relationGrounded = undefined;
              e.because = [e.because, `drop-confirmed: ${v.why}`]
                .filter(Boolean)
                .join("; ");
            }
          } catch (err) {
            // Fail open: an unanswered batch leaves every first verdict in it
            // standing, exactly as if this stage never ran — but the attempt
            // is still counted, so the closing line and the census can say so.
            say(
              "rank",
              `  a drop-confirm call failed (${(err as Error).message}); its ${batch.length} hosts keep their first verdict`,
            );
          }
        }),
      );
      say(
        "rank",
        `drop-confirm rescued ${dropConfirmRescued} of ${dropConfirmAsked}; ${dropConfirmConfirmed} confirmed unrelated`,
      );
    }
  }

  const keep = entities.filter(onMap);
  // The hosts that reached the map, for the co-occurrence pass below.
  const keptHosts = new Set(
    keep.map((e) => e.domain.toLowerCase().replace(/^www\./, "")),
  );

  /**
   * How the entities relate to each other.
   *
   * 387 entities is 74,691 possible pairs, so the pairs have to be SELECTED
   * before anything is asked. The selector is free and already measured: two
   * hosts returned by the same query co-occurred in a real retrieval. A search
   * engine putting two vendors on one results page is the search engine saying
   * they answer the same question, which is what competing looks like.
   *
   * A pair needs two different queries to qualify. One shared query is what any
   * two pages of a broad search have in common; corroboration across differently
   * worded questions is the signal that separated real findings from noise
   * everywhere else in this run.
   */
  const coPairs = (() => {
    const byQuery = new Map<string, Set<string>>();
    for (const h of hits) {
      let host: string;
      try {
        // FOLDED EXACTLY AS `byHost` FOLDS IT, and for the same reason: the
        // entity store above keyed every row by `parentOf(host)`, so
        // `keptHosts` holds parents and a row that arrived on `docs.`, `blog.`
        // or `api.` failed the test below and was thrown away here, after the
        // fold had already decided it was the parent's evidence. Re-deriving
        // the host from the url without the fold is the same expression the
        // store uses (:2513) minus the one line that makes it mean a company.
        //
        // MEASURED: 3,726 rows corpus-wide, 1,906 of 49,143 (3.9%) on the
        // current-engine runs, every one of them invisible to pair selection
        // for the life of the run.
        host = parentOf(
          new URL(h.url).hostname.toLowerCase().replace(/^www\./, ""),
        );
      } catch {
        continue;
      }
      if (!keptHosts.has(host)) continue;
      if (!byQuery.has(h.q)) byQuery.set(h.q, new Set());
      byQuery.get(h.q)!.add(host);
    }
    const score = new Map<string, number>();
    for (const hosts of byQuery.values()) {
      // A query that returned almost everything says nothing about any pair in
      // it. Skip it rather than let it inflate every score it touches.
      const list = [...hosts];
      if (list.length > 40) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const key = [list[i]!, list[j]!].sort().join("|");
          score.set(key, (score.get(key) ?? 0) + 1);
        }
      }
    }
    // Every pair that qualified, strongest first and UNCAPPED. `MAX_PAIRS`
    // used to cut the list here, one step before the free naming pass had said
    // which of these it already answered — so the cap spent its slots on
    // questions a retrieved page had settled for nothing (1,624 of 14,748 paid
    // slots corpus-wide, 11.0%) and the pairs it cut were recorded nowhere at
    // all. The cut is now taken below, on what is actually left to ask, and it
    // reports what it took.
    return [...score.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => {
        const [a, b] = k.split("|") as [string, string];
        return { a, b, seen: n };
      });
  })();

  const edges: EntityEdge[] = [];
  /** Pairs the paid linking pass never got to ask about, because the clock ran
   *  out mid-phase. Reported rather than swallowed: a reader comparing two runs
   *  of one anchor deserves to know one of them shipped fewer edges because it
   *  was hurried, not because the market has fewer relationships. */
  let unlinked = 0;

  /**
   * Systematic linking, before any model sees a pair.
   *
   * Taken from v1, which joined a community to the vendors it discusses by
   * asking one question of the text: does it NAME them. A word boundary match,
   * no judgement, no call.
   *
   * It belongs first because it is the stronger evidence. A page that writes a
   * company's name is a fact about that page; a model deciding two hosts are
   * related because they co-occurred is an inference, and an audit of this
   * engine's inferences on thin evidence found more wrong than right. So
   * matching runs first, its edges are `measured`, and the model is left only
   * the pairs no page resolved.
   *
   * Free, and it costs no wall clock worth measuring.
   */
  /**
   * A NAME THE RUN STORES IN CAPITALS IS MATCHED IN CAPITALS.
   *
   * The match is case-insensitive because a page writing "figma" means Figma.
   * That breaks on a name stored shouted. `user.com.sg` is a Singapore UX
   * agency whose entity name is "USER", and `\buser\b` fires on every page in
   * a design corpus that says user interface, user testing, user stories. It
   * collected 141 edges on runs/sweep-figma-com-20260810173400.json — second
   * only to the anchor's 251 — from reddit, medium, youtube and g2, none of
   * which had heard of it.
   *
   * A writer who means the company shouts it back: "NVIDIA DGX Cloud",
   * "NVIDIA GPUs". A writer using the word does not. Counted over that run's
   * 5,061 stored titles and descriptions, the exact spelling "USER" occurs 0
   * times while the case-insensitive form occurs 316; a real brand is written
   * in its own case nearly always — Figma 1,487 of 1,498 occurrences, Adobe
   * 287 of 290, Webflow 205 of 206, Miro 168 of 171.
   * So an all-capitals term is matched exactly. Everything else — every
   * Capitalised brand, every lowercase one, and every host, which is
   * lowercased where the terms are built below — keeps today's match.
   *
   * MEASURED by replaying this pass over the stored SERP rows of all 28 runs
   * in runs/ that carry them, each at the engine era it was written under.
   * 682 of 42,058 name-derived edges go, 1.6%. No edge is invented, no
   * relation changes, the anchor's own in-degree is unchanged on all 28, and
   * no entity whose name is not all-capitals loses a single edge on any of
   * them — figma's adobe.com (81), sketch.com (75), handoff.com (74),
   * framer.com (67), webflow.com (55) and miro.com (49) are untouched.
   *
   * The 682 are 55 (entity, run) pairs carrying 46 distinct names. Eight names
   * are 564 of them, and all eight are an ordinary English word: USER 141 -> 0
   * on figma, TIME 112 -> 0 on openai ("these five actually save time"),
   * FIRST 93 -> 1 on cloudflare ("cloud-first", "first catalogs all
   * applications"), BILL 72 -> 9 on shopify and 20 -> 2 on stripe, TODAY
   * 60 -> 0 on twilio, CORE 33 -> 1 on stripe, INBOX 27 -> 0, REAL 19 -> 0.
   *
   * WHAT IT COSTS is in the other 38 names, which lose 118 between them and
   * none more than 11. That tail is mixed: more shouted ordinary words
   * (SUBSCRIBE 11, ONES 8, EARLY 6) beside real brands whose name is an
   * acronym some page wrote in mixed case. Those are the losses that are not
   * recoverable — nvidia.com 14 -> 11 on vercel, and the three rows it drops
   * are genuine ("Nvidia, AMD, Broadcom, AWS"); zitadel.com 9 across three
   * clerk runs to "Zitadel"; dotnet.microsoft.com 9 -> 2, whose name is stored
   * ".NET" and whose pages write ".Net"; geetest.com 5 -> 0 to "GeeTest".
   * Reading the tail entity by entity, roughly 60 of those 118 are real
   * mentions now gone. Roughly, because the line between a shouted word and a
   * shouted brand is a reading and not a measurement — WIRED and Writer are
   * both — so it is given as a range. The measured part is the 682 and the 0.
   *
   * WHAT IT DOES NOT FIX is most of the bug, and deliberately. This is the one
   * shape where capitals give the word away. The common shape — an ordinary
   * word Capitalised, which is also how a headline writes any word — is
   * untouched: handoff.com keeps all 74 of its edges here, batch.com all 50,
   * format.com 42, instantly.ai 32. Case cannot reach them. On this run 3,340
   * of 4,714 titles of three or more real words capitalise nearly all of them,
   * so "Handoff" in "Design Handoff Best Practices" is spelled exactly like
   * Handoff the company; matching every name case-sensitively was measured and
   * it costs sketch.com 75 -> 63, handoff.com 74 -> 51, batch.com 50 -> 38
   * while leaving most of those three standing, and on cloudflare it takes
   * nginx.org 84 -> 16 because that brand is styled lowercase. Letting a
   * shouted name also match its Title-cased spelling, to spare Nvidia and
   * Zitadel, was measured too: it puts 47 of USER's 141 back.
   */
  const shouted = (term: string) =>
    /[A-Z]/.test(term) && term === term.toUpperCase();

  const namesIt = (haystack: string, needle: string): boolean =>
    new RegExp(
      `\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      shouted(needle) ? "" : "i",
    ).test(haystack);

  {
    const spellings: { entity: Entity; terms: string[] }[] = keep.map((e) => {
      const host = e.domain.toLowerCase().replace(/^www\./, "");
      return {
        entity: e,
        // The company's name and its full host, and nothing else. Matching a
        // host's first label instead looked clever and was not: it made "cloud"
        // a spelling of cloud.google.com, "guides" of a university library, and
        // "google" of four separate entities, so a page saying "cloud" linked to
        // Google. v1 matched name and slug only, and was right.
        terms: [...new Set([e.name, host])].filter((t) => t && t.length > 3),
      };
    });

    /**
     * ONE SPELLING, ONE OWNER.
     *
     * The loop below asks every entity whether this page names it, so a string
     * two entities both answer to buys an edge to BOTH — and the run has no
     * way to say which one the page meant. Measured on the ten biggest maps on
     * disk: 4 to 16 spellings per map are claimed twice, and they were paying
     * for 992 edges across the ten — 0 on linear.app, 170 on cloudflare, 11%
     * of github's whole naming pass. Almost all of them are one company
     * reached by two hosts —
     * `react.dev` and `legacy.reactjs.org` both answer to "React",
     * `zeroheight.com` and `report.zeroheight.com` to "zeroheight" — so the
     * pair was never two findings, it was one finding counted twice.
     *
     * The owner is the claimant whose host actually spells the term, and the
     * shortest such host, which is the apex rather than the subdomain: "React"
     * goes to react.dev and not to the archive, "Open Source Design" to
     * opensourcedesign.net and not to its forum. Alphabetical last, so two
     * hosts of equal length resolve the same way on every run.
     *
     * A host term always spells its own host, so a registrable-host match —
     * the strongest identification the pass has — can never lose this contest.
     */
    const identityKey = (text: string) =>
      text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const claimants = new Map<string, string[]>();
    for (const { entity, terms } of spellings) {
      const host = entity.domain.toLowerCase().replace(/^www\./, "");
      for (const t of terms) {
        const k = t.toLowerCase();
        claimants.set(k, [...(claimants.get(k) ?? []), host]);
      }
    }
    const owner = new Map<string, string>();
    for (const [term, hosts] of claimants) {
      const backed = hosts.filter((h) =>
        identityKey(h).includes(identityKey(term)),
      );
      const pool = backed.length ? backed : hosts;
      owner.set(
        term,
        [...pool].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0]!,
      );
    }

    /** Kinds that sell something, which is the only kind a rival can be. */
    const sells = (kind: string) => kind === "company" || kind === "product";
    /**
     * A member of this market's rival set: it sells, and the classify pass —
     * reading its OWN front page, span-checked — placed it against the anchor
     * as a competitor or a substitute. Everything else on the map is here for
     * another reason: it is depended on, integrated with, written about.
     *
     * Asked of BOTH ends, which was measured rather than assumed. Judging the
     * target alone leaves figma with 279 competitor edges, 46 of them running
     * FROM a host that is not in the rival set; the run's own model, asked pair
     * by pair whether the two actually compete, said yes to 4 of 40 sampled
     * there against 19 of 40 sampled from the 233 that are. Same shape on
     * stripe: 4 of 40 in the source-only slice. A 10%-true slice beside a
     * 48%-true one is worth the handful of real edges the symmetry costs.
     */
    const anchorHost = anchor.toLowerCase().replace(/^www\./, "");
    const isRival = (e: Entity) => {
      // THE ANCHOR IS IN ITS OWN MARKET BY CONSTRUCTION, and without this line
      // the rule deletes the one edge class a market map exists to publish.
      //
      // `isRival` reads a relation the classify pass wrote, and every relation
      // is stated FROM THE ANCHOR OUTWARD — so the anchor's own row cannot
      // carry `competitor`, because nothing competes with itself. On this run
      // it carries `shaper`; it could carry anything. Either way the predicate
      // says false, and then `isRival(src) && isRival(entity)` demotes every
      // edge with the anchor at either end: 309 of figma.com's 2,461, all of
      // them "figma.com competes with X" turned into "figma.com discusses X".
      //
      // Not widened to `shaper` generally, which would have fixed this run and
      // not the next one — a shaper is the incumbent a market is defined
      // against, which is a different claim from selling against the anchor.
      // The anchor is named by host, which is the one identification that
      // cannot be a judgement.
      if (e.domain.toLowerCase().replace(/^www\./, "") === anchorHost)
        return true;
      return (
        sells(e.kind) &&
        (e.relation === "competitor" || e.relation === "substitute")
      );
    };

    const seenEdge = new Set<string>();
    let matched = 0;
    let ambiguous = 0;
    let demoted = 0;
    for (const [host, rows] of byHost) {
      // THE ANCHOR'S OWN HOST HAS NO ROW IN `keep`, since the hostList guard
      // above excludes it before judgeHosts ever runs (never fetched, never
      // judged, never a node on the map — see the anchor-exclusion comment
      // there). `isRival` already treats the anchor as a rival of itself BY
      // DOMAIN, independent of anything a `src` entity would carry, so the
      // naming pass still lets it be the FROM side of an edge: `srcKind` is
      // fixed to "company" for it — the anchor sells, by construction — which
      // `sells()` and the `mention` ladder below read exactly the way they
      // would have read a real, judged anchor row.
      const isAnchorHost = host === anchorHost;
      const src = isAnchorHost
        ? undefined
        : keep.find((e) => e.domain.toLowerCase().replace(/^www\./, "") === host);
      if (!isAnchorHost && !src) continue;
      const srcKind = isAnchorHost ? "company" : src!.kind;
      // Only what this host's own results said, which is text the run retrieved.
      const blob = rows
        .map((r) => `${r.title} ${r.description ?? ""}`)
        .join("\n");
      for (const { entity, terms } of spellings) {
        const target = entity.domain.toLowerCase().replace(/^www\./, "");
        if (target === host) continue;
        const hit = terms.find((t) => namesIt(blob, t));
        if (!hit) continue;
        // The string names somebody, and the run cannot say it was this one.
        // Not a weaker edge — no edge, because there is no evidence about this
        // target to weaken.
        if (owner.get(hit.toLowerCase()) !== target) {
          ambiguous += 1;
          continue;
        }
        const key = `${host}|${target}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        // What the naming means depends on what the namer is. A forum naming a
        // vendor discusses it; a directory lists it; a publication covers it.
        // Those three are what those kinds are FOR, so the mention is the whole
        // relationship and the mapping stands.
        //
        // A SELLER NAMING SOMETHING IS THE ONE THAT DOES NOT FOLLOW. "A vendor
        // naming a vendor is positioning against one" was the old reading, and
        // it made `competitor` 1,071 of figma's 2,461 edges on the strength of
        // a word-boundary match: figma.com -[competitor]-> a Substack
        // newsletter, because a page said "Design with AI".
        //
        // So both ends get a vote, using the judgement already made from their
        // OWN pages rather than from a string on somebody else's: an edge
        // between rivals joins two members of this market's rival set.
        // Everything else a seller names — the React it is built on, the Slack
        // it ships into, the newsletter that reviewed it, the MCP spec it
        // implements — is a mention, and `discusses` is what a mention proves.
        //
        // MEASURED on the ten biggest maps on disk, replaying this pass over
        // their stored SERP rows with today's other two fixes already applied,
        // so this is only what those left behind: this pass's competitor edges
        // fall 9,657 -> 4,117 across the ten — 405->233 on figma,
        // 2,521->648 on shopify, 1,016->441 on stripe, 1,417->655 on vercel.
        //
        // WHAT IT COSTS, because it is not free. Demoted pairs put back to the
        // run's own model one by one — "would a buyer pick one instead of the
        // other?" — say yes to 4 of 40 sampled on figma and 12 of 40 on
        // stripe. So the bar demotes real rivalries too: roughly 17 of figma's
        // 172 and 170 of stripe's 575. It is still the better side of the
        // trade, because what it keeps is truer than what it drops — figma's
        // surviving competitor edges are 21 of 40 real against 4 of 40 among
        // the demoted, stripe's 14 of 40 against 12 of 40 — but stripe is the
        // honest warning: in payments almost every vendor is somebody's
        // integration AND somebody's rival, and there this bar moves the
        // label's precision from 32% to 35% and no further.
        //
        // THE PAID PASS BELOW IS LEFT ALONE, and that was checked rather than
        // assumed: only 6 of its 58 competitor edges on figma point at
        // something that does not sell, and reading them they are right
        // (g2.com and gartner.com really are rivals). It sees both descriptions
        // before it answers. The string match is where the leap was.
        const mention =
          srcKind === "community"
            ? "discusses"
            : srcKind === "directory"
              ? "lists"
              : srcKind === "publisher"
                ? "covers"
                : sells(srcKind)
                  ? "discusses"
                  : "unknown";
        // `isAnchorHost` short-circuits the same way `isRival` itself would
        // have on a real anchor row: the anchor's identity is a fact about
        // its domain, not a judgement any `src` entity could carry.
        const rivals = (isAnchorHost || isRival(src!)) && isRival(entity);
        if (sells(srcKind) && !rivals) demoted += 1;
        // GROUNDED IN THE ROW THAT ACTUALLY NAMED IT, not only the fact that
        // one did. "a page on X names Y" proves discovery — it is true of
        // every edge this pass writes and says nothing about HOW the two
        // relate, so a reader has nothing to act on or correct (the same bar
        // `why` is held to at the paid link pass, prompts/agents/link.md).
        // The row `blob` folded this hit out of is real text the run
        // retrieved; when it says more than the bare name, quoting it turns
        // `why` into a one-sentence mechanism instead of a discovery receipt.
        // Never invented: a row with nothing beyond the name keeps the
        // discovery sentence exactly as before, prefix and all, so a reader
        // (and `edges-need-more-than-a-mention.test.ts`, which matches on
        // that exact prefix) still finds the fact it always found.
        //
        // EVERY ROW THIS HOST HAS, not just the first that matched. A host
        // turns up in `rows` once per query that surfaced it, and the naming
        // pass used to take `.find()`'s first hit — so a target named once
        // in passing (an empty-description listing page) and once with real
        // context (a comparison page from a different query) fell to the
        // bare fallback whenever the thin row happened to sort first. Taking
        // the richest of every row that names it costs nothing this pass
        // wasn't already paying for — the same `rows` it already had in
        // hand — and only ever adds a mechanism, never removes one: a host
        // with exactly one naming row keeps behaving exactly as before,
        // which is what the two existing tests above lock in.
        let mechanism = "";
        for (const r of rows) {
          if (!namesIt(`${r.title} ${r.description ?? ""}`, hit)) continue;
          const candidate = (r.description || r.title || "").trim();
          if (candidate.toLowerCase() === hit.toLowerCase()) continue;
          if (candidate.length > mechanism.length) mechanism = candidate;
        }
        const why =
          mechanism && mechanism.toLowerCase() !== hit.toLowerCase()
            ? `a page on ${host} names "${hit}": "${mechanism.slice(0, 200)}"`
            : `a page on ${host} names "${hit}"`;
        edges.push({
          from: host,
          to: target,
          relation: rivals ? "competitor" : mention,
          why,
          confidence: "measured",
        });
        matched += 1;
      }
    }
    if (matched) {
      say(
        "link",
        `${matched} edges from pages that name another player outright`,
      );
      // Said out loud because both numbers are edges a reader of an older map
      // would have seen. A run that quietly ships 30% fewer competitors than
      // last week's run of the same anchor is indistinguishable from a run that
      // found a quieter market.
      if (demoted || ambiguous) {
        say(
          "link",
          `${demoted} of them are mentions, not rivalries` +
            (ambiguous
              ? `; ${ambiguous} more named something two entities answer to and were dropped`
              : ""),
        );
      }
    }
  }

  // Whatever the free pass already answered is not worth asking a model about.
  const resolved = new Set(edges.map((e) => [e.from, e.to].sort().join("|")));
  const unanswered = coPairs.filter(
    (p) => !resolved.has([p.a, p.b].sort().join("|")),
  );
  /**
   * THE CAP, taken here rather than in the selector above.
   *
   * `MAX_PAIRS` bounds what the PAID pass costs, so it has to be applied to
   * what the paid pass would actually ask — the pairs left after the free
   * naming pass has taken its share. Applied one step earlier, to the selected
   * list, it kept pairs a page had already resolved and then dropped them,
   * paying nothing for them and buying nothing with the slots they held: 1,624
   * of 14,748 paid slots corpus-wide, 11.0%, wasted that way.
   *
   * And what the cut costs is now counted. The cap binds on 21 of 28 runs and
   * truncated 51,919 of 66,667 qualifying pairs with no counter anywhere, so a
   * map missing edges because the market was busy looked identical to a map
   * missing them because the market was quiet.
   */
  // Scaled to the market when the caller set no bound: 600 flat threw away
  // 60% of the open pairs on a phase whose cost measured 1.5% of the run.
  const PAIR_CAP = MAX_PAIRS ?? Math.max(600, keep.length * 4);
  const unresolved = unanswered.slice(0, PAIR_CAP);
  /** For `report.linking` below — the report literal is declared after this
   *  phase, and the cut used to be visible only inside `report.budget`, which
   *  is null on every run without a deadline, i.e. every run a cloner does. */
  const linkingStats = {
    openPairs: unanswered.length,
    asked: unresolved.length,
    truncated: unanswered.length - unresolved.length,
  };
  const truncatedPairs = unanswered.length - unresolved.length;
  if (resolved.size) {
    say(
      "link",
      `${coPairs.length - unanswered.length} of ${coPairs.length} pairs already answered by a page`,
    );
  }
  if (truncatedPairs) {
    say(
      "link",
      `${unanswered.length} pairs are still open and this run may ask about ${PAIR_CAP} — ` +
        `asking the ${unresolved.length} strongest, leaving ${truncatedPairs} unasked`,
    );
  }

  /**
   * The paid pass is the last thing a short clock gives up, and it gives it up
   * rather than overrunning.
   *
   * A link round is one wall-clock batch (~19s measured, they fire together)
   * and the free naming pass above has already answered every pair a retrieved
   * page settled — those edges are `measured` and they are the better ones. So
   * a run whose clock is down to the write reserve ships the measured edges and
   * skips the inferred ones, which costs a reader inference and saves them the
   * whole map.
   */
  const canAffordLinking = secondsLeft() >= TAIL_SECONDS;
  /**
   * Bounded, not unleashed — the plan phase's own precedent (`CATALOG_CONC`,
   * 6): a bare `Promise.all` over every batch fires them all at once, and on a
   * 1,100-entity map that is ~110 concurrent model calls into a rate limiter
   * that does not know this is a linking stage. A 429 storm here does not kill
   * the run — both passes below eat a failed batch and ship without its edges —
   * but every throttled batch IS edges the map does not get, bought and paid
   * for. Wall clock: the batches were already concurrent with each other, so
   * this caps the burst's width rather than serializing anything — chunks of
   * (now a pool's width, since P0-2) sixteen, not one 110-wide spike. Raised
   * from 8: link is 43% of a measured run's wall time (12.3 of 28.5 minutes,
   * runs/sweep-cursor-com-20260821105321.json), the largest single phase, and
   * — like RANK_CONC above — a deployment with rate-limit headroom can widen
   * it past the old hardcoded default.
   */
  const LINK_CONC = Math.max(
    1,
    Math.floor(Number(process.env.OPENKB_LINK_CONCURRENCY ?? 16) || 16),
  );
  if (!canAffordLinking && unresolved.length && !opts.skipModelLinking) {
    say(
      "link",
      `${unresolved.length} pairs left unasked — ${leftS()}s of clock is the write reserve, ` +
        `so the map ships with the ${edges.length} edges pages stated outright`,
    );
  }
  if (unresolved.length && !opts.skipModelLinking && canAffordLinking) {
    say(
      "link",
      `${unresolved.length} pairs co-occurred but no page names either — asking how they relate`,
    );
    const byDomain = new Map(
      keep.map((e) => [e.domain.toLowerCase().replace(/^www\./, ""), e]),
    );
    const describe = (d: string) => {
      const e = byDomain.get(d);
      return e ? `${d} (${e.kind}) — ${e.what}` : d;
    };

    const pairBatches: (typeof coPairs)[] = [];
    for (let i = 0; i < unresolved.length; i += BATCH)
      pairBatches.push(unresolved.slice(i, i + BATCH));

    let linked = 0;
    const runPairBatch = async (batch: (typeof pairBatches)[number], n: number) => {
        // SKIP, DO NOT THROW. Every phase before this one throws on abort
        // because everything they own is half-finished when the clock runs out
        // — a partly-searched wave and a partly-judged host list are not a map.
        // Linking is the exception: by the time it starts, every entity is
        // already found, judged and cited. The edges are an enrichment on top
        // of a map that already exists.
        //
        // Measured on run 31704112, clerk.com on a 300s lambda: the budget did
        // its job — 18 searches, rank complete at 180s, a full entity set in
        // hand. Then link ran five batches, one of them took 46s against the
        // 19s the comment above assumes, and the watchdog killed the run at
        // 270s. The throw turned a finished map into a failed run and threw
        // away everything, having charged for all of it.
        //
        // So an out-of-time link batch is edges this run does not have, and
        // `report.unlinkedPairs` says how many. A map with all its entities and
        // some of its edges is worth shipping; nothing is not.
        if (signal?.aborted) {
          unlinked += batch.length;
          return;
        }
        // AND ON ANY OTHER FAILURE, for the reason written directly above.
        //
        // The comment above already argues that an out-of-time link batch is
        // edges this run does not have, and the guard only covered a cancelled
        // run. Every other way a batch can fail — a call the deadline stopped
        // after its retry, a provider 500, a schema the model would not fill —
        // threw, and the throw travelled all the way out and failed the sweep.
        // Measured: figma.com died at batch 412 of 492 having already produced
        // 1,444 entities and 411 batches of edges, and wrote none of it.
        //
        // A map with all its entities and some of its edges is worth shipping;
        // nothing is not. That was true of the deadline the day it was written
        // and it is just as true of a batch that failed for any other reason.
        let out: { edges: z.infer<typeof EntityEdge>[] };
        try {
          out = await call(
            "link",
            `link batch ${n + 1} of ${pairBatches.length}`,
            z.object({ edges: z.array(EntityEdge) }),
            prompt("link", {
              anchor,
              sells: decomp.sells,
              pairs: batch
                .map(
                  (p) =>
                    `${describe(p.a)}\n   ${describe(p.b)}\n   co-occurred in ${p.seen} different searches`,
                )
                .join("\n\n"),
            }),
            { think: "none", maxOutputTokens: 200 * batch.length + 6_000 },
          );
        } catch (err) {
          unlinked += batch.length;
          say(
            "link",
            `  batch ${n + 1} of ${pairBatches.length} produced no edges: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        // Only edges whose ends are both on the map. A model naming something it
        // remembers rather than something the run found is a dangling edge, and
        // v1 shipped sixteen of them before anyone noticed.
        for (const e of out.edges) {
          const from = e.from.toLowerCase().replace(/^www\./, "");
          const to = e.to.toLowerCase().replace(/^www\./, "");
          if (from === to) continue;
          if (!byDomain.has(from) || !byDomain.has(to)) continue;
          // `whySpan` checked against exactly the text `describe()` showed the
          // model for this pair — the same containment check `relationSpan`
          // gets against the classify pass's page text, applied to what this
          // pass actually had in hand instead: no fetched page survives to
          // link time, only the `what` each entity was already judged from.
          edges.push({
            ...e,
            from,
            to,
            whyGrounded:
              checkQuote(`${describe(from)}\n${describe(to)}`, e.whySpan ?? "") ===
              "ok",
          });
        }
        linked += batch.length;
        say("link", `  ${linked}/${unresolved.length} pairs`);
    };
    // LINK_CONC at a time, a pool rather than a barrier — argued at `runPool`'s
    // own declaration above.
    await runPool(pairBatches, LINK_CONC, (batch, i) => runPairBatch(batch, i));
    say("link", `${edges.length} edges between entities`);
  }

  /**
   * THE ORPHAN ASK. After every free edge and every co-occurrence pair, a
   * third of the kept map still had no edge to anything — 36-38% measured on
   * two brightdata runs — because the pair selector requires co-occurrence in
   * two searches and most hosts are seen once. Those entities were judged,
   * described, and left floating: a reader opening one saw a node connected
   * to nothing, which reads as "the tool could not place this", when the
   * truth was that nothing ever asked.
   *
   * So it is asked, once per orphan, batched: given the entity's own judged
   * description and its market's most prominent members, where does it stand?
   * "Nobody" is an accepted answer and costs the edge nothing. Everything
   * returned ships as `inferred` — same standing as a pair edge, argued from
   * judged descriptions rather than from a fetched page.
   */
  if (!opts.skipModelLinking && !signal?.aborted) {
    const inEdge = new Set<string>();
    for (const e of edges) {
      inEdge.add(e.from);
      inEdge.add(e.to);
    }
    const anchorDom = anchor.toLowerCase();
    /** The kept map by domain — the pair pass builds its own inside its own
     *  block, and an orphan edge must obey the same both-ends-on-the-map rule. */
    const onMapByDomain = new Map(
      keep.map((e) => [e.domain.toLowerCase().replace(/^www\./, ""), e]),
    );
    const orphans = keep.filter((e) => {
      const d = e.domain.toLowerCase().replace(/^www\./, "");
      return d !== anchorDom && !inEdge.has(d);
    });
    /** The candidates an orphan is asked about: its own markets' most
     *  prominent members, prominence being the search's counts, not opinion. */
    const prominent = (markets: string[] | undefined): Entity[] => {
      const mine = new Set(markets ?? []);
      const pool = keep.filter(
        (e) =>
          e.domain.toLowerCase() !== anchorDom &&
          (mine.size === 0 || (e.foundBy ?? []).some((m) => mine.has(m))),
      );
      return pool
        .sort((a, b) => (b.seenIn ?? 0) - (a.seenIn ?? 0))
        .slice(0, 6);
    };
    const stats = { orphans: orphans.length, asked: 0, linked: 0 };
    // THE SAME CLOCK THE PAID PAIR PASS ANSWERS TO. The gate sits below the
    // orphan census on purpose — counting is free, and `report.linking.orphans`
    // should still say how many stood alone when nothing was asked — but the
    // asking is ceil(orphans/20) model calls, and before this check a
    // deadline-bound run that had already declined the pair pass to protect its
    // write reserve fired every one of them anyway.
    if (orphans.length && !canAffordLinking) {
      say(
        "link",
        `${orphans.length} orphans left unasked — ${leftS()}s of clock is the write reserve, ` +
          `so they ship standing alone rather than overrun it`,
      );
    } else if (orphans.length) {
      say(
        "link",
        `${orphans.length} entities have no edge to anything — asking each where it stands`,
      );
      const OrphanStand = z.object({
        from: z.string().describe("the orphan's domain, exactly as given"),
        to: z
          .string()
          .describe("one candidate's domain exactly as given, or empty for nobody"),
        relation: z.enum(PEER_RELATIONS),
        why: z
          .string()
          .describe("how they relate, one line, argued from the descriptions given"),
      });
      const BATCH_ORPHANS = 20;
      const batches: Entity[][] = [];
      for (let i = 0; i < orphans.length; i += BATCH_ORPHANS)
        batches.push(orphans.slice(i, i + BATCH_ORPHANS));
      const runOrphanBatch = async (batch: Entity[], n: number) => {
            if (signal?.aborted) return;
            const rows = batch
              .map((o, i) => {
                const cands = prominent(o.foundBy)
                  .filter((c) => c.domain !== o.domain)
                  .map((c) => `     - ${c.domain} — ${c.what || c.kind}`)
                  .join("\n");
                return `${i + 1}. ${o.domain} (${o.kind}) — ${o.what || "no description survived"}\n   candidates:\n${cands || "     (none prominent in its market — nobody is the likely answer)"}`;
              })
              .join("\n\n");
            let out: { stands: z.infer<typeof OrphanStand>[] };
            try {
              out = await call(
                "link",
                `orphans ${n * BATCH_ORPHANS + 1}-${n * BATCH_ORPHANS + batch.length} of ${orphans.length}`,
                z.object({ stands: z.array(OrphanStand) }),
                prompt("orphan", { anchor, sells: decomp.sells, rows }),
                { think: "none", maxOutputTokens: 120 * batch.length + 6_000 },
              );
            } catch (err) {
              say(
                "link",
                `  orphan batch ${n + 1} produced nothing: ${err instanceof Error ? err.message : String(err)}`,
              );
              return;
            }
            stats.asked += batch.length;
            for (const st of out.stands) {
              const from = st.from.toLowerCase().replace(/^www\./, "");
              const to = st.to.toLowerCase().replace(/^www\./, "");
              if (!to || from === to) continue;
              if (st.relation === "unknown") continue;
              if (!onMapByDomain.has(from) || !onMapByDomain.has(to)) continue;
              edges.push({
                from,
                to,
                relation: st.relation,
                why: st.why,
                confidence: "inferred",
              });
              stats.linked += 1;
            }
      };
      // LINK_CONC at a time, a pool rather than a barrier — argued at
      // `runPool`'s own declaration above.
      await runPool(batches, LINK_CONC, (batch, i) => runOrphanBatch(batch, i));
      say(
        "link",
        `${stats.linked} of ${stats.orphans} orphans found a footing; ${stats.orphans - stats.linked} honestly stand alone`,
      );
    }
    (linkingStats as Record<string, unknown>).orphans = stats;
  }

  /**
   * INTEGRATION EDGES FROM THE ANCHOR'S OWN DOCS. Agent-mode discovery reads
   * the documentation and submits what the company says its products plug
   * into — 31 cited names on one measured run — and until now they reached
   * the report and never the graph: the partnership layer the map's owner
   * asked for, sitting in a side pocket.
   *
   * A declared integration whose name matches a KEPT entity becomes one edge,
   * anchor → entity, citing the docs page that stated it. `inferred`, not
   * `measured`: measured means this run holds the naming page's bytes and a
   * verified quote, and what it holds here is the agent's one-line account of
   * a page it read. A name matching nothing stays a lead — it already rides
   * `names in hand` into the catalog, and pasting an unresolved name onto the
   * map would break the rule every lead obeys: resolved and judged, or not
   * on the map at all.
   */
  {
    const declared = discoveryFacts.current?.integrations ?? [];
    if (declared.length && !signal?.aborted) {
      const idKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
      const anchorDom = anchor.toLowerCase();
      /** Name-first, domain-label second, first writer wins — a name match is
       *  the company's own spelling and outranks a label coincidence. */
      const byKey = new Map<string, Entity>();
      for (const e of keep) {
        const label = idKey(e.domain.split(".")[0] ?? "");
        if (label && !byKey.has(label)) byKey.set(label, e);
      }
      for (const e of keep) {
        const nk = idKey(e.name);
        if (nk) byKey.set(nk, e);
      }
      const already = new Set(
        edges
          .filter((e) => e.relation === "integration")
          .map((e) => `${e.from}→${e.to}`),
      );
      let matched = 0;
      for (const d of declared) {
        const hit = byKey.get(idKey(d.with));
        if (!hit) continue;
        const to = hit.domain.toLowerCase().replace(/^www\./, "");
        if (to === anchorDom) continue;
        const key = `${anchorDom}→${to}`;
        if (already.has(key)) continue;
        already.add(key);
        matched += 1;
        edges.push({
          from: anchorDom,
          to,
          relation: "integration",
          why: `the anchor's own docs (${d.foundAt}) state: ${d.does}`,
          confidence: "inferred",
        });
      }
      if (matched) {
        say(
          "link",
          `${matched} of the ${declared.length} integrations the docs declare match entities on the map — drawn as edges, cited to the page that stated each`,
        );
      }
      (linkingStats as Record<string, unknown>).integrations = {
        declared: declared.length,
        matched,
      };
    }
  }

  // Summed from what was actually billed, not re-derived from the counters: a
  // SERP call that never reached Bright Data carries usd 0 and re-deriving from
  // `serpCalls * price` would charge the run for it.
  //
  // Taken HERE, after the paid model-linking phase above, not before it. A
  // snapshot taken before linking undercounted every run's cost by 14-24% and
  // its duration by up to 49% — linking is real spend and real wall clock, and
  // a reader comparing `report.usd`/`report.seconds` against `report.cost.usd`
  // (assembled from the same `byKind`/`byAgent` lines, always fresh) deserves
  // numbers that do not contradict each other.
  const usd = lines(byKind).reduce((n, l) => n + l.usd, 0);
  const seconds = (Date.now() - t0) / 1000;
  const count = (arr: string[]) =>
    arr.reduce<Record<string, number>>(
      (a, k) => ((a[k] = (a[k] ?? 0) + 1), a),
      {},
    );

  const stats: SweepStats = {
    queries: queries.length,
    results: hits.length,
    hosts: byHost.size,
    kept: keep.length,
    tokIn,
    tokOut,
    tokReasoning,
    serpCalls,
    unlockerCalls,
    usd,
    seconds,
  };

  say("write", `${keep.length} on the map from ${byHost.size} hosts`);

  // A family contributing nothing must be reported, not absorbed: the doctrine
  // or the templates have a hole and the only way anyone finds it is here.
  //
  // `rival` is deliberately not in this list. The other three are dealt from
  // the anchor's own products and always have something to ask; the rival hand
  // is dealt from urls the anchor may simply never have published, and a run
  // that asks none of it is reporting a fact about the company rather than a
  // hole in this engine. `report.rivals` carries that number where it means
  // something.
  {
    const fam = count(asked.map((q) => q.family));
    for (const f of ["plain", "debranded", "branded"] as const) {
      if (!fam[f])
        say(
          "plan",
          `the ${f} family asked nothing this run — its doctrine or templates have a hole`,
        );
    }
  }

  // The one defensible coverage number: recall against the pages the run
  // itself retrieved that name the anchor and enumerate vendors — no
  // estimator, no guess. `judged.probePages` is exactly the set `judgeHosts`
  // kept while judging; nothing extra is fetched to compute this.
  const mapHosts = new Set(
    entities
      .filter((e) => e.kind === "company" || e.kind === "product")
      .map((e) => registrableHost(e.domain || e.name)),
  );
  // The anchor's structural alias set, both halves from pages already paid
  // for: the anchor's assertions out of `anchorPages` (understand kept the
  // raw bytes), the reciprocation out of `judged.probePages` (an alias's
  // front page names the anchor, so rung 0 kept it as a probe candidate).
  // Reciprocity or nothing — one-sided is forgeable. The scorer then drops
  // alias-hosted probes and alias vendors in one place; the rise this causes
  // against un-aliased runs is a bug fix in the instrument, not a coverage
  // improvement, and `recall.aliasExclusion.note` ships that sentence.
  // Map identity is untouched: an alias stays its own entity row.
  const anchorAliases = anchorAliasSet(
    [...anchorPages, ...judged.probePages],
    anchor,
  );
  const recall = answerKeyRecall(judged.probePages, {
    anchor,
    mapHosts,
    anchorAliases,
  });
  if (recall.aliasExclusion)
    say("write", `recall: ${recall.aliasExclusion.note}`);

  const report: Record<string, unknown> = {
    domain: anchor,
    sells: decomp.sells,
    linking: linkingStats,
    /**
     * What the search actually cost at the wire, against what was asked for.
     * `queries` above counts questions; this counts requests, and the two
     * diverge by exactly the retries a blocked or throttled provider forced.
     * Measured on the run that argued for this: 192 queries at 5 pages = 960
     * requests asked for, 1,230 paid, 28% overhead invisible in every number
     * the report carried.
     */
    serp: {
      requests: serpRequests,
      retries: serpRetries,
      // The depth every query opens at. No longer the whole story once a
      // product earns `deepPagesPerQuery` instead — `deepenedProducts` names
      // which ones did, so a reader is not left assuming this ran flat.
      pagesPerQuery: SHALLOW_PAGES,
      deepPagesPerQuery: DEEP_PAGES,
      deepenedProducts: [...depthByProduct.entries()]
        .filter(([, d]) => d === "deep")
        .map(([p]) => p),
      blocked: serpBlocks,
      /** Queries that failed outright, by reason. `blocked` is the retry
       *  path's refusals only; a refusal the port does not retry — an account
       *  suspension — lands here and nowhere else. */
      failed: serpFailures,
      /** Result rows paid for that carried an opaque redirect instead of a
       *  destination, and so could never be read. */
      redirects: serpRedirects,
      /** Queries that answered on one page and lost another — counted, because
       *  they return half their rows and report success. */
      partial: serpPartial,
      /**
       * WHAT THE PROVIDER'S RATE LIMIT COST, which nothing said before.
       *
       * A Bright Data throttle is ACCOUNT-wide — the port's `THROTTLED`
       * comment measures why spreading across zones cannot lift it — so once
       * it fires, a thirty-two-wide pool becomes a queue and the search phase
       * stops being about how many queries a run wants.
       *
       * MEASURED on cloudflare.com: the search phase ran 613 seconds while
       * 165 queries with a 4.6s median should have occupied that pool for
       * well under a minute. The difference was pacing, and a reader
       * comparing two runs of one anchor had no way to tell "this map is
       * smaller because the account was throttled" from "this market is
       * smaller".
       *
       * `queries` is how many waited at all, so a run with a big `ms` spread
       * over few queries reads differently from one that paced everything.
       */
      paced: { ms: Math.round(serpPacedMs), queries: serpPacedQueries },
      /**
       * The dispatch's own width, against the width it was configured for.
       *
       * `width` is `CONC`, `peak` the most queries ever in flight at once and
       * `mean` the average measured at each dispatch. A phase moving 0.27
       * queries a second on a 32-wide pool is either never getting wide or
       * getting wide and waiting, and no other number in this report can tell
       * those apart. `peak` near `width` says the pool is full and the wire is
       * the ceiling; `peak` near 1 says the workers are blocked before it.
       *
       * HALF OF THAT IS ALREADY ANSWERED, for free, by running the fixture —
       * which has no network at all — at two widths against 14 queries:
       *
       *   width  8   peak  8   mean 6.0    the pool fills completely
       *   width 32   peak 14   mean 7.5    bounded by the work, not the pool
       *
       * So the dispatch loop CAN get fully wide, and nothing in it serialises.
       *
       * NOR IS IT THE HTTP LAYER, which was the last candidate inside this
       * process. 64 concurrent POSTs from this runtime to one origin, each
       * held 300ms server-side, reach a peak of 64 at the server and finish in
       * 366ms — an effective concurrency of 52. Node's fetch applies no
       * per-origin cap worth noticing.
       *
       * That is the elimination complete, on three free measurements:
       *
       *   the worker pool     fills to its width          (fixture, no network)
       *   our own pacing      never fired at all          (`pacedMs`, no
       *                                                    THROTTLED on disk)
       *   the HTTP client     does 64 to one origin       (local server)
       *
       * Everything on this side of the socket can go wide. The search phase
       * still moves 0.27 queries a second, so the ceiling is Bright Data's,
       * applied without the `THROTTLED` message that would let the port see
       * it. That is an account or zone capacity question to take to the
       * provider, and no constant in this file changes it.
       *
       * Which means the expected reading on a real run is `peak` near `width`.
       * If it comes back near 1, something changed in the worker loop since
       * this was measured, and that IS ours.
       */
      dispatch: {
        width: CONC,
        peak: peakInFlight,
        mean: inFlightSamples ? Math.round((10 * inFlightSum) / inFlightSamples) / 10 : 0,
      },
    },
    /** Agent-mode phase one's own account: turns, pages, and the integrations
     *  the docs stated. Null on the default path, which reads nothing an agent
     *  chose. Integrations are the company's claims, not judged entities —
     *  the same standing as `rivals.leads` below. */
    discovery: discoveryFacts.current,
    // Everything actually fired, counted at the wire where each search was
    // bought — NOT `asked.length`, which is the queue: the host-ceiling seal
    // makes workers abandon the queue's tail, and on one vercel run the queue
    // said 137 while the wire saw 83. `stats.queries` (unchanged, read by the
    // run registry and the older surfaces) stays the opening count alone;
    // `opening` here is that same number, named, so the two can no longer be
    // mistaken for the same quantity. Measured gap on one run: 63 opening vs
    // 123 fired.
    queries: firedCount,
    // What was QUEUED — opening hand plus every widening round, the sum of
    // `families` below; differs from `queries` by the tail the seal abandoned.
    queued: asked.length,
    opening: queries.length,
    results: hits.length,
    hosts: byHost.size,
    entities: entities.length,
    kept: keep.length,
    noise: entities.length - keep.length,
    kinds: count(keep.map((e) => e.kind)),
    relations: count(keep.map((e) => e.relation)),
    families: count(asked.map((q) => q.family)),
    strips,
    /**
     * DID THE PLAN REACH THE WIRE?
     *
     * The counts either side of the question every query-side change has to
     * answer, so answering it stops needing a one-off script over
     * `searched[]`. `queued` and `queries` above already say how many rows
     * were planned and fired; these say whether the plan's SHAPE survived —
     * whether each product and each strip term got a query bought for it, or
     * was written down and abandoned.
     *
     * MEASURED on the runs that motivated it. shopify.com dealt 50 products
     * and searched 22 of them, so 28 were stripped, given a catalog model
     * call, and never asked about; datadoghq.com searched 25 of 81 and the 56
     * it dropped included Network Monitoring and Static Code Analysis, whole
     * markets absent from a map claiming 1,077 entities. Dealing the hand
     * round-robin took shopify to 41 of 45. And every fourth strip term this
     * branch added went unfired on all fifty products, which `termsFired`
     * against `termsWritten` says in one line.
     */
    wire: {
      products: strips.length,
      productsSearched: strips.filter((st) =>
        st.terms.some((t) => firedQueries.has(t.trim().toLowerCase())),
      ).length,
      /**
       * WHICH products were planned and never asked about, not just how many.
       *
       * The count alone sent me to a hand-written script over `searched[]`
       * the first time it was non-zero, which is the exact errand this field
       * exists to abolish. And the names are the whole finding: "8 of 43
       * missed" says a budget was tight, while `Shopify Email, Sidekick,
       * Shopify Inbox, Shopify Audiences, Shopify Collabs...` said every one
       * of them was non-core and led straight to the band-concatenation bug
       * in the opening hand.
       *
       * Capped at twelve because this rides in the report a browser replays
       * and an anchor with a large decomposition can miss dozens; the count
       * above stays exact, so a truncated list can never be read as the
       * whole one.
       */
      productsUnsearched: strips
        .filter((st) => !st.terms.some((t) => firedQueries.has(t.trim().toLowerCase())))
        .map((st) => st.product)
        .slice(0, 12),
      termsWritten: strips.reduce((n, st) => n + st.terms.length, 0),
      termsFired: strips.reduce(
        (n, st) =>
          n + st.terms.filter((t) => firedQueries.has(t.trim().toLowerCase())).length,
        0,
      ),
    },
    /**
     * The free channel's yield, so it is measurable rather than assumed.
     *
     * `found` is names read off the anchor's own comparison urls, `queries` is
     * how many of them this run could afford to ask about under `cap`, and
     * `reachedMap` is how many of the names ended up as an entity on the map by
     * ANY route — a name-match against a kept row, not proof that this channel
     * put it there. A run where `found` is high and `reachedMap` is low is the
     * case worth looking at: the anchor is naming rivals the sweep is not
     * finding. Zero across the board is the honest reading for a company that
     * publishes no comparison pages, and costs nothing.
     */
    rivals: (() => {
      const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const onMap = new Set<string>();
      for (const e of keep) {
        onMap.add(squash(e.name));
        onMap.add(squash(registrableHost(e.domain || e.name).split(".")[0] ?? ""));
      }
      return {
        found: rivalLeads.length,
        cap: brandedBought,
        queries: asked.filter((q) => q.family === "rival").length,
        reachedMap: rivalLeads.filter((r) => onMap.has(squash(r.name))).length,
        leads: rivalLeads.map((r) => ({
          name: r.name,
          seen: r.seen,
          foundAt: r.foundAt,
        })),
      };
    })(),
    /** What the `platform` field bought. `scoped` queries carry a `site:` the
     *  code rendered from it; `tooLong` are the ones that named a platform in a
     *  sentence and were fired unscoped rather than truncated; `anchorOwned`
     *  are the ones whose platform was this anchor's own site, which is never
     *  scoped and is non-zero only when the run is mapping one of the seven.
     *  See `scopeToPlatform`. */
    platform: {
      scoped: scopedQueries,
      withheld: scopeWithheld,
      tooLong: tooLongToScope,
      anchorOwned: anchorOwnedScope,
      byPlatform: scopedBy,
    },
    /** Products `understand` found that no capability's `covers` claimed, and
     *  that the plan adopted into the nearest market rather than leaving
     *  unasked. 113 of 408 products across the 25 runs on disk that had this
     *  fault, and each one was a market its map never looked at. Zero is the
     *  healthy reading and the common one; a large number means the grouping
     *  step is losing the list it was given. */
    unclaimedProducts: adopted.length,
    readPages,
    usd,
    seconds,
    /**
     * Wall-clock per rail: when each first spoke, when it last spoke, and how
     * many lines it wrote. `seconds` above is the total and `cost.byKind[].ms`
     * is BILLED time — on a 30-minute cloudflare run that summed to 85 minutes
     * of concurrent model calls — so neither could answer "which phase was
     * slow" without a terminal log to diff.
     *
     * `spanSec` is last-minus-first, NOT exclusive occupancy: rails overlap
     * where a stage narrates late. It is the span in which a rail was active,
     * which is the question a slow run raises.
     */
    phases: Object.fromEntries(
      Object.entries(railClock).map(([rail, c]) => [
        rail,
        { firstSec: Math.round(c.firstSec), lastSec: Math.round(c.lastSec), spanSec: Math.round(c.lastSec - c.firstSec), lines: c.lines },
      ]),
    ),
    kernel: { ...judged.stats, threshold: KERNEL_THRESHOLD },
    /** Null when the flag was off — "not run" must not read as "kept all".
     *  When on: the census of the stage's one power, with its call count. */
    triage: TRIAGE
      ? {
          hosts: hostList.length,
          kept: judgeList.length,
          skipped: triagedOut.length,
          calls: triageCalls,
          failed: triageFailures,
        }
      : null,
    /** Null when the flag was off — "not run" must not read as "rescued
     *  nothing". When on: how many unplaced hosts were given a second page,
     *  how many first judgements that replaced, and how many of those looks
     *  spent an unlocker escalation on a page that came back blocked. */
    secondLook: SECOND_LOOK
      ? {
          unplaced: secondLookUnplaced,
          asked: secondLookAsked,
          rescued: secondLookRescued,
          failed: secondLookFailed,
          unlocked: secondLookUnlocked,
        }
      : null,
    /** Null when the flag was off — "not run" must not read as "nothing was
     *  unrelated". When on: how many `relation: "none"` hosts got a second
     *  opinion, how many it rescued onto the map, and how many it confirmed
     *  genuinely unrelated (a checked fact now, not one model's first read). */
    dropConfirm: DROP_CONFIRM
      ? {
          asked: dropConfirmAsked,
          rescued: dropConfirmRescued,
          confirmed: dropConfirmConfirmed,
        }
      : null,
    /** Null when the flag was off — "not run" must not read as "found
     *  nothing". When on: how many roundup-shaped rows were scanned, how
     *  many unsurfaced vendors the call named, and how many fresh queries
     *  those vendors were dealt. */
    listicleHarvest: LISTICLE_HARVEST
      ? {
          rowsScanned: listicleRowsScanned,
          vendorsFound: listicleVendorsFound,
          queriesFired: listicleQueriesFired,
        }
      : null,
    recall,
    /**
     * WHAT THE CLOCK COST THIS RUN, or null when nothing was clocking it.
     *
     * Null is the CLI and every other caller with no deadline, and it means
     * "nothing here was cut short" rather than "unknown" — the two must not
     * look alike to a reader comparing a 200-entity web map against a
     * 2,551-entity terminal one. Every field is a fact the run observed, not a
     * setting it was handed: `unjudged` is hosts found and never judged, and a
     * non-zero one is the sentence the surfaces are expected to repeat.
     */
    budget:
      QUERY_CEILING === null && DEADLINE === null
        ? null
        : {
            maxQueries: QUERY_CEILING,
            clockSeconds:
              DEADLINE === null ? null : Math.round((DEADLINE - t0) / 1000),
            // The WIRE count — the same quantity report.queries now carries.
            // This field said asked.length (the queue) while its sibling was
            // fixed, which re-created the exact confusion the fix closed, on
            // the runs where budget is non-null.
            fired: firedCount,
            hostsFound: byHost.size,
            hostsJudged: judged.entities.length,
            unjudged,
            linkingSkipped:
              !canAffordLinking &&
              !opts.skipModelLinking &&
              unresolved.length > 0,
            /** Pairs the paid pass began and did not finish. `linkingSkipped`
             *  is the whole phase declined before it started, on the check
             *  above; this is the phase started and cut off mid-flight, which
             *  is the case that actually killed run 31704112. Two different
             *  facts and a reader needs both. */
            unlinkedPairs: unlinked,
            /** Pairs that qualified and were never asked, because `maxPairs`
             *  cut them. A third fact again: not the clock and not a failure,
             *  but the size of the linking budget meeting a busier market than
             *  it was set for. It went uncounted until now, and the cap binds
             *  on 21 of the 28 runs on disk. */
            truncatedPairs,
          },
    /** The model id this run was given, and which upstream hosts actually
     *  answered for it — calls and refusals per host. Read this before
     *  blaming the model: on 2026-08-23 one host refused half its answers
     *  while seven others refused none, same model id, same day. */
    model: {
      id: modelId,
      ignored: MODEL_HOST_IGNORE,
      servedBy,
    },
    cost: {
      usd,
      elapsedMs: Date.now() - t0,
      calls: lines(byKind).reduce((n, l) => n + l.calls, 0),
      tokens: tokIn + tokOut,
      // Null when the caller supplied none (CLI runs). The web route passes
      // its real per-deployment ceiling; a hardcoded null here used to claim
      // this engine has no ceiling at all, when the deployment enforces one.
      ceilingUsd: opts.ceilingUsd ?? null,
      byKind: lines(byKind),
      byAgent: lines(byAgent),
      partial: false,
    },
  };

  emitResult("write", { kind: "complete", result: report });

  return {
    anchor,
    decomposition: decomp,
    queries,
    entities,
    edges,
    stats,
    report,
  };
}

import { createHash } from "node:crypto"
import { reserveUsd, tripAtUsd } from "@open-kb/core"
import { DEMO_REPO } from "./demo"
import { dayStartedAt, untilReset } from "./public-runs"
import * as db from "./store/supabase"
import type { UsageRow } from "./store/supabase"

/**
 * WHAT THIS DEPLOYMENT MAY SPEND, and who may make it spend.
 *
 * lib/public-runs.ts answers "is the door open, and how many maps does this
 * deployment promise a day" — a count, quoted to a visitor before they type.
 * This file answers the two questions underneath it: how much money is behind
 * that promise, and what stops one visitor, one run, or one bad afternoon from
 * taking all of it. Two files because they fail differently: an allowance that
 * is used up is a full day of service delivered, and a budget that is gone is
 * money spent. The second is the one the owner wakes up to.
 *
 * FOUR LIMITS, and each one closes a hole the other three leave open:
 *
 *   per run     one map cannot cost more than a map costs. Enforced DURING the
 *               run against the span stream's own running total, because a
 *               check before the run is a check against a number that has not
 *               happened yet.
 *   per day     this deployment cannot spend more than N dollars in a UTC day,
 *               counted from ITS OWN runs in Postgres.
 *   per visitor one stranger cannot take the whole day.
 *   at once     N runs in flight, so the day is spent over hours rather than in
 *               the ninety seconds it takes to write a loop.
 *
 * THE LAST THREE ARE CLAIMED, NOT CHECKED. Counting today's runs and then
 * starting one is two round trips, and a burst fits between them: every request
 * reads the same empty day and every one of them is right. `spendGate` below
 * therefore decides and records in a single transaction — `claim_run` in
 * scripts/supabase-schema.sql, under an advisory lock — so the twentieth
 * request sees the first nineteen. Without that these three are decoration
 * against the one caller that matters, which is a loop.
 *
 * WHY NOT THE PROVIDER'S USAGE FIGURE, which app/api/map/route.ts already
 * reads. `OPENKB_CEILING_USD` asks OpenRouter what the KEY has spent, and a key
 * is shared: the measured reading on this project's key was $548 lifetime, of
 * which $42.90 belonged to open-kb. So it counts other people's projects, it
 * cannot see a cent of Bright Data — which is 58% to 77% of a run's bill, see
 * the table below — and it is one reading taken before a run that then spends
 * for four minutes unwatched. It survives as a backstop at the provider, in the
 * route, because it catches spending this deployment cannot see. It is not the
 * budget. This is.
 *
 * FAIL CLOSED, EVERYWHERE. A store that cannot be read, an environment value
 * that is not a number, a day cap smaller than a run cap: each refuses the run
 * and says which. The ceiling this replaces got that exactly wrong —
 * `Number("$5")` is `NaN`, `NaN > 0` is false, and a typo silently removed the
 * only guard on the balance while the deployment went on reporting that it had
 * one.
 */

/* ─────────────────────────────────────────────────────────── what a run costs
 *
 * MEASURED, on the 18 sweeps in `runs/` that carry `report.kernel` — the
 * per-host judging era, i.e. runs whose shape is the current one — and only
 * those whose model billed under a tenth of a cent per call, i.e. the default
 * model. A least-squares fit of `report.cost.usd` against `report.queries`
 * across 15 to 324 queries:
 *
 *     usd(queries) = 0.0146 + 0.0106 × queries
 *
 * The worst-fitting of the 18 cost 1.24× what the line says, the best 0.85×;
 * that spread is `worstOverrun` below and it is what the headroom is sized
 * against. At the 18 queries a 300s host affords the line gives $0.205 — and
 * the owner's own six runs through the DEPLOYED app, measured a completely
 * different way, came in at $0.147 to $0.202. Two measurements landing within
 * three tenths of a cent of each other.
 *
 * The composition, from the same 18 runs, because it is what sizes the reserve
 * further down:
 *
 *     SERP    58%-77% of the bill, at exactly ONE call per fired query
 *             (serpCalls/queries = 1.00 in every single run), $0.0067-$0.0086
 *             a call
 *     model   23%-42%, at $0.00022-$0.00044 a call on the default model
 *     fetch   free
 *
 * THE COEFFICIENTS ARE A MODEL'S. Set `OPENKB_MODEL` to something dearer and
 * they are wrong in the expensive direction: two runs in `runs/` with a large
 * model billed $0.0837 and $0.0419 a query, six to eight times this fit. That
 * is why the derived cap below is a DEFAULT and `OPENKB_RUN_CAP_USD` overrides
 * it, and why the route logs a line naming that variable when the configured
 * model is not the one these numbers were measured on. The failure is a run
 * stopped early rather than a bill nobody expected, which is the direction this
 * whole file errs in.
 *
 * WHY THIS TABLE IS NOT IN `@open-kb/core` BESIDE clock.ts, THOUGH THE WATCHDOG
 * THAT READS IT IS. What core owns is the MECHANISM — `withSpendCap`, and the
 * reserve it holds back to stop a run at a cap rather than past it — because
 * four callers now need exactly one copy of that ordering argument: this route
 * and the three CLI entrypoints. What core must not own is what a run may cost,
 * because the two payers disagree about it by an order of magnitude and for good
 * reasons: this file derives $0.41 from the queries a 300s host affords, and
 * `scripts/spend-caps.ts` measures $8.00 from what an unbounded CLI run actually
 * costs. A shared default would be wrong for both. The engine still takes
 * `ceilingUsd` as an opaque number it reports and never enforces.
 */
export const MEASURED_RUN_COST = {
  /** How many runs the fit is over. */
  runs: 18,
  /** The model they were measured on. */
  model: "deepseek/deepseek-v4-flash",
  /** The intercept: understand + plan, which do not scale with the budget. */
  fixedUsd: 0.0146,
  /** The slope: one query's search plus the hosts it drags into rank. */
  usdPerQuery: 0.0106,
  /** The worst single run's ratio of actual to fitted cost, over the 18. */
  worstOverrun: 1.25,
  /** The dearest single SERP call observed — the unit of an in-flight overrun. */
  serpUsdPerCall: 0.0086,
} as const

/** What a run of `queries` queries costs, at the fit above. */
export function runUsd(queries: number): number {
  return MEASURED_RUN_COST.fixedUsd + MEASURED_RUN_COST.usdPerQuery * Math.max(0, queries)
}

/**
 * How far above a run's expected cost its ceiling sits.
 *
 * 2, and both directions of the choice are measured. BELOW: the worst-fitting
 * real run cost 1.25× its fit, so anything under about 1.3 would stop healthy
 * runs, and a healthy run stopped at 90% is a map the visitor does not get and
 * money already spent. ABOVE: the one runaway this repo has recorded — the
 * clerk.com run that bought 132 searches on a 300s host — spent $0.7099, and
 * 2 × $0.205 = $0.41 stops it less than halfway.
 *
 * The gap between 1.25 and 2 is the reserve carved out below plus the room a
 * dearer-than-median market needs. It is not slack.
 */
const CAP_HEADROOM = 2

/**
 * The default ceiling for one run of `queries` queries, in whole cents.
 *
 * DERIVED, NOT A LITERAL, for the reason `QUERY_BUDGET` in the map route is
 * derived: `maxDuration` is edited per plan — 300 on Hobby buys 18 queries, 800
 * on Pro buys 70 — and a hardcoded $0.41 would kill every single run on Pro,
 * where a healthy run costs $0.76. The comment above `QUERY_BUDGET` says a
 * hardcoded 18 "would have quietly capped a Pro deployment at the Hobby map";
 * a hardcoded cap would have given it no map at all.
 *
 *     18 queries → $0.41      70 queries → $1.51      175 queries → $3.74
 */
export function defaultRunCapUsd(queries: number): number {
  return round2(CAP_HEADROOM * runUsd(queries))
}

/**
 * How much of a run's ceiling is held back so the run can be STOPPED at it
 * rather than discovered past it, and the total it is stopped at.
 *
 * BOTH LIVE IN `@open-kb/core` NOW, beside the watchdog that reads them, and are
 * re-exported here because this file's own refusals quote them and half the repo
 * imports them from this name. The deadline watchdog reserves 30 seconds to
 * write an ending down; this is the same idea in the other currency, it is the
 * watchdog's own parameter rather than a policy of this deployment's, and it
 * acquired three more callers the day the CLI entrypoints got a cap
 * (`scripts/spend-caps.ts`). Core shows the arithmetic and its working.
 *
 * WHAT IT COMES TO HERE. `max($0.05, 25% of the cap)` at the default 18-query
 * cap is $0.10, so the trip point lands at $0.31 — 1.5× the worst real run of
 * that size, so it does not fire on a healthy one. From the composition above,
 * $0.10 buys 250 classify calls or 12 SERP calls; the rank pool is 8 wide
 * (`OPENKB_RANK_CONCURRENCY`), so a trip during rank overruns by about half a
 * cent. The one thing that can be wider is a search wave, at 20 — but a whole
 * run's search spend is bounded by `maxQueries × $0.0086`, which at 18 queries
 * is $0.155 for the entire run, against a trip point of $0.31.
 */
export { reserveUsd, tripAtUsd }

/* ─────────────────────────────────────────────────────────────── the settings */

/**
 * Every variable this file reads, spelled once.
 *
 * Exported because three other things quote them — the refusal sentences below,
 * DEPLOY.md's table, and the tests — and a limit whose name is written in four
 * places is a limit that gets renamed in three.
 */
export const LIMIT_VARS = {
  runCap: "OPENKB_RUN_CAP_USD",
  dayCap: "OPENKB_DAY_CAP_USD",
  perVisitor: "OPENKB_RUNS_PER_VISITOR_PER_DAY",
  atOnce: "OPENKB_RUNS_AT_ONCE",
  salt: "OPENKB_VISITOR_SALT",
} as const

/**
 * What a limit reads as: a number, deliberately off, or a value nobody can act
 * on.
 *
 * THE THIRD CASE IS THE POINT. `Number("$5")` is `NaN`; `NaN > 0`, `NaN >= 0`
 * and `NaN < 0` are all false, so every obvious guard written against it waves
 * the request through. That is not a hypothetical — it is what
 * `OPENKB_CEILING_USD` does today, and the deployment goes on claiming a
 * ceiling it does not have. A malformed limit is not a missing limit; it is an
 * operator who believes they set one, and the only safe reading of it is to
 * refuse and say so.
 */
type Setting = { on: true; value: number } | { on: false } | { bad: string }

/** The one spelling that turns a limit off. A word, not a number, so that no
 *  typo, empty string or stray space can produce it by accident. */
const OFF = "off"

function setting(name: string, fallback: number, whole: boolean): Setting {
  const raw = process.env[name]
  // Unset, empty, or whitespace — the deployment said nothing, so the default
  // applies. `Number(" ")` is 0, which is why this test comes before any parse:
  // a stray space in a dashboard field would otherwise read as "spend nothing"
  // on a day cap and "no maps for anyone" on a count.
  if (raw === undefined || raw.trim() === "") return { on: true, value: fallback }
  const text = raw.trim()
  if (text.toLowerCase() === OFF) return { on: false }
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) {
    return {
      bad:
        `${name} is ${quote(text)}, which is not ${whole ? "a whole number" : "an amount in dollars"}. ` +
        `Write ${whole ? "a whole number, e.g. 3" : "a plain number of dollars, e.g. 5 — no $ sign"}, ` +
        `or the word "${OFF}" to remove the limit.`,
    }
  }
  if (whole && !Number.isInteger(n)) {
    return {
      bad:
        `${name} is ${quote(text)}, and a count of runs has to be a whole number. ` +
        `Write ${Math.floor(n)} or ${Math.ceil(n)}, or the word "${OFF}" to remove the limit.`,
    }
  }
  return { on: true, value: n }
}

/** An operator's own value, quoted back at them, bounded. Their configuration
 *  is the one caught string this file is allowed to echo — the same permission
 *  `namedFaults.runsDirIsRoot` takes, for the same reason: they are the only
 *  reader who can act on it. */
function quote(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)
}

/** Every limit in force, or the first thing an operator has to fix. `null`
 *  means a limit was deliberately turned off. */
export interface Limits {
  runCapUsd: number | null
  dayCapUsd: number | null
  perVisitorPerDay: number | null
  atOnce: number | null
}

export type LimitsReading = { ok: true; limits: Limits } | { ok: false; why: string }

/**
 * THE DEFAULTS, and the argument for each.
 *
 * They are ON by default and this is the whole design. "A deployment with no
 * limits configured must not start spending because somebody upgraded" cuts
 * both ways: the door being shut is lib/public-runs.ts's job, and a door that
 * someone opens should not open onto an unmetered account. Every one of these
 * can be raised in one line or removed with the word "off"; none of them can be
 * removed by forgetting something.
 *
 *   RUN CAP — derived, $0.41 on a 300s host. Argued at `CAP_HEADROOM`.
 *
 *   DAY CAP — $5.00. At $0.205 a map that is about 22 maps a day, which is a
 *     demo that works for everyone who is likely to find it on a given day, and
 *     it is the figure DEPLOY.md already reaches for as the invite-gated
 *     ceiling, so it is not a new number for an operator to learn. The owner's
 *     own arithmetic is that a hundred curious people cost twenty dollars; this
 *     default is deliberately a quarter of that, because the person it protects
 *     is the one who cloned this repo, deployed it, and forgot.
 *
 *   PER VISITOR — 3 a day. One to see that it works, one for your own company,
 *     one for the competitor you thought of afterwards. Three maps is $0.62, so
 *     a single visitor can take at most an eighth of the day's budget, and the
 *     day needs at least eight distinct people to be spent rather than one
 *     person with a shell loop.
 *
 *   AT ONCE — 3. Not a resource limit; a rate limit wearing the only clothes
 *     serverless will fit. A run holds its slot for up to `maxDuration`, so 3
 *     at once and ~250 seconds a run means the deployment can start about 43
 *     maps an hour — the day's budget is therefore spent over half an hour at
 *     worst instead of in the ninety seconds a loop needs, which is the
 *     difference between a demo that is briefly busy and a demo that is dead
 *     for the rest of the day. It also bounds the reservation below: 3 runs in
 *     flight hold 3 × the run cap out of the day's budget.
 *
 * Read inside a function, NEVER at module scope, for lib/demo.ts's reason:
 * Next inlines a statically analysable `process.env.X` at build time, so a
 * module-level `const CAP = Number(process.env.OPENKB_DAY_CAP_USD ?? 5)`
 * becomes `const CAP = 5` in an image built without it, and an operator who
 * raised the cap in their host's dashboard would be silently held at the
 * default. `ceilingUsd()` in the map route documents shipping the same bug in
 * the more expensive direction.
 */
export function readLimits(budgetQueries: number): LimitsReading {
  const read = [
    ["runCapUsd", setting(LIMIT_VARS.runCap, defaultRunCapUsd(budgetQueries), false)],
    ["dayCapUsd", setting(LIMIT_VARS.dayCap, 5, false)],
    ["perVisitorPerDay", setting(LIMIT_VARS.perVisitor, 3, true)],
    ["atOnce", setting(LIMIT_VARS.atOnce, 3, true)],
  ] as const

  const limits: Limits = {
    runCapUsd: null,
    dayCapUsd: null,
    perVisitorPerDay: null,
    atOnce: null,
  }
  for (const [key, s] of read) {
    if ("bad" in s) return { ok: false, why: s.bad }
    limits[key] = s.on ? s.value : null
  }

  // A CAP TOO SMALL TO BUY ANYTHING, which is not a strict limit but a broken
  // one. `reserveUsd` holds back the greater of $0.05 and a quarter of the cap,
  // so below about eight cents the trip point falls to zero and every run is
  // aborted on its first span — a deployment that answers every visitor with a
  // stopped map and no explanation an operator can act on. The floor is stated
  // against the smallest run that exists (one query) rather than picked.
  if (limits.runCapUsd !== null && tripAtUsd(limits.runCapUsd) <= runUsd(1)) {
    return {
      ok: false,
      why:
        `${LIMIT_VARS.runCap} is $${limits.runCapUsd.toFixed(2)}, and no map can be built for that — ` +
        `a one-query map costs about $${runUsd(1).toFixed(2)} and a ceiling holds back ` +
        `$${reserveUsd(limits.runCapUsd).toFixed(2)} of itself so the run can be stopped at it rather ` +
        `than past it. Every run would be aborted before it found anything. Raise it, or write "${OFF}".`,
    }
  }

  // TWO LIMITS THAT CONTRADICT EACH OTHER, caught here rather than discovered
  // as a demo that refuses everything for no stated reason. A day cap below a
  // run cap can never satisfy the reservation below it, so every run is refused
  // with "today's budget is spent" on a day nothing has run. That sentence
  // would be a lie, and the operator would have no way to tell it from a busy
  // day.
  if (limits.dayCapUsd !== null && limits.runCapUsd !== null && limits.dayCapUsd < limits.runCapUsd) {
    return {
      ok: false,
      why:
        `${LIMIT_VARS.dayCap} is $${limits.dayCapUsd.toFixed(2)} and ${LIMIT_VARS.runCap} is ` +
        `$${limits.runCapUsd.toFixed(2)}, so a single map is allowed to cost more than the whole ` +
        `day — no map can ever start. Raise ${LIMIT_VARS.dayCap} above ${LIMIT_VARS.runCap}, or ` +
        `lower ${LIMIT_VARS.runCap}.`,
    }
  }
  return { ok: true, limits }
}

/* ────────────────────────────────────────────────────────────── who is asking
 *
 * THE CLIENT IS NOT THE FIRST ENTRY OF `x-forwarded-for`.
 *
 * Every proxy in a chain APPENDS the address it received the request from, so
 * the header reads client, proxy, proxy — and the leftmost entry is the only
 * one no proxy wrote. It is whatever the client sent. A visitor who sets
 * `X-Forwarded-For: 1.2.3.4` gets `1.2.3.4, <their real address>` at the
 * function, and a limiter reading the head of that list is a limiter with a
 * header field for "please do not count this".
 *
 * So this reads the LAST entry, which is the one the nearest proxy wrote and
 * the only one a client cannot forge, and it prefers the platform's own header
 * ahead of the generic one where there is one. The two failure directions are
 * not symmetrical: reading a forgeable value under-limits, which costs money
 * and cannot be noticed; reading a shared upstream proxy over-limits, which
 * costs one visitor a refusal that says exactly what happened and when it
 * lifts.
 *
 * WHAT NO HEADER CAN FIX. On a host with no proxy in front of it — `next start`
 * on a bare box, the Dockerfile — every one of these headers is client-supplied
 * and none of them means anything. A route handler is not given the socket, so
 * there is no better answer available here. Such a deployment gets its
 * protection from the day cap and the concurrency limit, which no header can
 * touch, and DEPLOY.md says so rather than this function pretending otherwise.
 */

/** The headers a proxy writes, in the order they are trusted. */
const IP_HEADERS = ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"] as const

export function clientIp(headers: Headers): string | null {
  for (const name of IP_HEADERS) {
    const raw = headers.get(name)
    if (!raw) continue
    const last = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .at(-1)
    if (last) return bareAddress(last)
  }
  return null
}

/** `1.2.3.4:5678` and `[2001:db8::1]:443` are both addresses with a port on
 *  them, and a port changes every request. A bare IPv6 address is full of
 *  colons and must survive untouched, which is why this is not `split(":")[0]`. */
function bareAddress(value: string): string {
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(value)
  const bare = bracketed ? bracketed[1]! : value
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(bare)
  if (withPort) return withPort[1]!
  // AN IPv4 ADDRESS WEARING AN IPv6 SPELLING. A proxy terminating a dual-stack
  // socket often reports `::ffff:203.0.113.9`, and left alone that falls
  // through to the /64 rule below — where its first four groups are all zero,
  // so every IPv4 visitor on such a host collapses into ONE bucket and shares
  // one allowance between them. Unwrapped here rather than special-cased there,
  // because it is not an IPv6 address; it is an IPv4 address written long.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)
  if (mapped) return mapped[1]!
  return bare
}

/**
 * The bucket an address counts against.
 *
 * IPv4 counts as itself. IPv6 counts as its first four groups — the /64 that
 * every residential and mobile allocation hands out whole. Without that, an
 * IPv6 visitor changes the low half of their address between requests, at no
 * cost and with no tooling, and the per-visitor limit is decoration. A /64 is
 * the smallest unit an IPv6 client cannot pick for itself.
 */
function bucket(ip: string): string {
  if (!ip.includes(":")) return ip
  // `::` expands to as many zero groups as it takes; for a /64 prefix the
  // expansion only matters when the elision is inside the first four groups,
  // and in that case the groups after it are zeros either way.
  const [head] = ip.toLowerCase().split("%")
  const groups = head!.split(":")
  const at = groups.indexOf("")
  const expanded =
    at === -1
      ? groups
      : [...groups.slice(0, at), ...Array(Math.max(0, 8 - groups.filter(Boolean).length)).fill("0"), ...groups.slice(at + 1).filter(Boolean)]
  return `${expanded.slice(0, 4).map((g) => g || "0").join(":")}::/64`
}

/**
 * A visitor, as something that can go in a database column.
 *
 * A HASH, NOT AN ADDRESS, and not because anyone asked. This row outlives the
 * run by years, the whole table is readable by anything holding the service
 * key, and the only question ever asked of this column is "is this the same
 * person as that one" — which a hash answers exactly as well as an address
 * does. Storing the address instead would be collecting a personal identifier
 * to answer a question that does not need one.
 *
 * SALTED, because IPv4 is 32 bits: an unsalted hash of the whole address space
 * is four billion digests, which is minutes of work, so an unsalted column is
 * an address column with an extra step. `OPENKB_VISITOR_SALT` is what makes it
 * one-way in practice. It is not required — a deployment without one still gets
 * a working limiter and a column that is merely awkward to reverse rather than
 * impossible — and DEPLOY.md says to set it.
 *
 * NO ADDRESS AT ALL is its own bucket, shared by everyone in it. Not an
 * exemption: a request that arrives with nothing identifying it must not count
 * as a fresh visitor every time, or the limit is off by default on exactly the
 * hosts where headers cannot be trusted.
 */
export const UNKNOWN_VISITOR = "unknown"

export function visitorOf(headers: Headers): string {
  const ip = clientIp(headers)
  if (!ip) return UNKNOWN_VISITOR
  const salt = process.env[LIMIT_VARS.salt] ?? "open-kb"
  return createHash("sha256").update(`${salt}:${bucket(ip)}`).digest("hex").slice(0, 16)
}

/* ───────────────────────────────────────────────────────────────── the ledger */

/**
 * Runs this process started today, for the deployment that has no store.
 *
 * A LIE ACROSS INSTANCES, and it is only reached where there are none. With
 * `SUPABASE_URL` set — which DEPLOY.md already calls required on Vercel, and
 * which the day cap now makes required a second time — every count below comes
 * out of Postgres and is true for the whole deployment. Without it, the only
 * hosts left are the ones where this process IS the deployment: `next dev`, a
 * `next start` box, the Dockerfile. There an in-process array is not an
 * approximation of the truth, it is the truth, and it costs no round trip.
 *
 * The honest gap is the deployment that is serverless AND storeless. That one
 * already loses every run it starts the moment the instance goes — there is no
 * disk to fall back to and no row to read — so it is not a configuration
 * anything here can rescue, and DEPLOY.md refuses it for the older reason.
 *
 * Held on `globalThis` for lib/runs.ts's reason: Next re-evaluates a route's
 * module graph on edit, and a fresh module instance would mean a fresh ledger
 * with every run of the day forgotten.
 */
const LEDGER = Symbol.for("open-kb.spend-ledger")
interface Entry {
  id: string
  at: number
  visitor: string
  status: "running" | "ended"
  usd: number
}
const g = globalThis as unknown as { [LEDGER]?: Entry[] }
const ledger: Entry[] = (g[LEDGER] ??= [])

/** Two days, so that "today" is always whole and the array cannot grow without
 *  bound on a box that is never restarted. */
const LEDGER_KEEP_MS = 2 * 86_400_000

export function noteRunStarted(id: string, visitor: string, now = Date.now()): void {
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (now - ledger[i]!.at > LEDGER_KEEP_MS) ledger.splice(i, 1)
  }
  ledger.push({ id, at: now, visitor, status: "running", usd: 0 })
}

/** What the run actually cost, once it has one. Until this lands the run is
 *  counted at its cap, which is what makes the reservation below hold. */
export function noteRunEnded(id: string, usd: number): void {
  const e = ledger.find((x) => x.id === id)
  if (!e) return
  e.status = "ended"
  e.usd = Number.isFinite(usd) ? usd : 0
}

/** Test seam. Nothing in production empties this — a day rolls over by itself. */
export function resetLedger(): void {
  ledger.length = 0
}

function ledgerSince(since: number): UsageRow[] {
  return ledger
    .filter((e) => e.at >= since)
    .map((e) => ({
      started_at: new Date(e.at).toISOString(),
      status: e.status === "running" ? ("running" as const) : ("complete" as const),
      usd: e.usd,
      visitor: e.visitor,
    }))
}

/* ──────────────────────────────────────────────────────────────── the verdict */

export type SpendVerdict =
  | {
      ok: true
      /** What this run may cost, or null when the run cap is off. */
      runCapUsd: number | null
      /** The bucket to record against the run, so tomorrow's count can find it. */
      visitor: string
      /** The instant the claim was written with. `createRun` reuses it so the
       *  row it upserts over the claim does not move the run's own start. */
      startedAt: string
    }
  | {
      ok: false
      status: 429 | 503
      /** One sentence for whoever asked. Never names an environment variable
       *  unless the fix IS an environment variable. */
      error: string
      /** The line for the operator, which does name it. Printed by the route to
       *  stderr, so a demo the owner is themselves locked out of explains
       *  itself where they will look. */
      log: string
    }

/** Rows this deployment has started since midnight UTC, plus the arithmetic. */
interface Counted {
  /** Money already spent by runs that ended. */
  spentUsd: number
  /** Runs still in flight, within the window a run can still be alive in. */
  inFlight: number
  /** Runs this visitor started today, whatever became of them. */
  byVisitor: number
}

/**
 * WHAT A RUN IN FLIGHT COSTS, before it has cost anything.
 *
 * Its cap. A run that started ninety seconds ago has spent something and
 * recorded nothing, and counting it at zero is how three concurrent runs walk
 * a day's budget past its ceiling while every one of them reads as free. So a
 * run in flight is held against the budget at the most it can still become, and
 * settles to its real cost when it ends — which is `Ledger.reserve()` and
 * `Ledger.settle()` from `@open-kb/core`, in a table instead of in memory, for
 * the same reason that class gives.
 *
 * THIS IS WHAT MAKES THE DAY CAP A CEILING RATHER THAN A HOPE. Every dollar of
 * the day is either spent and counted, or reserved at the cap of a run that
 * cannot exceed it. A run only starts if a whole cap still fits. So the day's
 * spend cannot pass the cap — not by one run, not by three at once, and not by
 * a burst timed to land between two readings.
 *
 * A RUNNING ROW OLDER THAN THE WINDOW is a run whose instance died without
 * writing its ending. It is not in flight and does not hold a slot, but it did
 * spend, and nothing can now say how much — so it is counted at its cap too.
 * That is deliberately pessimistic: a deployment where several runs a day die
 * that way will run out of budget early, which is the correct response to a
 * deployment that is losing runs, and it heals at midnight rather than needing
 * anybody to clean a table.
 *
 * WITH THE RUN CAP OFF the reservation is zero, and the day cap degrades from a
 * ceiling to a preflight check — a run in flight commits nothing, so several
 * started together can carry the day past its limit before any of them records
 * a cost. That is the honest consequence of `OPENKB_RUN_CAP_USD=off` and the
 * reason the two are worth keeping together; DEPLOY.md says so where an
 * operator is choosing.
 */
function count(rows: readonly UsageRow[], visitor: string, now: number, windowMs: number, capUsd: number | null): Counted {
  let spentUsd = 0
  let inFlight = 0
  let byVisitor = 0
  for (const r of rows) {
    if (r.visitor && r.visitor === visitor) byVisitor++
    if (r.status === "running") {
      const at = Date.parse(r.started_at)
      // A row whose timestamp will not parse is treated as in flight: the
      // conservative reading, and the one that cannot be produced deliberately.
      if (!Number.isFinite(at) || now - at <= windowMs) inFlight++
      spentUsd += capUsd ?? 0
      continue
    }
    spentUsd += Number.isFinite(r.usd) ? r.usd : 0
  }
  return { spentUsd, inFlight, byVisitor }
}

/**
 * May a run start right now, and what may it cost?
 *
 * IT CLAIMS RATHER THAN CHECKS, and that is the difference between a limit and
 * a suggestion. This used to read today's rows, decide, and let the route write
 * the run's row afterwards — correct for any one request and worthless against
 * twenty fired together, which all read the same empty day and are all
 * individually right. Measured on the shape this replaced: 20 of 20 admitted
 * against a limit of 3, and 12 of 12 against a $1.00 day cap, which is $4.92
 * committed. Both are pinned as tests in app/api/map/limits.test.ts.
 *
 * So the count and the row are one act. With a store that is `claim_run` in
 * scripts/supabase-schema.sql, holding a transaction-scoped advisory lock. With
 * no store it is `claimInMemory` below, which needs no lock because it does not
 * await between reading and writing. The run's id is therefore MINTED BY THE
 * CALLER and handed in: the row exists before this returns.
 *
 * Ordered by how long the answer stays true, longest first, because a visitor
 * given the shortest-lived reason comes back in two minutes to be told the
 * durable one. Out of runs for the day beats out of budget for the day beats
 * everything is busy. The order lives in both implementations and the sentences
 * live in `refusal` below, once.
 *
 * `aboutSeconds` is what the route's own arithmetic says a run of this size
 * takes; it is quoted in the busy sentence so a visitor is told how long to
 * wait rather than to "try again later".
 */
export async function spendGate(opts: {
  /** The id the run will have. Minted by the caller because the claim IS the
   *  row: Postgres writes it, and `createRun` upserts the same id over it. */
  id: string
  domain: string
  headers: Headers
  /** The query budget this host affords, from which the default run cap comes. */
  budgetQueries: number
  /** How long a run can still be alive — the host's own function limit. */
  runWindowMs: number
  /** Roughly how long a run takes, for the sentence a busy visitor reads. */
  aboutSeconds: number
  now?: number
}): Promise<SpendVerdict> {
  const now = opts.now ?? Date.now()
  const startedAt = new Date(now).toISOString()
  const visitor = visitorOf(opts.headers)

  const reading = readLimits(opts.budgetQueries)
  if (!reading.ok) {
    // 503 rather than 429: nothing is used up, the deployment cannot currently
    // decide, and it will answer differently once someone edits one line.
    return {
      ok: false,
      status: 503,
      error: `This deployment's spending limits are misconfigured, so it is not starting any run until that is fixed. ${reading.why}`,
      log: `spend limits misconfigured: ${reading.why}`,
    }
  }
  const { runCapUsd, dayCapUsd, perVisitorPerDay, atOnce } = reading.limits

  // A deployment with every limit off asks the store nothing. That is the
  // private box, the CLI-shaped deployment and the operator who has read
  // DEPLOY.md and decided; it costs them no round trip to have decided.
  if (dayCapUsd === null && perVisitorPerDay === null && atOnce === null) {
    if (!db.configured()) noteRunStarted(opts.id, visitor, now)
    return { ok: true, runCapUsd, visitor, startedAt }
  }

  const since = dayStartedAt(now)
  const claim = db.configured()
    ? await db.claimRun({
        id: opts.id,
        domain: opts.domain,
        queries: opts.budgetQueries,
        startedAt,
        visitor,
        since: since.toISOString(),
        windowMs: opts.runWindowMs,
        runCapUsd,
        dayCapUsd,
        perVisitorPerDay,
        atOnce,
      })
    : claimInMemory(opts.id, visitor, now, opts.runWindowMs, reading.limits)

  if (claim.kind !== "claimed" && claim.kind !== "refused") {
    // FAILS CLOSED, and this is the branch that matters most. A store that
    // answered "nothing today" when it is really down reads as a full budget
    // and hands a stranger's script the account — which is the exact shape of
    // the bug this file exists to not repeat, one layer down.
    return {
      ok: false,
      status: 503,
      error:
        "This deployment meters what it spends on maps, and right now it cannot reach the " +
        "database that keeps the count — so it is not starting a run it could not account " +
        "for. Nothing is wrong with what you asked for; try again in a minute.",
      log:
        claim.kind === "unconfigured"
          ? "spend limits are on and no store is configured"
          : `cannot claim a run: ${claim.why}`,
    }
  }

  if (claim.kind === "refused") {
    return refusal(claim, reading.limits, {
      resets: untilReset(now),
      budgetQueries: opts.budgetQueries,
      aboutSeconds: opts.aboutSeconds,
      visitor,
    })
  }

  return { ok: true, runCapUsd, visitor, startedAt }
}

/**
 * The same three checks, for the deployment that has no store.
 *
 * SYNCHRONOUS, and that is not a style choice — it is what makes it atomic. The
 * hole this whole restructure closes is an await between the count and the
 * write, and there is none here: JavaScript runs this to completion before any
 * other request's gate resumes, so two requests cannot both read an empty day.
 * The Postgres path buys the same guarantee with an advisory lock because it
 * has more than one instance to serialize.
 */
function claimInMemory(
  id: string,
  visitor: string,
  now: number,
  windowMs: number,
  limits: Limits,
): db.ClaimResult {
  const c = count(ledgerSince(dayStartedAt(now).getTime()), visitor, now, windowMs, limits.runCapUsd)
  const counts = { byVisitor: c.byVisitor, spentUsd: c.spentUsd, inFlight: c.inFlight }
  if (limits.perVisitorPerDay !== null && c.byVisitor >= limits.perVisitorPerDay) {
    return { kind: "refused", limit: "visitor", ...counts }
  }
  if (limits.dayCapUsd !== null && c.spentUsd + (limits.runCapUsd ?? 0) > limits.dayCapUsd) {
    return { kind: "refused", limit: "day", ...counts }
  }
  if (limits.atOnce !== null && c.inFlight >= limits.atOnce) {
    return { kind: "refused", limit: "at-once", ...counts }
  }
  noteRunStarted(id, visitor, now)
  return { kind: "claimed", ...counts }
}

/**
 * What a refused visitor reads, and what the operator reads beside it.
 *
 * Written HERE and only here, in both paths' way, because the store now decides
 * which limit bound and a sentence written next to that decision would be a
 * second copy of these in SQL, untested, upgraded separately from the code that
 * quotes the same numbers.
 */
function refusal(
  claim: { limit: "visitor" | "day" | "at-once" } & db.ClaimCounts,
  limits: Limits,
  ctx: { resets: string; budgetQueries: number; aboutSeconds: number; visitor: string },
): SpendVerdict {
  if (claim.limit === "visitor") {
    const n = limits.perVisitorPerDay ?? 0
    return {
      ok: false,
      status: 429,
      error:
        `You have already built ${claim.byVisitor} ${plural(claim.byVisitor, "map")} here today, and this ` +
        `deployment builds ${n} a day for one visitor. Your count goes back to zero at 00:00 UTC, ` +
        `in ${ctx.resets}. If you would rather not wait, clone ${DEMO_REPO} and run it on your own ` +
        `keys — there is no limit there, and it is the same code that built the maps on this page.`,
      log: `visitor ${ctx.visitor} has started ${claim.byVisitor} runs today, limit ${n} (${LIMIT_VARS.perVisitor})`,
    }
  }

  if (claim.limit === "day") {
    const dayCapUsd = limits.dayCapUsd ?? 0
    const need = limits.runCapUsd ?? 0
    const about = runUsd(ctx.budgetQueries)
    return {
      ok: false,
      status: 429,
      error:
        `This deployment spends up to $${dayCapUsd.toFixed(2)} a day building maps for visitors, ` +
        `and today's is committed — $${claim.spentUsd.toFixed(2)} of it${claim.inFlight > 0 ? `, ${claim.inFlight} of those still running` : ""}. ` +
        `A map costs about $${about.toFixed(2)} at the search and model providers, so there is not ` +
        `enough left to start another one. The budget resets at 00:00 UTC, in ${ctx.resets}. Every map ` +
        `already on this deployment is a finished run and opens now; to build a new one today, ` +
        `clone ${DEMO_REPO} and run it on your own keys.`,
      log:
        `today's spend $${claim.spentUsd.toFixed(4)} + $${need.toFixed(2)} reserved for this run ` +
        `exceeds $${dayCapUsd.toFixed(2)} (${LIMIT_VARS.dayCap})`,
    }
  }

  const atOnce = limits.atOnce ?? 0
  const mins = Math.max(1, Math.round(ctx.aboutSeconds / 60))
  return {
    ok: false,
    status: 429,
    error:
      `This deployment builds ${atOnce} ${plural(atOnce, "map")} at a time and ${claim.inFlight} ` +
      `${claim.inFlight === 1 ? "is" : "are"} being built right now. Each one takes about ` +
      `${mins} ${plural(mins, "minute")}, so try again shortly — nothing is used up and your ` +
      `own allowance has not been touched.`,
    log: `${claim.inFlight} runs in flight, limit ${atOnce} (${LIMIT_VARS.atOnce})`,
  }
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

import { banned, registrableHost, type Mission } from "@open-kb/core"

/**
 * The sweep→swarm handoff: mint a swarm board from a sweep run's map.
 *
 * The two halves of the product measure differently on purpose: the sweep
 * buys BREADTH (844 entities at 96.7% precision for ~$3, settled mostly from
 * snippets), the swarm buys PROOF (own-page-verified nodes, small maps). A
 * handoff run is a swarm seeded from a sweep run's findings — verify the
 * head, chase the gaps — so one reader gets breadth AND proof.
 *
 * THE HONESTY LINE (the remember/identity seam, stated once, here): the swarm
 * map starts EMPTY — fresh map per run is decided doctrine — and NOTHING in
 * the sweep run crosses into it as a claim. No node, no edge, no evidence, no
 * tier is imported. The sweep run is CONTEXT: a mission brief that tells an
 * investigator where to look and what the sweep believed. Every entity a
 * verify mission re-records passes the swarm's own mint and admit — a quote
 * from bytes THIS run fetched, the own-page gate for commercial claims, the
 * downgrade sentence when proof falls short. A verify mission that cannot
 * re-prove the sweep's claim corrects the record; it never inherits it.
 *
 * THE PRIORITY STORY (band 61-70, the same shelf the family floor uses):
 *
 *   verify:<host>   p70..63, peek — the sweep's head, by find-weight. Own-page
 *                   proof of the map's loudest claims is the handoff's first
 *                   promise, so the head takes the top of the shelf.
 *   gap:unknowns-N  p62, read — hosts the sweep met repeatedly and could not
 *                   place. Confirmed gaps, but questions about the edge of the
 *                   map, so they queue under the head.
 *   gap:recall      p61, read — vendors the sweep's own probe pages name that
 *                   its map never met; minted only when pooled recall says the
 *                   map genuinely under-reached.
 *
 * Everything sits below the lead's urgent band (71-100) and above every
 * unreviewed proposal — the same story as the family floor: the lead's
 * bespoke plan outranks the handoff, the handoff outranks the unranked, and
 * the lead can review, re-rank or kill any of it. When the floor and the
 * handoff both open (the caller set familyFloor explicitly beside fromSweep),
 * they share the shelf and the orchestrator funds the handoff first: at equal
 * priority the board's insertion tie-break runs the targeted question before
 * the generic one.
 *
 * Everything here is mechanical — no model call. Selection is weight
 * arithmetic over fields the sweep run already carries, so the same run file
 * always mints the same board.
 */

// ── the sweep run, structurally ──────────────────────────────────────────────

/** One sweep entity, the fields the handoff reads. Structural on purpose: the
 *  swarm never imports the sweep package — a run FILE is the interface. */
export interface SweepEntityLike {
  name: string
  domain: string
  kind: string
  relation: string
  why?: string
  /** Which query lanes (products) found this host — the sweep's find-weight. */
  foundBy?: string[]
}

/** One recall probe: a roundup page's vendor list vs what the map held. */
export interface SweepProbeLike {
  url: string
  vendors: string[]
  found: string[]
}

/** A sweep run as its JSON serializes it, reduced to what the handoff needs. */
export interface SweepRunLike {
  anchor: string
  entities: SweepEntityLike[]
  report?: { recall?: { pooled: number | null; probes?: SweepProbeLike[] } }
  /** SERP traces; only hit URLs are read (the seenIn tie-break weight). */
  searched?: Array<{ hits?: Array<{ url: string }> }>
}

// ── knobs ────────────────────────────────────────────────────────────────────

/** How many head entities get a verify mission when the caller does not say. */
export const DEFAULT_VERIFY_COUNT = 8

/** Verify priorities run p70 down; ranks past the 8th share the shelf floor. */
const VERIFY_BAND_TOP = 70
const VERIFY_BAND_FLOOR = 63

/** At most this many unknown-cluster read missions per handoff. */
export const GAP_CLUSTER_CAP = 2

/** Hosts named per unknown cluster — a read's honest per-host capacity when
 *  every host needs its own settle. */
export const GAP_CLUSTER_SIZE = 5

/**
 * A pooled recall below this mints the recall-gap mission. The reference run
 * (the brightdata sweep this module's tests carry) measured 0.234 — its own
 * probe pages named four vendors for every one the map held. Below half, the
 * probes say the map under-reached; above it, the gap is noise-sized.
 *
 * IT HAS NEVER NOT FIRED, and that is a fact about the METRIC rather than
 * about the maps. Pooled recall across the 40 sweep runs on disk:
 *
 *   min 0.00   median 0.188   max 0.45
 *
 * Not one reaches 0.5. The gate is a constant, so the recall lens mints on
 * every run whatever the run did.
 *
 * The cause is measured in export-kb.ts (3756659): the answer key is every
 * outbound host on the probe pages, and 29-42% of those are footers —
 * facebook, linkedin, youtube, googleapis, gstatic. A market map correctly
 * holds none of them, which caps this figure far below 1 however good the map
 * is. "Above half, the gap is noise-sized" assumed a number that can reach
 * half, and it cannot. The rarest-first sort below already encodes the same
 * insight about the same data, from the other end.
 *
 * NOT RECALIBRATED HERE, deliberately. The honest replacement is relative to
 * the observed distribution — fire below the median, say — but the reference
 * run sits at 0.234, ABOVE that median, so any such threshold reclassifies the
 * fixture this module's tests are built on from "under-reached" to "fine".
 * Whether that is correct depends on what the recall lens is for: if it should
 * run whenever probes name vendors the map missed, the gate is vestigial and
 * should go; if it should distinguish a poor run from a typical one, the
 * number needs setting against the distribution above AND the fixture's
 * framing revisited. That is a judgement about the mission, not a constant to
 * nudge, so it is written down rather than guessed at.
 */
export const DEFAULT_RECALL_GAP_THRESHOLD = 0.5

/** Hosts named by the recall-gap mission — shallower per-host work than a
 *  cluster settle (which of these are real players?), so it carries one more. */
export const RECALL_GAP_NAMES = 6

/** An unknown qualifies for a cluster only when 2+ lanes found it: the sweep
 *  kept MEETING it and still could not place it — that is the weak spot. */
const UNKNOWN_LANE_FLOOR = 2

export interface SweepSeedOptions {
  /** The swarm run's anchor host; the sweep's row for it is never a mission. */
  anchor: string
  /** The anchor's names, banned from mission targets the way the sweep bans
   *  them from queries; defaults to the anchor host and its first label. */
  coinages?: string[]
  verifyCount?: number
  recallGapThreshold?: number
}

// ── selection ────────────────────────────────────────────────────────────────

/** A registrable host that looks like one — the sweep's early runs shipped
 *  `com?ref=…` junk from a since-fixed href capture, and junk must never
 *  become a question. */
const HOST_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

const hostOfUrl = (url: string): string | null => {
  try {
    return registrableHost(new URL(url).hostname)
  } catch {
    return null
  }
}

interface Weighted {
  entity: SweepEntityLike
  host: string
  lanes: number
  seenIn: number
}

// ── the CLI seam ─────────────────────────────────────────────────────────────
// Pure argv/JSON logic lives here so it is testable; the script keeps the I/O
// (readFileSync, process.exit) and nothing else — the sweep CLI's division of
// labor, kept.

/**
 * Pull `--from-sweep <path>` (or `--from-sweep=<path>`) out of an argv,
 * leaving the positionals in order. A flag without a path is a problem in
 * words, never a silent nothing.
 */
export function fromSweepArgv(argv: readonly string[]): {
  rest: string[]
  path: string | null
  problem: string | null
} {
  const NEEDS_PATH = "--from-sweep needs a path to a sweep run JSON"
  const rest: string[] = []
  let path: string | null = null
  let problem: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--from-sweep") {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith("--")) problem = NEEDS_PATH
      else {
        path = v
        i += 1
      }
    } else if (a.startsWith("--from-sweep=")) {
      const v = a.slice("--from-sweep=".length)
      if (v === "") problem = NEEDS_PATH
      else path = v
    } else {
      rest.push(a)
    }
  }
  return { rest, path, problem }
}

/**
 * Is this parsed JSON a sweep run the handoff can seed from, for THIS domain?
 * Shape first (anchor, non-empty entities with domain+relation), then the one
 * semantic gate: the sweep must have mapped the same market — seeding a
 * resend swarm from a stripe sweep is a mistake, refused by name.
 */
export function validateSweepRun(
  raw: unknown,
  domain: string,
): { ok: true; run: SweepRunLike } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not a run object — the file did not parse to a sweep run" }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.anchor !== "string" || r.anchor.trim() === "") {
    return { ok: false, reason: "no anchor field — is this a sweep run file?" }
  }
  if (!Array.isArray(r.entities) || r.entities.length === 0) {
    return { ok: false, reason: "no entities — the sweep run has nothing to hand off" }
  }
  for (const [i, e] of (r.entities as Array<Record<string, unknown>>).entries()) {
    if (typeof e?.domain !== "string" || typeof e?.relation !== "string") {
      return { ok: false, reason: `entity ${i} has no domain/relation — not a sweep run shape` }
    }
  }
  const swept = registrableHost(r.anchor)
  const aimed = registrableHost(domain)
  if (swept !== aimed) {
    return {
      ok: false,
      reason: `the sweep mapped ${swept}; this swarm is aimed at ${aimed} — a handoff verifies the same market, not a different one`,
    }
  }
  return { ok: true, run: raw as unknown as SweepRunLike }
}

/**
 * Mint the handoff's missions from a sweep run. Deterministic: find-weight
 * (how many of the sweep's query lanes found the host) ranks first, seenIn
 * (SERP hits naming the host across the sweep's searches) breaks ties, and
 * the host's own spelling breaks the rest.
 */
export function sweepSeedMissions(run: SweepRunLike, opts: SweepSeedOptions): Mission[] {
  const anchor = registrableHost(opts.anchor) || opts.anchor.toLowerCase()
  // `?? ""` has no honest seam: String.prototype.split always returns an
  // array of length >= 1, so `anchor.split(".")[0]` is always a defined
  // string (possibly "" when anchor itself is "", e.g. registrableHost
  // returned "" and opts.anchor.toLowerCase() was also ""), never
  // undefined. No anchor value reaches the `?? ""` arm.
  const coinages = opts.coinages ?? [...new Set([anchor, anchor.split(".")[0] ?? ""])].filter((w) => w.length > 2)
  const verifyCount = Math.max(0, Math.min(12, Math.floor(opts.verifyCount ?? DEFAULT_VERIFY_COUNT)))
  const recallThreshold = opts.recallGapThreshold ?? DEFAULT_RECALL_GAP_THRESHOLD

  /** A host the handoff may ask about at all. */
  const askable = (host: string): boolean =>
    HOST_SHAPE.test(host) && host !== anchor && !banned(host, "plain", anchor, coinages)

  // seenIn: how often each registrable host appears across the sweep's SERP hits.
  const seenIn = new Map<string, number>()
  for (const s of run.searched ?? []) {
    for (const h of s.hits ?? []) {
      const host = hostOfUrl(h.url)
      if (host) seenIn.set(host, (seenIn.get(host) ?? 0) + 1)
    }
  }

  // Sort BEFORE deduping by registrable host, so the strongest account of a
  // host wins the fold — the reference run holds `3bodymo.medium.com` (one
  // lane) rows ahead of `medium.com` (four lanes), and a first-wins dedupe
  // would let the blog shadow the platform clean out of the ranking.
  const weigh = (entities: SweepEntityLike[]): Weighted[] => {
    const rows: Weighted[] = []
    for (const entity of entities) {
      const host = registrableHost(entity.domain)
      if (!askable(host)) continue
      rows.push({ entity, host, lanes: entity.foundBy?.length ?? 0, seenIn: seenIn.get(host) ?? 0 })
    }
    rows.sort((a, b) => b.lanes - a.lanes || b.seenIn - a.seenIn || (a.host < b.host ? -1 : 1))
    const taken = new Set<string>()
    return rows.filter((r) => (taken.has(r.host) ? false : (taken.add(r.host), true)))
  }

  const missions: Mission[] = []

  // ── verify: the head, re-proven on its own pages ─────────────────────────
  const head = weigh(run.entities.filter((e) => e.relation === "competitor" || e.relation === "substitute")).slice(
    0,
    verifyCount,
  )
  head.forEach(({ entity, host, lanes }, i) => {
    const why = (entity.why ?? "").trim()
    missions.push({
      lens: "verify",
      brief:
        `Open ${host}'s own site and verify: is it genuinely ${entity.relation} to ${anchor}` +
        `${why ? ` — the sweep judged "${why}"` : ""}? Confirm from its own pages or correct the record.`,
      why:
        `the sweep's head: ${lanes} of its lanes found ${host}, but it settled from snippets — ` +
        `own-page proof is the one thing the sweep could not buy`,
      priority: Math.max(VERIFY_BAND_FLOOR, VERIFY_BAND_TOP - i),
      tier: "peek",
      dedupeKey: `verify:${host}`,
      seeds: [`https://${host}`],
    })
  })

  // ── gaps: what the sweep met repeatedly and could not place ──────────────
  const undecided = weigh(run.entities.filter((e) => e.relation === "unknown")).filter(
    (w) => w.lanes >= UNKNOWN_LANE_FLOOR,
  )
  for (let n = 0; n < GAP_CLUSTER_CAP; n++) {
    const cluster = undecided.slice(n * GAP_CLUSTER_SIZE, (n + 1) * GAP_CLUSTER_SIZE)
    if (cluster.length === 0) break
    missions.push({
      lens: "unknowns",
      brief:
        // The sweep's own spelling of the undecided host, not its registrable
        // fold: when `community.cloudflare.com` is what the sweep met, that is
        // the thing to settle — the fold is identity for dedupe, not address.
        `The sweep met these hosts across several of its query lanes and could not settle what they are ` +
        `to ${anchor}'s market: ${cluster.map((w) => w.entity.domain).join(", ")}. Search and read enough ` +
        `of each to settle it — record what it is and its relation with the why, or leave it off the map.`,
      why: "the sweep's own weak spot: repeatedly found, never decided — the cheapest confirmed gaps on the board",
      priority: 62,
      tier: "read",
      dedupeKey: `gap:unknowns-${n + 1}`,
    })
  }

  // ── recall: vendors the probes name that the map never met ───────────────
  const pooled = run.report?.recall?.pooled ?? null
  if (pooled !== null && pooled < recallThreshold) {
    const onMap = new Set(run.entities.map((e) => registrableHost(e.domain)))
    // Frequency across probes, RAREST FIRST: a host nearly every probe page
    // links (github.com sat in 6 of the reference run's 7 probes) is page
    // furniture — footers, CDNs, social; the genuine miss is the vendor one
    // roundup names and the sweep never surfaced anywhere.
    //
    // CORROBORATED AT SCALE on 2026-08-24, from the other direction. Counting
    // the whole answer key rather than the missed tail, on two runs' probes:
    //
    //   shopify      645 entries,   42% match a CDN or social pattern
    //   cloudflare  2230 entries,   29%
    //
    // Most common across both: facebook, linkedin, youtube, instagram,
    // twitter, googleapis, gstatic. The pattern that found them is
    // conservative, so those shares are floors. So the "page furniture"
    // this sort exists to skip is a third to a half of the key, not an
    // occasional github.com — and the same measurement is why
    // export-kb.ts stopped calling the pooled figure "recall" (3756659).
    //
    // The ascending sort reads like the capped-slice bug this codebase found
    // four times elsewhere on 2026-08-24 — a cap taking the weakest
    // candidates. It is the opposite: here the frequent ones ARE the weak
    // ones, and the comment above is why.
    const freq = new Map<string, number>()
    for (const probe of run.report?.recall?.probes ?? []) {
      for (const vendor of probe.vendors) {
        if (probe.found.includes(vendor)) continue
        const host = registrableHost(vendor)
        if (!askable(host) || onMap.has(host)) continue
        freq.set(host, (freq.get(host) ?? 0) + 1)
      }
    }
    const missed = [...freq.entries()]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, RECALL_GAP_NAMES)
      .map(([host]) => host)
    if (missed.length > 0) {
      missions.push({
        lens: "recall",
        brief:
          `The sweep's answer-key probes name vendors its map never met: ${missed.join(", ")}. Its pooled ` +
          `recall was ${Math.round(pooled * 100)}%. Read enough to decide which of these are real players ` +
          `in ${anchor}'s market and record them with their relation; leave the rest off the map.`,
        why: `the sweep's own probes graded its map ${Math.round(pooled * 100)}% — the missing vendors are named, not guessed`,
        priority: 61,
        tier: "read",
        dedupeKey: "gap:recall",
      })
    }
  }

  return missions
}

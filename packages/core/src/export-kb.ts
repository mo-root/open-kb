/**
 * The knowledge lake, exported: a run becomes a folder of markdown a person
 * can read and an agent can walk. Wikilinks are the edges, frontmatter is the
 * index, and every claim ships beside its receipt — the same honesty rules as
 * the map, in a shape that leaves the app.
 *
 * Structural types, not imports (the drift.ts precedent): both engines'
 * run JSONs satisfy them, and core stays free of the sweep's vocabulary. That
 * is about the SHAPES; drift.ts imports `registrableHost` from core's own
 * `url.ts` all the same, and so does the stolen-name repair below, because a
 * host rule restated is a host rule that can drift.
 * The export is a build artifact — regenerated, never hand-edited; a change
 * belongs upstream in the engine, so the folder always matches its run.
 */
import { registrableHost } from "./url.js"


export interface ExportEntity {
  name: string
  domain?: string
  kind: string
  relation: string
  what?: string
  why?: string
  because?: string
  tier?: string
  descGrounded?: number
  spans?: string[]
  foundBy?: string[]
  also?: Array<{ name?: string; what: string }>
  /** The surfacing queries, most-seen first — stored by the sweep since
   *  2026-08-17; absent on older maps and the page simply omits the line. */
  roads?: string[]
  /** How many distinct queries surfaced this host. Read only for ORDER — see
   *  `tierSort` — and optional so a map without it still exports. Structural
   *  like the rest of this interface: the sweep's own `Entity` already carries
   *  it, so nothing had to be plumbed. */
  seenIn?: number
}

/**
 * WHAT LEAVES THE APP IS THE MAP, NOT THE CRAWL.
 *
 * A run touches every host a query returned. A market map is the subset that
 * stands in some relation to the anchor, and the difference is not a matter of
 * taste — the run itself says which is which, and the export used to ship both.
 * Each gate below drops a row on a verdict the run already reached, in the
 * run's own words. Nothing is rewritten: a described entity ships exactly the
 * sentences the model wrote, or it does not ship. That is the only way the
 * folder can still claim a machine produced it.
 *
 * These are also the file's third-party safety rules, and that is deliberate:
 * every row that names a person or an organisation with no stake in this market
 * is a row the run had already declined to place, so honesty and safety cut in
 * the same direction and one gate serves both.
 */
export type DropReason = "noise" | "silent" | "withdrawn" | "unrelated" | "commentary" | "personal" | "unexplained"

/** A description the RUN wrote that says the site belongs to a person. The map
 *  is of a market; a market has no natural-person members, and a machine-written
 *  paragraph about a named individual is the one thing this export must never
 *  publish. Matched on the model's own words, so the gate never has to guess. */
const PERSONAL_PROSE =
  /\bpersonal\s+(?:\S+\s+){0,2}(?:blog|site|website|portfolio|page)\b|\bindividual(?:'s)?\s+(?:\S+\s+){0,2}(?:blog|site|website|portfolio)\b|\bnewsletter author\b|\bportfolio (?:site|website) of\b/i

/** One label under a personal-publishing platform — `x.medium.com`, not
 *  `medium.com`, which is a publisher in its own right. */
const PERSONAL_HOST = /^[a-z0-9-]+\.(?:medium|substack|tistory|wordpress)\.com$|\.blogspot\./i

/**
 * Why this entity is not in the export, or null to keep it.
 *
 * - `noise`     the classifier already said this leaves the map.
 * - `silent`    nothing was read: no description, no reason, no quote. The page
 *               could only assert that a named third party's site refused us or
 *               404'd on one day — a standing public claim about someone else
 *               with no product value behind it.
 * - `unrelated` `relation: "none"` is the run's finding that there is no
 *               relation. It is `noise` said with less confidence: every one of
 *               these rows carries a why that argues the entity is in a
 *               different market. A map of a market does not list them.
 * - `commentary` `covers` names entities that merely publish near the market.
 *               That set is unbounded — most of the web publishes near any
 *               market — and an unbounded set inside a map is noise by
 *               construction. Competitors compete, substitutes substitute,
 *               integrations integrate, directories put the anchor on a
 *               shortlist and communities are where its buyers argue; all five
 *               are bounded and load-bearing. "Also writes about this" is not.
 * - `personal`  see PERSONAL_PROSE.
 * - `withdrawn` the row wore the anchor's own name and `withoutStolenNames`
 *               took it back. It reaches `silent`'s test — the description and
 *               the reason went with the name — but it is not the same thing
 *               and must not be counted as it: these hosts WERE read, and the
 *               run really did learn something about them. It learned it about
 *               the wrong subject. Saying "unreadable this run" of
 *               `aws.amazon.com` would be a second false claim replacing the
 *               first, so it gets its own reason and its own line in the tally.
 * - `unexplained` AGENTS.md promises every refusal wears its reason. An
 *               `unknown` with no `because` is a refusal that does not, so the
 *               export cannot honour the promise by shipping it.
 */
export function exportDrop(e: ExportEntity): DropReason | null {
  if (e.kind === "noise") return "noise"
  // Before `silent`, which it would otherwise match, and which would report a
  // host that answered us as one that did not.
  if (e.because === WITHDRAWN) return "withdrawn"
  if (!e.what && !e.why && !e.spans?.length) return "silent"
  if (e.relation === "none") return "unrelated"
  if (e.relation === "covers") return "commentary"
  if (PERSONAL_PROSE.test(e.what ?? "") || PERSONAL_HOST.test(e.domain ?? "")) return "personal"
  if (e.relation === "unknown" && !e.because) return "unexplained"
  return null
}

/** Reads after a count, at any count: "55 judged unrelated to this market". */
const DROP_LABEL: Record<DropReason, string> = {
  noise: "judged unrelated to this market",
  unrelated: "judged unrelated to this market",
  silent: "unreadable this run",
  withdrawn: "stripped of the anchor's name they were given",
  commentary: "publishing near the market, not in it",
  personal: "personal, not a market entity",
  unexplained: "refused with no stated reason",
}

export interface ExportEdge {
  from: string
  to: string
  relation: string
  why?: string
  confidence?: string
}

export interface ExportRunLike {
  anchor?: string
  entities: ExportEntity[]
  edges?: ExportEdge[]
  report?: {
    usd?: number
    seconds?: number
    kernel?: Record<string, unknown>
    recall?: { pooled?: number | null; probes?: unknown[]; aliasExclusion?: { hosts?: string[]; note?: string } }
    scorecard?: { gate?: { refusals?: number; objections?: string[] } }
    ending?: { reason?: string; humanReason?: string }
  }
  stats?: { usd?: number; seconds?: number }
  decomposition?: { sells?: string; buyer?: string }
}

export interface ExportedFile {
  path: string
  content: string
}

const TIER_RANK: Record<string, number> = { "own-page": 0, page: 1, snippet: 2 }

export function slugOf(e: Pick<ExportEntity, "name" | "domain" | "kind">): string {
  const base = (e.domain && e.domain.trim()) || `${e.kind}-${e.name}`
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function fm(pairs: Array<[string, unknown]>): string {
  const lines = pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(String(v)).slice(1, -1)}`)
  return `---\n${lines.join("\n")}\n---\n`
}

/**
 * Tier first, then how many queries surfaced the host, then the key the row
 * actually displays — a list whose stated order is invisible in its own text
 * reads as no order at all.
 *
 * THE MIDDLE TERM IS THE POINT, and it was missing. `tier` is a swarm concept
 * the sweep never sets, so on every sweep-exported map both sides fell to rank
 * 3 and the whole order was the slug. `relations/competitor.md` — the file the
 * README sends a reader to as "the rivals" — opened like this:
 *
 *   activecampaign, adyen, altfunding, anchanto, arirms, b2bwave, bagisto...
 *
 * 236 rivals, alphabetical, with Stripe forty rows down. Ordered by the
 * corroboration the run already measured, the same list opens:
 *
 *   stripe 23x, salesforce 19x, bigcommerce 17x, squareup 15x, wix 13x,
 *   lightspeedhq 10x, adyen 6x
 *
 * Which is the market. `seenIn` is how many distinct queries surfaced the
 * host, the same signal `mostCorroboratedFirst` uses in the sweep to decide
 * which hosts a capped stage spends on, applied here to decide which rows a
 * reader meets first.
 *
 * The slug stays as the last term so the order is total and an export is
 * reproducible; a run with no `seenIn` sorts exactly as it did before.
 *
 * EXERCISED ACROSS FIVE ANCHORS, because "the shopify list looks right" is one
 * list. The head of `relations/competitor.md` on each:
 *
 *   cloudflare  akamai        stripe   gocardless     figma  canva
 *   datadoghq   manageengine  openai   github
 *
 * Four are the obvious answer and the fifth is defensible — GitHub reaches
 * openai.com's map through Copilot. Alphabetical gave `activecampaign` and
 * `24techcommerce`.
 *
 * The same five exports also cover the shapes this file now branches on: two
 * have enough `unknown` rows to hoist a shared reason and three do not, and
 * every one carries all three receipt sources (page, search results, second
 * look). Three of the five predate the snippet gate entirely, so a map
 * exported from an older run gets the corrected provenance too.
 */
function tierSort(a: ExportEntity, b: ExportEntity): number {
  const ta = TIER_RANK[a.tier ?? ""] ?? 3
  const tb = TIER_RANK[b.tier ?? ""] ?? 3
  return ta - tb || (b.seenIn ?? 0) - (a.seenIn ?? 0) || slugOf(a).localeCompare(slugOf(b))
}

/**
 * WHICH TEXT A RECEIPT WAS QUOTED FROM.
 *
 * The spans on an entity are verified in code as literal substrings of the
 * text the model read — but that text is not always a page. A host whose front
 * page will not open is judged from the titles and descriptions of the search
 * results that surfaced it, and its quotes are checked against those.
 *
 * Both surfaces claimed the page regardless. The export printed "verbatim from
 * its page this run" four lines under a `Downgraded:` line saying the page
 * could not be read, and the web panel's heading said "quoted from its page,
 * checked word for word". Measured on two runs, kept rows carrying spans with
 * an unreadable page: 165 of 1,215 on shopify (131 from the search results, 34
 * from a page a second look reached) and 143 of 1,182 on cloudflare.
 *
 * ONE IMPLEMENTATION, because it was two copies of the same ternary the moment
 * the second surface was fixed, and a provenance claim that drifts between the
 * export and the panel is worse than either being wrong alone. `because` is
 * the discriminator: the judge already writes it precisely enough to separate
 * the three cases, so no new field travels for this.
 */
export function receiptSource(because?: string): string {
  if (!because) return "its page this run"
  if (/second look at /.test(because)) return "the page a second look reached"
  if (/could not be read this run/.test(because))
    return "the search results that surfaced it — its own page would not open"
  return "its page this run"
}

/**
 * An entity's home lane is the market whose queries surfaced it MOST — the
 * sweep sorts `foundBy` by count descending, so `[0]` is a real winner and not
 * an array accident. Checked, because "the first element of a list" is exactly
 * the shape of four ordering bugs found elsewhere on this branch.
 *
 * IT IS AN ACCIDENT FOR THE TIES, and those are 34 of 1,215 kept rows on a
 * shopify export and 36 of 1,182 on cloudflare — about 3%, entities two lanes
 * surfaced the same number of times, where `sort` keeps whichever market's
 * query happened to run first.
 *
 * Left alone, for two reasons. Nothing is lost: a straddler carries every
 * other lane on its row (`also: ...`), so the tie decides which folder a row
 * files under and not what is known about it. And no better rule is available
 * HERE — market centrality would break the tie properly, and the export only
 * ever receives market names, not the `core`/`adjacent` grading the sweep used
 * to fund them. Recorded so the next reader who suspects the segments are
 * arbitrary can stop at 3% instead of re-deriving it.
 */
function segmentOf(e: ExportEntity): string {
  return e.foundBy?.[0] ?? "unattributed"
}

/* --------------------------------------------- a name the run never owned */

/** The rows the repair below reads and rewrites. Structural like `ExportEntity`
 *  above, and wider than it: the sweep's `Entity` carries the three
 *  measurements of a `what` (`spans`, `descGrounded`, `descSpans`) that do not
 *  survive the `what` being withdrawn, so they are named here to be cleared. */
export interface NamedRow {
  name: string
  domain?: string
  kind: string
  relation: string
  what?: string
  why?: string
  because?: string
  spans?: string[]
  descGrounded?: number
  descSpans?: { verified: number; claimed: number }
}

/** An edge as the naming pass writes it: what it joins, and the sentence that
 *  bought it. `relation` and `confidence` ride along untouched. */
export interface MintedEdge {
  from: string
  to: string
  why?: string
}

/** Judge's identity key, restated: it lives inside `judgeHosts` and there is
 *  nothing to import. Case and punctuation go because "eGain", "e-gain" and
 *  "EGAIN" are one name. */
const identityKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "")

const norm = (host: string) => host.trim().toLowerCase().replace(/^www\./, "")

/**
 * The anchor's label, by judge.ts's rule and not an approximation of it.
 *
 * `judge.ts:164` reads it off `registrableHost(anchor).split(".")[0]`. Stripping
 * `www.` and taking the first label instead agrees on every anchor stored today
 * — all twenty are apex — and disagrees the moment one is not. On
 * `docs.example.com` the shortcut reads the label as "docs", and then any row
 * named "Docs" is a stranger wearing the anchor's identity: measured on a
 * synthetic run, gitbook.com named "Docs" lost its name, kind, relation and its
 * one edge, and wore a sentence that was false about it. That is reachable
 * through the front door — `normalizeDomain` passes `docs.stripe.com` and
 * `blog.vercel.com` through untouched, and scripts/sweep.ts hands `argv[2]`
 * straight to the engine — so it is a live path with no occurrences yet rather
 * than an impossibility.
 *
 * `registrableHost` is imported rather than restated for the reason the rest of
 * this file gives for importing anything: a second copy of a rule is a rule that
 * can disagree with itself, and this one already did.
 */
const anchorLabelOf = (anchor: string) => identityKey(registrableHost(norm(anchor)).split(".")[0] ?? "")

/** What the row wears instead of the name, in judge.ts's own words for the same
 *  verdict (`judge.ts`, the anchor-imposter branch) — one clause different,
 *  because there the model had just answered and here the answer is on disk. */
const WITHDRAWN = "the stored map gave this host the anchor's own identity, so nothing it said about it stands"

/**
 * A STORED MAP WHERE A STRANGER WEARS THE ANCHOR'S NAME, repaired as it is read.
 *
 * The linker resolves a mention to an entity BY NAME, so a second entity called
 * "Vercel" collects every page in the run that mentions Vercel. Measured over
 * every map in `runs/` and `demo/maps/`: 37 rows on 14 of them carry a name
 * that reduces to the anchor's own label on a host that does not spell it —
 * `aws.amazon.com` named "Vercel" (331 edges), `eginnovations.com` named
 * "Shopify" (594, against shopify.com's own 665), `exalate.com` named "Stripe"
 * (223). Four of the fourteen are the committed gallery maps, so a reader can
 * see AWS labelled "Vercel, competitor" on the front page today.
 *
 * THE ENGINE ALREADY REFUSES THIS AT WRITE TIME — judge.ts downgrades a host
 * the model answered about with the anchor's identity, and the sweep's naming
 * pass awards a spelling to one owner. Both landed after these maps were
 * built, and rebuilding them all costs money and hours, so the same verdict is
 * reached again by reading for everything already on disk. On a map written
 * since, this changes nothing: `runs/sweep-figma-com-20260810173400.json` has
 * 0 such rows and comes back byte-identical.
 *
 * WHAT IT DOES is judge.ts's downgrade, word for word: the row survives under
 * its own host and everything the run said beneath the stolen name goes with
 * it — the kind, the relation, the description and the reason were all about a
 * different subject. Not deleted: `aws.amazon.com` is a real host that really
 * appeared, and deleting it would lose that. The name is the only part that
 * was never real.
 *
 * WHO IT SPARES: a host whose own spelling contains the label keeps its name.
 * That is the sweep's `backed` test — the owner contest in its naming pass —
 * and it separates a genuine namesake from an imposter with no list of
 * exceptions to maintain. Two rows in the corpus need it and both are the
 * anchor reached another way: one anchor's French site under `.fr` instead of
 * `.com`, 87 edges, and `raw.githubusercontent.com` on the github map, 277 —
 * `registrableHost` alone calls both of those foreign. `clerk.io`, the Danish
 * company genuinely called Clerk, would keep its name for the same reason if a
 * clerk.com run ever surfaced it. The anchor's own row and every subdomain of
 * it are spared for free, because the label is read off the anchor's host and
 * that host always spells it. A label under three characters declines to fire
 * at all, judge's rule and judge's reason: "x.com" would match names with
 * nothing to do with it.
 *
 * THE EDGES DIE WITH THE NAME THAT MINTED THEM, in one direction only. The
 * naming pass writes `a page on <host> names "<term>"` with `to` set to the
 * entity that owns the term, so an edge whose TARGET is a repaired row and
 * whose reason quotes the name that row just lost was bought with that name
 * and nothing else: 7,558 of them across the 14 files, 2,205 on the vercel map
 * alone. An edge that merely touches such a row stands. 10 run the other way
 * and each points at the term's real owner — `facebook.com -[competitor]->
 * vercel.com`, "a page on facebook.com names \"Vercel\"", which is true and is
 * about the anchor. 77 were minted by a different term entirely
 * (`aws.amazon.com -> react.dev`, "names \"React\""). 14 come from the paid
 * co-occurrence pass.
 *
 * WHAT THAT COSTS, because it is not free. Those 14 are prose this pass cannot
 * re-read: 12 describe the host truthfully as itself ("Both are major cloud
 * platforms … AWS and Google Cloud"), and 2 repeat the theft — both copies of
 * the supabase map's `facebook.com -[discusses]-> quora.com`, "Facebook's
 * product (Supabase)". They survive, hanging off a node that now says the name
 * went unsettled. Two stale sentences against 12 measured edges, and the
 * alternative deletes evidence the run really collected.
 *
 * The 14 are 7 distinct edges seen twice, because the supabase and vercel maps
 * each exist as a run and again as a committed gallery copy. De-duplicated the
 * split is 6 and 1. Counting the files rather than the edges is the honest way
 * round — the repair runs per file — but a 13/1 split cannot be built from
 * either view of this set, and an earlier draft of this comment claimed one.
 *
 * The surviving edges also keep the relation the run recorded, which was
 * computed with the row still in the rival set. Re-deriving it here would be
 * inventing a relation the run never wrote, so it is left alone and said out
 * loud instead.
 */
export function withoutStolenNames<E extends NamedRow, D extends MintedEdge>(run: {
  anchor?: string
  entities: readonly E[]
  edges?: readonly D[]
}): { entities: E[]; edges: D[]; stripped: string[] } {
  const edges = [...(run.edges ?? [])]
  const anchorLabel = anchorLabelOf(run.anchor ?? "")
  if (anchorLabel.length < 3) return { entities: [...run.entities], edges, stripped: [] }

  /** host -> the name it is losing, which is also the term its edges quote. */
  const stolen = new Map<string, string>()
  const entities = run.entities.map((e) => {
    const host = norm(e.domain ?? "")
    // No host is no repair: the host is what stands in for the name, and a row
    // without one has nothing to fall back to.
    if (!host) return e
    if (identityKey(e.name ?? "") !== anchorLabel) return e
    if (identityKey(host).includes(anchorLabel)) return e
    stolen.set(host, e.name)
    // The cast is the price of staying generic: the caller keeps its own row
    // type, and TypeScript cannot prove a spread of `E` with a wider `kind`
    // written over it is still `E`. Every field written here is one `NamedRow`
    // declares, so the shape is right even where the proof is not.
    return {
      ...e,
      name: host,
      kind: "unknown",
      what: "",
      relation: "unknown",
      why: "",
      because: WITHDRAWN,
      spans: undefined,
      descGrounded: undefined,
      descSpans: undefined,
    } as E
  })
  if (!stolen.size) return { entities, edges, stripped: [] }

  return {
    entities,
    edges: edges.filter((ed) => {
      const name = stolen.get(norm(ed.to ?? ""))
      return !name || !(ed.why ?? "").includes(`names "${name}"`)
    }),
    stripped: [...stolen.keys()],
  }
}

/** Build every file of the export. Deterministic: same run, same bytes. */
export function exportKbFiles(run: ExportRunLike): ExportedFile[] {
  const anchor = run.anchor ?? "the anchor"
  // Read before it is written out, for the same reason the browser reads it
  // that way: 9 of the 14 imposter rows clear the gates below at HEAD, and
  // `runs/exports/kb-sweep-vercel-com-202608062351/entities/aws-amazon-com.md`
  // opens `name: Vercel / domain: aws.amazon.com` under the heading `# Vercel`.
  // Repaired, they carry no description, no reason and no receipt, so
  // `exportDrop`'s existing `silent` gate takes them without a new rule.
  const repaired = withoutStolenNames(run)
  const slugifyRef = (host: string) => host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  const kept: ExportEntity[] = []
  const dropped = new Map<DropReason, number>()
  // droppedEnd built in the same pass: exportDrop is pure, so a second loop
  // recomputing it over the same entities (as this used to do) paid the cost
  // of every regex test in exportDrop twice for no different answer.
  const droppedEnd = new Map<string, DropReason>()
  for (const e of repaired.entities) {
    const why = exportDrop(e)
    if (why) {
      dropped.set(why, (dropped.get(why) ?? 0) + 1)
      droppedEnd.set(slugifyRef(e.domain ?? ""), why)
    } else {
      kept.push(e)
    }
  }
  const bySlug = new Map<string, ExportEntity>()
  for (const e of kept) {
    const s = slugOf(e)
    if (!bySlug.has(s)) bySlug.set(s, e)
  }
  // An edge is a wikilink, and a wikilink to a gated entity is a dead link. The
  // LINKED graph is therefore the induced subgraph on what survived — but the
  // induced-subgraph cut, alone, silently deleted every edge with one dropped
  // end: MEASURED on a fresh vercel export, 999 of 3,465 edges (28.8%) had
  // exactly one surviving end and rendered nowhere — github.com's page simply
  // never said it discusses runtime.news. Borrowed from graphify's taxonomy:
  // an edge too weak to link is flagged, never deleted. One-sided edges render
  // on the surviving page as plain text wearing the other end's drop label.
  const edges = repaired.edges.filter((ed) => bySlug.has(slugifyRef(ed.from)) && bySlug.has(slugifyRef(ed.to)))
  /** Drop classes whose FINDING is invalid, not merely gated: a withdrawn
   *  end wore an identity that was never its own, so every edge bought with
   *  it is tainted; a personal end must not be named anywhere, which is the
   *  whole point of that gate; a noise end is not a finding at all. The
   *  policy gates — commentary, unrelated, silent, unexplained — keep the
   *  half-edge: the surviving page really does relate to that host, and the
   *  label says why there is no page for it here. */
  const TAINTED: ReadonlySet<DropReason> = new Set(["withdrawn", "personal", "noise"] as DropReason[])
  const halfEdges = repaired.edges.filter((ed) => {
    const f = bySlug.has(slugifyRef(ed.from))
    const t = bySlug.has(slugifyRef(ed.to))
    if (f === t) return false
    const gone = f ? slugifyRef(ed.to) : slugifyRef(ed.from)
    const why = droppedEnd.get(gone)
    return why !== undefined && !TAINTED.has(why)
  })
  const edgesOf = (slug: string) => edges.filter((ed) => slugifyRef(ed.from) === slug || slugifyRef(ed.to) === slug)
  const halfEdgesOf = (slug: string) => halfEdges.filter((ed) => slugifyRef(ed.from) === slug || slugifyRef(ed.to) === slug)

  // The tier vocabulary is the swarm's; a sweep run has no tiers to report.
  // Prose that explains how to read a field no shipped row carries is the most
  // checkable kind of lie a document can tell, so every tier sentence below is
  // conditional on the export actually having one.
  const tiered = kept.some((e) => e.tier)

  const files: ExportedFile[] = []

  // entities/
  for (const [slug, e] of [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines: string[] = []
    lines.push(
      fm([
        ["name", e.name],
        ["domain", e.domain],
        ["kind", e.kind],
        ["relation", e.relation],
        ["tier", e.tier],
        ["segment", segmentOf(e)],
        ["descGrounded", e.descGrounded],
      ]),
    )
    lines.push(`# ${e.name}\n`)
    if (e.what) lines.push(`${e.what}\n`)
    const lane = e.foundBy?.length
      ? `surfaced by the ${e.foundBy[0]} lane's de-branded queries`
      : `surfaced by this run's queries`
    const judged = e.tier ? ` → judged ${e.tier}` : ""
    lines.push(`**Route:** ${lane}${judged} → ${e.relation} to ${anchor}.\n`)
    // The literal queries that surfaced this host — layer zero of the graph,
    // and the one line that asks a reader to trust nothing: text was typed,
    // this host came back. Absent on maps stored before the field existed.
    if (e.roads?.length) lines.push(`**Found by:** ${e.roads.map((q) => `\`${q}\``).join(" · ")}\n`)
    if (e.why) lines.push(`**Why it's on the map:** ${e.why}\n`)
    if (e.because) lines.push(`**Downgraded:** ${e.because}\n`)
    if (e.spans?.length) {
      /**
       * SAY WHICH TEXT THIS IS QUOTED FROM, because for one row in eight it
       * was not the page.
       *
       * A host whose front page would not open is judged from the titles and
       * descriptions of the search results that surfaced it, and its spans are
       * verified against THAT text. The header said "verbatim from its page
       * this run" regardless, on notes whose own `Downgraded:` line two lines
       * above said the front page could not be read. The artifact contradicted
       * itself, and in the direction that overstates provenance.
       *
       * MEASURED on two exports:
       *
       *   shopify     165 of 1,215 kept rows carried spans with an unreadable
       *               page — 131 judged from the search results, 34 rescued by
       *               a second look
       *   cloudflare  143 of 1,182
       *
       * The 34 are not the problem: a second look fetches a real page and its
       * quotes are page quotes, just not the front door's. The 131 are, and
       * they are 11% of the map.
       *
       * Read off `because`, which the judge already writes precisely enough to
       * tell the three cases apart — no new field, and a map exported before
       * this reads exactly as it did.
       */
      lines.push(`**Receipts** (verbatim from ${receiptSource(e.because)}):\n`)
      for (const s of e.spans) lines.push(`> ${s}\n`)
    }
    if (e.also?.length) {
      lines.push(`**Also recorded here:** ${e.also.map((a) => (a.name ? `${a.name} — ${a.what}` : a.what)).join("; ")}\n`)
    }
    const myEdges = edgesOf(slug)
    const myHalf = halfEdgesOf(slug)
    if (myEdges.length || myHalf.length) {
      lines.push(`**Edges:**\n`)
      for (const ed of myEdges) {
        const other = slugifyRef(ed.from) === slug ? ed.to : ed.from
        const dashed = ed.confidence === "inferred" ? " *(inferred)*" : ""
        lines.push(`- ${ed.relation} [[${slugifyRef(other)}]]${dashed}`)
      }
      // The half-edges: the other end was gated out of this export, and the
      // relation is still a recorded finding. Plain text, no wikilink — a
      // link to a page that does not exist is exactly what the induced cut
      // exists to prevent — wearing the label that says why the end is gone.
      for (const ed of myHalf) {
        const otherHost = slugifyRef(ed.from) === slug ? ed.to : ed.from
        const why = droppedEnd.get(slugifyRef(otherHost))
        const label = why ? DROP_LABEL[why] : "not exported"
        lines.push(`- ${ed.relation} ${otherHost} *(not a page here: ${label})*`)
      }
      lines.push("")
    }
    files.push({ path: `entities/${slug}.md`, content: lines.join("\n") })
  }

  // relations/
  const byRelation = new Map<string, ExportEntity[]>()
  for (const e of kept) {
    const list = byRelation.get(e.relation) ?? []
    list.push(e)
    byRelation.set(e.relation, list)
  }
  for (const [rel, list] of [...byRelation.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...list].sort(tierSort)
    /**
     * ONE EXPLANATION AT THE TOP, NOT ON EVERY ROW.
     *
     * `relations/unknown.md` is the file the README sends a reader to for
     * "what the run refused to guess", and the snippet gate grew it from
     * roughly ten rows to a hundred. Every one of those hundred ended with the
     * same thirty words — "a call that the host's own page bears out less than
     * 80% of the time, so the relation is withheld rather than guessed" — so
     * the file became 90% one repeated sentence, and the two things that
     * actually differ per row (which relation was withheld, and how the page
     * failed) were buried in the middle of it.
     *
     * The shared tail is lifted to a line under the heading and stripped from
     * the rows that carry it. Computed rather than hardcoded: the longest
     * common suffix beginning at a sentence break, taken only when it is long
     * enough to be worth hoisting and shared by more than half the rows. A
     * future `because` phrasing needs no change here, and a list whose rows
     * genuinely differ keeps every word where it was.
     */
    const becauses = sorted.map((e) => (e.relation === "unknown" ? (e.because ?? "") : "")).filter(Boolean)
    let shared = ""
    if (becauses.length > 2) {
      let cand = becauses[0]!
      for (const b of becauses) {
        let i = 0
        while (i < cand.length && i < b.length && cand[cand.length - 1 - i] === b[b.length - 1 - i]) i += 1
        cand = cand.slice(cand.length - i)
      }
      // Trim to a clean sentence start so the hoisted line reads as prose.
      const cut = cand.search(/[a-z(]/)
      const trimmed = cut > 0 ? cand.slice(cut) : cand
      const carriers = becauses.filter((b) => b.endsWith(trimmed)).length
      if (trimmed.length >= 40 && carriers > becauses.length / 2) shared = trimmed
    }
    const rows = sorted.map((e) => {
      const raw = e.relation === "unknown" && e.because ? e.because : ""
      const own = shared && raw.endsWith(shared) ? raw.slice(0, raw.length - shared.length).replace(/[\s—–-]+$/, "") : raw
      const extra = own ? ` — ${own}` : ""
      return `- [[${slugOf(e)}]]${e.tier ? ` (${e.tier})` : ""}${extra}`
    })
    const order = tiered
      ? "Ordered by evidence tier, strongest first."
      : "Ordered by how many distinct queries surfaced each host, most first."
    const head =
      rel === "unknown"
        ? `# unknown\n\nThese are refusals, not absences: each claim failed an evidence bar and\nwears the reason. Resolving one means fetching better evidence, not deleting\nthe row.\n${shared ? `\nMost of these share one reason: ${shared}\n` : ""}`
        : `# ${rel}\n\n${order}\n`
    files.push({ path: `relations/${rel}.md`, content: `${head}\n${rows.join("\n")}\n` })
  }

  // segments/
  const bySegment = new Map<string, ExportEntity[]>()
  for (const e of kept) {
    const seg = segmentOf(e)
    const list = bySegment.get(seg) ?? []
    list.push(e)
    bySegment.set(seg, list)
  }
  for (const [seg, list] of [...bySegment.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const straddlers = list.filter((e) => (e.foundBy?.length ?? 0) > 1)
    const rows = [...list].sort(tierSort).map((e) => {
      const lanes = (e.foundBy?.length ?? 0) > 1 ? ` *(also: ${e.foundBy!.slice(1).join(", ")})*` : ""
      return `- [[${slugOf(e)}]] — ${e.relation}${lanes}`
    })
    const slug = seg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unattributed"
    /**
     * THE SHAPE BEFORE THE SCROLL. Every map has one lane holding a third to
     * two thirds of it — measured at 43% on shopify, 37% cloudflare, 33%
     * openai and 60% on stripe, whose payments lane is 672 rows. That is not a
     * defect, it is what a company's ecosystem looks like, but "N entities, M
     * straddling" tells a reader nothing about a file that long.
     *
     * The relation split is the one cut this file does not already carry —
     * rows are ordered by corroboration and labelled with their relation, so
     * the counts are derivable by scrolling all 672 of them and by no other
     * means. One line makes "mostly adjacent, ninety-six rivals" readable at
     * the top.
     */
    const segCounts = new Map<string, number>()
    for (const e of list) segCounts.set(e.relation, (segCounts.get(e.relation) ?? 0) + 1)
    const split = [...segCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([r, n]) => `${r} ${n}`)
      .join(" · ")
    files.push({
      path: `segments/${slug}.md`,
      content: `# ${seg}\n\n${list.length} entities, ${straddlers.length} straddling other segments.\n\n${split}.\n\n${rows.join("\n")}\n`,
    })
  }

  // NO evidence/receipts.md.
  //
  // It used to exist and it was every span in the run concatenated into one
  // file — 484 quotes, 47KB, on the clerk.com export. Not one of those quotes
  // was unique to it: the same span is already blockquoted on the entity's own
  // page, from this same array, so the file carried zero information and
  // nothing in the vault linked to it. What it did carry was the only thing in
  // the folder shaped like a scrape dump rather than a citation — third-party
  // page copy in bulk, detached from any claim it supports.
  //
  // "Every claim carries its receipt" is the promise, and a quote sitting
  // beside the sentence it grounds keeps it better than a corpus does. Removing
  // this file resolves no citation less: `grep -r` over entities/ is the index
  // it was pretending to be.

  // README.md
  const rep = run.report
  const usd = rep?.usd ?? run.stats?.usd
  const seconds = rep?.seconds ?? run.stats?.seconds
  const counts = new Map<string, number>()
  for (const e of kept) counts.set(e.relation, (counts.get(e.relation) ?? 0) + 1)
  const countLine = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ")
  const gate = rep?.scorecard?.gate
  const health: string[] = []
  if (usd !== undefined) health.push(`- Cost: $${usd.toFixed(2)}${seconds ? ` over ${Math.round(seconds)}s` : ""}`)
  /**
   * NOT A COMPLETENESS SCORE, and it was printed as if it were one.
   *
   * "Answer-key recall: 0.14" beside "1106 entities" reads as "86% of the
   * market is missing". It is not that. The answer key is every outbound host
   * on the pages that named the anchor, and a large share of those are the
   * links every website has. Measured on the probes of two runs:
   *
   *   shopify      645 entries,   42% match a CDN or social pattern
   *   cloudflare  2230 entries,   29%
   *
   * The most common entries are facebook.com, linkedin.com, youtube.com,
   * instagram.com, twitter.com, googleapis.com and gstatic.com — footers,
   * not competitors — and the pattern that found them is conservative, so
   * those shares are floors.
   *
   * A market map correctly leaves all of that out, which caps this number far
   * below 1 no matter how good the map is. It moves with which probe pages a
   * run happened to collect: shopify read 0.22-0.29 across seven runs and
   * 0.14 on the eighth, while cloudflare went 0.13 to 0.18 over the same
   * changes. Up on one anchor, down on the other, same engine.
   *
   * So it is worth keeping and worth labelling. What it IS good for is
   * comparing runs of the SAME anchor with the same probes, which is what
   * scripts/recall.ts does deliberately against a hand-written field.
   */
  if (rep?.recall?.pooled != null)
    health.push(
      `- Answer-key overlap: ${(rep.recall.pooled as number).toFixed(2)} over ${rep.recall.probes?.length ?? 0} probe page(s)` +
        ` — the share of hosts linked from pages naming the anchor that are also on this map.` +
        ` A third to a half of those links are footers (facebook, linkedin, googleapis), which a market map leaves out on purpose,` +
        ` so this is not a completeness score and is only comparable between runs of the same anchor.`,
    )
  if (rep?.recall?.aliasExclusion?.note) health.push(`- ${rep.recall.aliasExclusion.note}`)
  if (gate?.refusals) health.push(`- The finish gate refused ${gate.refusals} time(s); the objections are preserved below.`)
  if (rep?.ending?.humanReason) health.push(`- Ending: ${rep.ending.humanReason}`)
  // The gated hosts are counted, never named. A map that reports its own blind
  // spot in aggregate is more honest than one that publishes a page per host
  // saying that host blocked us — and it accuses nobody.
  const dropTotal = [...dropped.values()].reduce((a, b) => a + b, 0)
  if (dropTotal) {
    const byLabel = new Map<string, number>()
    for (const [why, n] of dropped) byLabel.set(DROP_LABEL[why], (byLabel.get(DROP_LABEL[why]) ?? 0) + n)
    const breakdown = [...byLabel.entries()].sort(([, a], [, b]) => b - a).map(([l, n]) => `${n} ${l}`)
    health.push(`- ${dropTotal} host(s) surfaced and did not make the map: ${breakdown.join(" · ")}.`)
  }
  const gateBlock = gate?.refusals
    ? `\n## The gate exchange\n\n${(gate.objections ?? []).map((o) => `> ${o}`).join("\n")}\n`
    : ""
  // Only offer a door that exists: a run with no competitors writes no
  // relations/competitor.md, and a link to it would be the map's first lie.
  const relFile = (rel: string) => (byRelation.has(rel) ? `relations/${rel}.md` : null)
  const starts = [
    relFile("competitor") && `- [${relFile("competitor")}](${relFile("competitor")}) — the rivals${tiered ? ", strongest evidence first" : ""}`,
    `- [segments/](segments/) — the market's structure, from provenance`,
    relFile("unknown") && `- [${relFile("unknown")}](${relFile("unknown")}) — what the run refused to guess`,
    `- [AGENTS.md](AGENTS.md) — how to read this folder honestly`,
  ].filter(Boolean)
  files.push({
    path: "README.md",
    content: `# ${anchor} — market map\n\n${run.decomposition?.sells ? `${run.decomposition.sells}\n\n` : ""}${kept.length} entities: ${countLine}.\n\n## Run health\n\n${health.join("\n") || "_No report block on this run._"}\n${gateBlock}\n## Where to start\n\n${starts.join("\n")}\n`,
  })

  // AGENTS.md
  const agentRules = [
    tiered &&
      `- **tier** is where the evidence came from: \`own-page\` (the entity's own site,
  fetched this run) > \`page\` (some page fetched this run) > \`snippet\` (a search
  result). Trust claims in that order.`,
    byRelation.has("unknown") &&
      `- **relation: unknown is a refusal, not an absence.** The run had a claim and
  refused it for the stated reason (\`because\`). Do not read unknown as "not a
  competitor"; read it as "not proven this run".`,
    `- **A why is evidence for the relation**, never a restatement of what the
  entity is. If a why reads hollow, check the receipts.`,
    `- **Receipts are literal quotes** from the entity's fetched page, blockquoted
  on the entity's own note beside the claim they ground. They prove provenance,
  not support — descGrounded (0..1) meters how much of the description's
  vocabulary the page actually contains, and it is a relative drift meter, not
  a truth score.`,
    `- **Wikilinks are the graph.** Walk entity → edges → entity; segments/ groups
  by the provenance lane that surfaced each entity; straddlers legitimately
  appear between segments.`,
    `- **This is the map, not the crawl.** Hosts the run read and placed in no
  relation to ${anchor}, could not read at all, or found only publishing near
  the market are counted in the README's run health and are not given pages.
  An absent host is not a judgement about that host.`,
  ].filter(Boolean)
  files.push({
    path: "AGENTS.md",
    content: `# How to use this knowledge base

This folder is a build artifact of one mapping run. Regenerate it from the run
file; never hand-edit — a correction belongs upstream in the engine.

Reading rules, in the map's own vocabulary:

${agentRules.join("\n")}
`,
  })

  // SKILL.md — the agent door: consumption recipes in the vocabulary the
  // knowledge-base MCP already chose (battlecard, ecosystem, coverage), as
  // plain file operations so any agent that can read files can walk the map.
  const competitorCount = counts.get("competitor") ?? 0
  const unknownCount = counts.get("unknown") ?? 0
  const battlecard = competitorCount
    ? `**Battlecard (top rivals):** read \`relations/competitor.md\`${tiered ? ", already ordered by evidence tier,\nstrongest first" : ""}.
For each rival open \`entities/<key>.md\`: the *what* is the pitch, the *why* is the
evidence for the rivalry, the receipts are quotable verbatim. ${competitorCount} competitors here.`
    : `**Battlecard (top rivals):** this run placed no entity as a competitor. \`relations/\`
holds the relations it did find.`
  const whyOnMap = `**Why is X on this map:** open \`entities/<key>.md\` — the *route* line says which market
lane surfaced it and how it stands to ${anchor}; the edges are wikilinks you can follow;
the receipts are the proof.${
    unknownCount
      ? ` If the relation is \`unknown\`, the *because* is the refusal —
treat it as "not proven", never "not a competitor". ${unknownCount} refusals here.`
      : ""
  }`
  // Name only the relation files this run actually wrote; `relations/buyer.md`
  // was advertised here for every export and existed in almost none of them.
  const audience = ["buyer", "discusses"].filter((r) => byRelation.has(r))
  const whoBuys = audience.length
    ? `\n\n**Who buys / where they argue:** ${audience.map((r) => `\`relations/${r}.md\``).join(" and ")} →
the community entities.`
    : ""
  const grepFields = ["relation:", tiered && "tier:", "segment:"].filter(Boolean).map((f) => `\`${f}\``).join(", ")
  const trustRules = [
    tiered && `- Trust by **tier**: own-page > page > snippet. A tier is where the evidence came from.`,
    /**
     * BOTH OF THESE WERE MADE FALSE BY FIXES ON THIS BRANCH, which is exactly
     * the rot a file of "trust rules" can least afford — a reader who follows
     * them is being told to distrust the right things and trust the wrong ones.
     *
     * The receipts rule was the third copy of the claim `receiptSource` exists
     * to stop: a quote is verbatim from the text the model read, and for about
     * one row in eight that text was the search results rather than a page.
     * Each note now says which, so this points at the note instead of
     * asserting the page.
     *
     * The ordering rule told a reader the lists are alphabetical and to weight
     * a row by its receipts "not its position". They were, until relation
     * lists learned to sort by how many queries surfaced each host — so the
     * rule now instructs a reader to ignore the only ranking the file has.
     */
    `- **Receipts prove provenance, not support**: each note says which text its quotes
  are verbatim from — its own page, the page a second look reached, or the search results
  that surfaced it when the page would not open. That they SUPPORT the description is the
  model's claim, metered by \`descGrounded\` (a relative drift meter — 0.68 is a normal
  honest score, not 68% true).`,
    tiered
      ? `- The head of each relation list is solid; treat the snippet-tier tail as leads to check.`
      : `- The relation lists are ordered by how many distinct queries surfaced each host, most
  first, so the head of each list is what this market points at hardest. That is corroboration,
  not correctness: weight a row by its receipts too, never by its position alone.`,
    `- Never repeat a *why* about an unfamiliar entity as established fact — quote its receipt
  or go fetch its page.`,
  ].filter(Boolean)
  files.push({
    path: "SKILL.md",
    content: `---
name: kb-${anchor.replace(/\W+/g, "-")}
description: Walk the ${anchor} market map — competitors, substitutes, segments, buyers and the evidence behind every claim. Use when asked who competes with ${anchor}, for a battlecard, an ecosystem overview, why an entity is on this map, or how much of it to trust. Every answer should carry the note's receipts.
---

# Swimming in this map

${kept.length} entities around **${anchor}**${run.decomposition?.sells ? ` (${run.decomposition.sells.replace(/\.$/, "").toLowerCase()})` : ""}, every one carrying its evidence. You never need the app that built this — the files are the database.

## Recipes

${battlecard}

**Ecosystem overview:** read \`README.md\` then every file in \`segments/\` — the market's
structure from provenance, with straddlers marked (entities legitimately in two segments
are often the most strategically interesting).

${whyOnMap}${whoBuys}

**Search:** grep \`entities/\` frontmatter (${grepFields}) — it is the
index. \`manifest.json\` has every key for programmatic access.

## Trust rules (measured, not disclaimers)

${trustRules.join("\n")}
`,
  })

  // llms.txt — the product is built on reading these; its own export speaks one.
  const llmsRows = [
    `- [README.md](README.md): the map at a glance and run health`,
    `- [SKILL.md](SKILL.md): recipes for walking this map as an agent`,
    `- [AGENTS.md](AGENTS.md): the honesty rules`,
    relFile("competitor") && `- [${relFile("competitor")}](${relFile("competitor")}): the rivals${tiered ? ", by evidence tier" : ""}`,
    `- [manifest.json](manifest.json): programmatic index`,
  ].filter(Boolean)
  /**
   * "N entities with cited relations" COUNTED THE REFUSALS TOO.
   *
   * An `unknown` row is this export's word for "the run would not say" — the
   * relation was withheld and the `why` deliberately blanked, which is why
   * relations/unknown.md opens "these are refusals, not absences". On a real
   * shopify export 103 of the 1,106 rows were that, and 115 of the 116
   * `unknown` rows in the underlying run carry no `why` at all.
   *
   * So the summary line the agent reads first overstated the cited half by
   * about 9%, using this file's own vocabulary against itself. Split, because
   * both numbers are worth having and the second is the one this codebase
   * keeps insisting on: a reader can finish an unknown and cannot correct an
   * invention.
   */
  const refused = kept.filter((e) => e.relation === "unknown").length
  const cited = kept.length - refused
  files.push({
    path: "llms.txt",
    content:
      `# ${anchor} market map\n\n> ${kept.length} entities: ${cited} with cited${tiered ? ", evidence-tiered" : ""} relations to ${anchor}` +
      `${refused ? `, and ${refused} the run refused to place` : ""}. ${countLine}.\n\n${llmsRows.join("\n")}\n`,
  })

  // manifest.json
  const manifest = {
    anchor,
    /**
     * KEYED ORDER, RANKING CARRIED AS DATA.
     *
     * The rows stay sorted by key so a diff between two manifests is readable
     * and a consumer can bisect. What was missing is the ranking itself:
     * relation lists learned to sort by `seenIn` (see `tierSort`), SKILL.md
     * now tells a reader "the head of each list is what this market points at
     * hardest", and an agent following that same file to `manifest.json` for
     * "programmatic access" had no way to reproduce it. Two documented paths
     * into one map, giving different answers about which rivals matter.
     *
     * Emitted only where the run recorded it, so a map exported without
     * `seenIn` keeps exactly the shape it had. `tier` stays even though every
     * sweep row is null — it is the swarm's field and a swarm export means it.
     */
    entities: [...bySlug.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, e]) => ({
        key: slug,
        path: `entities/${slug}.md`,
        name: e.name,
        relation: e.relation,
        tier: e.tier ?? null,
        ...(typeof e.seenIn === "number" ? { seenIn: e.seenIn } : {}),
      })),
    files: [...files.map((f) => f.path), "manifest.json"].sort(),
  }
  files.push({ path: "manifest.json", content: JSON.stringify(manifest, null, 2) + "\n" })

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

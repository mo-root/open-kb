import { sniff, condense, type UnreadableReason } from "./sniff.js"
import { admit, outboundHosts, type JudgedPage } from "./verdict.js"
import { registrableHost } from "./url.js"
import { namesHost } from "./coverage.js"
import { descriptionGrounding } from "./grounding.js"
import { checkQuote } from "./evidence.js"
import type { FetchPort } from "./ports.js"

/**
 * The kernel's bulk primitive: judge every candidate host from its own front
 * page. Moved here from packages/sweep/src/rank.ts so the swarm can hold the
 * same primitive without depending on the sweep — it was already purity-clean
 * (core modules plus a FetchPort and an injected classify; no HTTP, no vendor,
 * no env), so the move is a change of address, not of behaviour. The sweep
 * re-exports it from its old path; both engines now judge with one implementation.
 */

/**
 * The judge's answer vocabulary — what a classify closure may say a host IS
 * and how it stands to the anchor. The doctrine file
 * (prompts/agents/classify.md) teaches exactly these words; the sweep's
 * reader-facing schema (sweep.ts ENTITY_KINDS / RELATIONS) carries the same
 * sets at its own call site. Exported so any caller building a classify
 * closure for judgeHosts enums the doctrine's vocabulary instead of retyping
 * it.
 */
export const JUDGED_KINDS = [
  "company",
  "product",
  "community",
  "publisher",
  "directory",
  "noise",
  "unknown",
] as const

export const JUDGED_RELATIONS = [
  "competitor",
  "substitute",
  // Mirrors packages/sweep/src/sweep.ts's RELATIONS — the reason two copies
  // of this vocabulary exist is core cannot import from sweep, and the
  // swarm's harvest-classify schema (packages/swarm/src/agent.ts) binds to
  // this one.
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
] as const

export interface HostCandidate {
  host: string
  seenIn: number
  intents: string[]
  titles: string[]
  desc: string
  /** The highest-ranked hit URL for this host, when the caller has one. An
   *  aggregator's ranked page is a better answer key than its front page. */
  topHit?: string
  /** The road the host arrived by, pre-rendered by the caller: up to three of
   *  the surfacing queries, each with its family, market and platform. The
   *  judge weighs it beside the page — a host that walked in through this
   *  market's queries usually has a stake in this market. */
  foundBy?: string
}

export interface Judged {
  name: string
  domain: string
  kind: string
  what: string
  relation: string
  why: string
  /** Present only on downgraded claims: the refusal, as a sentence. */
  because?: string
  /** Present only on unreadable hosts: WHY the front page could not be read,
   *  as the sniffer's stable code. The sentence in `because` is for the
   *  reader; this is for arithmetic — it is what turns "127 unreadable" (a
   *  bug report) into "61 bot-walled, 40 JS-only, 26 parked" (a finding). */
  unreadableReason?: UnreadableReason
  settledBy: "predicate" | "model"
  /** Present only on model-judged entities: what fraction of the content terms
   *  in the what THE MODEL WROTE the page it saw actually contains, 2 decimals.
   *  The span check below is the gate now; this stays as the regression canary,
   *  and it meters the model's own prose even when the fallback replaced it. */
  descGrounded?: number
  /** Present only on model-judged entities: the span ledger. Of the verbatim
   *  page quotes the model claimed back its `what`, how many were literal
   *  substrings of the exact page text it saw — checked by code (the evidence
   *  mint's own containment), never by another model. A what with zero
   *  verified spans does not reach the reader. */
  descSpans?: { verified: number; claimed: number }
  /** The verified quotes themselves — receipts a reader can hold against the
   *  page. Whole spans, in the model's order, total capped at SPAN_BUDGET
   *  chars. Absent when nothing verified. */
  spans?: string[]
}

/** The receipts' storage cap. Spans are output tokens at six times the input
 *  price and ride every entity into the run JSON, so they stay small: three
 *  short quotes, not a transcript. */
const SPAN_BUDGET = 360

export interface KernelStats {
  fetched: number
  unreadable: number
  /** The `unreadable` count above split by the sniffer's reason codes; the
   *  values sum to `unreadable`. Empty object when nothing was unreadable —
   *  an absent split and a clean run must not look alike in a stored report. */
  unreadableByReason: Partial<Record<UnreadableReason, number>>
  aggregators: number
  modelJudged: number
  settledFree: number
  /** Unlocker escalations spent on blocked-but-corroborated front pages. */
  unlocked: number
  /** Hosts judged from their SERP presence because no page could be read. */
  serpJudged: number
  /** Running mean of descGrounded across model-judged entities, 2 decimals.
   *  Null until the first model judgement lands — a run that judged nothing
   *  has no groundedness to report, and 0 would read as "everything invented". */
  groundingMean: number | null
}

export interface JudgeDeps {
  fetcher: FetchPort
  classify: (h: HostCandidate, pageText: string) => Promise<{ name: string; kind: string; what: string; relation: string; why: string; spans: string[] }>
  anchor: string
  aggregatorThreshold: number | null
  /**
   * The corroboration bar for spending an unlocker call on a blocked front
   * page: a host seen in at least this many distinct queries earns one
   * unlocked retry (~$0.008, ~15s) before it is settled as unreadable.
   * Measured: 17% of one fresh map's rows were blank nodes, 14 of them
   * corroborated at this bar — $0.11 to judge a seventh of the map. Unset or
   * 0 disables, which keeps every existing caller byte-identical.
   */
  unlockSeenIn?: number
  concurrency?: number
  signal?: AbortSignal
  /**
   * Asked before each host, and a `true` ENDS THE POOL WITH WHAT IT HAS.
   *
   * Not an abort. `signal` says the run is over and everything in flight is
   * waste; this says the run is nearly out of clock and the hosts already
   * judged are worth more finished than the whole list is worth killed. The
   * caller gets a short `entities` list and the honest arithmetic to report it
   * — `hosts.length` minus what came back is exactly what the clock cost.
   *
   * Left unset by every caller that has no deadline (the CLI, the swarm), and
   * then this is the same unconditional loop it always was.
   */
  stop?: () => boolean
  onFetch?: (url: string, ok: boolean, ms: number) => void
  onJudged?: (e: Judged) => void
}

/**
 * Judge every candidate host from its own front page, streamed: each host is
 * settled the instant its page lands, in a bounded pool. Predicates first —
 * an aggregator-shaped page and an unreadable one are decided by arithmetic
 * for $0 — and a model call only on the residue, one host at a time, so the
 * model never gets within-prompt contrast to lean on.
 */
/**
 * The anchor's own brand, as a string two spellings of it both reduce to.
 *
 * Only ever compared against a name the model wrote, so it has to survive the
 * ways a brand is written down: "Figma", "figma", "FIGMA". Punctuation goes
 * for the same reason — "e-gain" and "eGain" are one identity.
 */
const identityKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "")

/** Either identity key contains the other — the one containment test this
 *  file runs on every label pair, named once instead of repeated inline. */
const relates = (a: string, b: string): boolean => a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a))

/**
 * Registrable domains where the entity a model names can legitimately live in
 * the host's own leftmost label rather than the domain's — a small, named
 * exception, not a PSL. MEASURED on one cursor.com run, all three withdrawn
 * by the plain registrable-label check before this list existed:
 *   - github.io  (tree-sitter.github.io is tree-sitter's own docs; "github"
 *                 is the platform's label, not the tenant's)
 *   - medium.com (martinterhaak.medium.com is a legitimate personal-blog
 *                 author page on a multi-tenant publishing platform)
 *   - google.com (firebase.google.com is Firebase's own home; "google" is
 *                 the parent's label, not the product the model named)
 * sendgrid.kke.co.jp is deliberately NOT on this list: kke.co.jp is a
 * reseller's own domain, not a platform, and its leftmost label ("sendgrid")
 * matches the name exactly the same way tree-sitter's does — gating on this
 * list (rather than comparing the leftmost label unconditionally) is what
 * keeps that case withdrawn. Extend only on a measured miss.
 */
const SUBDOMAIN_IDENTITY_HOSTS = new Set(["github.io", "medium.com", "google.com"])

/**
 * A trailing generic suffix stripped from the WRITTEN NAME ONLY, for a
 * second, LAXER comparison pass against the UNSTRIPPED registrable/host
 * label — never replacing the strict one, only added beside it. MEASURED:
 * getpanto.ai (registrable label "getpanto", model wrote "Panto AI") defeats
 * plain substring matching because the written name wears a generic suffix
 * the domain doesn't; stripping it ("pantoai" -> "panto") lets containment
 * find it inside "getpanto" on its own — a domain wearing a vanity PREFIX
 * needs no separate correction, because containment already looks for the
 * shorter string anywhere inside the longer one.
 *
 * ONE-SIDED ON PURPOSE. A prior version of this pass also stripped a leading
 * vanity prefix (get/try/use/my) from BOTH the name and the domain label
 * independently, which fixed trypear.ai but MEASURABLY introduced a false
 * negative an adversarial review caught by execution: wrongDoorName(
 * "TryHackMe", "tryhackme.hackmehq.com") returned false, because "try" and
 * "hq" strip off two UNRELATED strings ("tryhackme", "hackmehq") down to the
 * same accidental remainder ("hackme") — two brands neither of which is the
 * other, forgiven on a coincidence of vanity spelling. Stripping only the
 * name and comparing against the domain's label UNCHANGED cannot manufacture
 * that kind of two-sided collision, and still resolves trypear.ai: containment
 * of the stripped name ("pear") inside the untouched label ("trypear") holds
 * exactly because containment does not care what sits in front of a match.
 */
const VANITY_SUFFIXES = ["ai", "app", "io", "hq", "labs", "inc"]

/** The suffix off the top, only if the key is longer than it — stripping a
 *  key down to its own suffix would turn every short label into an
 *  empty-string match against everything. */
const stripVanitySuffix = (key: string): string => {
  const suffix = VANITY_SUFFIXES.find((suf) => key.length > suf.length && key.endsWith(suf))
  return suffix ? key.slice(0, -suffix.length) : key
}

/**
 * True when a judged name's home is a different registrable domain — the
 * brand spelled in a subdomain of someone else's site ("SendGrid" on
 * sendgrid.kke.co.jp). Binding it would drag every mention of the brand
 * onto a reseller's door while the brand's own domain never enters the
 * map. Shared by the page path and the SERP-text path: a wrong door is a
 * wrong door whichever text the model read.
 *
 * Two corrections layered on top of the original registrable-label check,
 * both MEASURED as false-positive fixes on one cursor.com run (5 of 6 real
 * entities silently withdrawn before either existed): subdomain-label
 * awareness (SUBDOMAIN_IDENTITY_HOSTS, above) and a name-side vanity-suffix
 * strip (stripVanitySuffix, above). Neither replaces the strict check that
 * follows — each only adds a further reason to stand down.
 *
 * EXPORTED as the one implementation of this withdrawal, because a second
 * judgement path (the sweep's second look) once re-admitted exactly the
 * verdicts these guards withdraw — a name rule restated is a name rule that
 * can drift, so any path that accepts a model-written name asks this one.
 */
export function wrongDoorName(name: string, host: string): boolean {
  const nameKey = identityKey(name)
  if (nameKey.length < 3) return false

  const reg = registrableHost(host)
  const regLabel = identityKey(reg.split(".")[0] ?? "")
  const hostKey = identityKey(host)
  // The name has to show up in the host SOMEWHERE, or there is nothing to
  // withdraw — a name unrelated to the host entirely is a different verdict.
  if (!hostKey.includes(nameKey)) return false
  // Strict pass, unchanged from before either correction: the name is the
  // registrable domain's own brand.
  if (relates(regLabel, nameKey)) return false

  // Correction 1 — subdomain-label awareness. Gated to
  // SUBDOMAIN_IDENTITY_HOSTS: see that constant's comment for why an
  // ungated comparison here would also forgive sendgrid.kke.co.jp.
  const onPlatform = SUBDOMAIN_IDENTITY_HOSTS.has(reg)
  const hostLabel = onPlatform ? identityKey(host.split(".")[0] ?? "") : ""
  if (onPlatform && relates(hostLabel, nameKey)) return false

  // Correction 2 — strip a generic suffix off the NAME only, compare
  // against the domain's label UNCHANGED. See stripVanitySuffix's comment
  // for why the domain side is never stripped: doing so on both sides at
  // once is how two unrelated brands collided on a shared remainder.
  const laxName = stripVanitySuffix(nameKey)
  if (laxName.length >= 3 && relates(regLabel, laxName)) return false
  if (onPlatform && relates(hostLabel, laxName)) return false

  return true
}

/**
 * True when the model answered with the ANCHOR's identity for a host that is
 * not the anchor — the verdict judgeHosts withdraws whole, because a model
 * that returned the wrong subject was not describing this page. Same export
 * rationale as `wrongDoorName`: one implementation, asked by every path.
 */
export function anchorIdentityTheft(name: string, host: string, anchor: string): boolean {
  const anchorKey = registrableHost(anchor)
  const anchorLabel = identityKey(anchorKey.split(".")[0] ?? "")
  return (
    // A one- or two-letter anchor label ("x.com") would match names that have
    // nothing to do with it, so the rule declines to fire rather than rename
    // real entities on a coincidence.
    anchorLabel.length >= 3 &&
    registrableHost(host) !== anchorKey &&
    identityKey(name) === anchorLabel
  )
}

/**
 * Cap a verified-span list to the stored-receipt budget: whole spans while
 * they fit; a first span longer than the whole budget is cut to it — a prefix
 * of a literal substring is still a literal substring. Exported so the second
 * look stores receipts under the same budget the judge does.
 */
export function capReceipts(verified: readonly string[]): string[] {
  const receipts: string[] = []
  let receiptChars = 0
  for (const sp of verified) {
    if (receiptChars + sp.length > SPAN_BUDGET) {
      if (receipts.length === 0) receipts.push(sp.slice(0, SPAN_BUDGET))
      break
    }
    receipts.push(sp)
    receiptChars += sp.length
  }
  return receipts
}

export async function judgeHosts(hosts: HostCandidate[], deps: JudgeDeps) {
  const threshold = deps.aggregatorThreshold
  const entities: Judged[] = []
  const probePages: Array<{ url: string; html: string }> = []
  const stats: KernelStats = { fetched: 0, unreadable: 0, unreadableByReason: {}, aggregators: 0, modelJudged: 0, settledFree: 0, unlocked: 0, serpJudged: 0, groundingMean: null }
  const countDeadEnd = (reason: UnreadableReason) => {
    stats.unreadable += 1
    stats.unreadableByReason[reason] = (stats.unreadableByReason[reason] ?? 0) + 1
  }
  const anchorKey = registrableHost(deps.anchor)
  const queue = [...hosts]

  // The running mean's raw ingredients — the mean itself is stored rounded,
  // and rounding the addends before averaging would drift it.
  let groundingSum = 0
  let groundingN = 0

  const emit = (e: Judged) => {
    entities.push(e)
    deps.onJudged?.(e)
  }

  const wrongDoor = wrongDoorName

  const judgeOne = async (h: HostCandidate): Promise<void> => {
    const url = `https://${h.host}/`
    const started = Date.now()
    let raw: Awaited<ReturnType<FetchPort["get"]>>
    try {
      raw = await deps.fetcher.get(url, "direct", { signal: deps.signal })
    } catch (err) {
      // An abort must stay an abort: the sweep-level guard turns it into the
      // run's rejection, and settling the host here would let an aborted run
      // hand back a judged map.
      if (deps.signal?.aborted) throw err
      // The contract does not promise never-throw, and one throwing host must
      // not reject the pool and discard every entity already judged. It costs
      // itself: the same downgrade the unreadable branch below hands out.
      stats.fetched += 1
      countDeadEnd("fetch-failed")
      stats.settledFree += 1
      deps.onFetch?.(url, false, Date.now() - started)
      emit({
        name: h.host, domain: h.host, kind: "unknown", what: "",
        relation: "unknown", why: "",
        because: `its front page fetch threw this run (${err instanceof Error ? err.message : String(err)})`,
        // The one code the sniffer can never derive: there was no response to
        // sniff, only the throw this caller is holding.
        unreadableReason: "fetch-failed",
        settledBy: "predicate",
      })
      return
    }
    stats.fetched += 1
    // `let`: the unlocker escalation below may replace the read.
    let s = sniff(raw)
    deps.onFetch?.(url, s.status === "found", raw.ms)

    // An answer key is worth keeping whatever the verdict on the host is —
    // except the anchor's own page, which names the anchor by definition and
    // would let the map grade itself. Boundary-matched, not substring: the
    // substring era counted "radio.com" as naming "io.com". Same semantics
    // as the recall scorer in core's coverage.ts, deliberately — a probe the
    // gate admits is one the scorer will also accept.
    if (raw.body && registrableHost(h.host) !== anchorKey && namesHost(raw.body, anchorKey)) {
      probePages.push({ url, html: raw.body })
    }

    // A blocked page on a corroborated host earns one unlocked retry before
    // anything is settled: the block is the site's judgement of the fetcher,
    // not a fact about the company, and the bar keeps the spend proportional
    // — a host three queries surfaced is worth $0.008, a drive-by is not.
    //
    // 4xx ONLY, NOT `thin-render`, and that is measured rather than assumed.
    // Both were admitted until the escalation was priced on the population
    // that actually receives it — the block-shaped hosts a real shopify run
    // left unplaced, re-fetched through the unlocker:
    //
    //   http-4xx      10 of 11 recovered, every one a usable page
    //   thin-render    2 of 12 recovered, ONE of them usable
    //
    // The two thin-render "successes" say why: pinterest.com at 340 chars
    // and threads.com at 529, both login walls. `thin-render` means the page
    // rendered and had nothing in it, so a better fetcher fetches the same
    // empty page — it is a fact about the page, where a 4xx is a judgement
    // of the fetcher and is exactly what the unlocker exists to overturn.
    //
    // It is not a rounding error either. Over 12 runs across 6 anchors,
    // thin-render is 24% of the eligible population (15-33% per run), so a
    // quarter of every escalation dollar bought an 8% chance of a page. And
    // because both this ladder and the second look's are bounded, that
    // quarter was not merely wasted, it DISPLACED 4xx hosts that convert at
    // 91%. Dropping it spends the same money on better odds.
    if (
      s.status !== "found" &&
      (deps.unlockSeenIn ?? 0) > 0 &&
      h.seenIn >= (deps.unlockSeenIn ?? 0) &&
      /^http-4/.test(s.reason)
    ) {
      try {
        const retried = await deps.fetcher.get(url, "unlocked", { signal: deps.signal })
        stats.unlocked += 1
        const s2 = sniff(retried)
        deps.onFetch?.(url, s2.status === "found", retried.ms)
        if (s2.status === "found") {
          raw = retried
          s = s2
        }
      } catch {
        // The escalation failing settles nothing by itself; the branches
        // below still hold the SERP text and the honest blank.
      }
    }

    if (s.status !== "found") {
      countDeadEnd(s.reason)
      // The run already paid for text about this host: the titles and
      // descriptions of the results that surfaced it. A blank card says
      // "unreadable"; a card judged from its SERP presence says what the
      // market says the host is, wearing the caveat. 61 of one fresh map's
      // 63 blanks carried enough of this text to judge.
      const serpText = [...h.titles, h.desc].filter(Boolean).join(" · ")
      if (serpText.length >= 80) {
        stats.serpJudged += 1
        try {
          const out = await deps.classify(h, serpText)
          if (wrongDoor(out.name ?? "", h.host)) {
            emit({
              name: h.host, domain: h.host, kind: "unknown", what: "",
              relation: "unknown", why: "",
              because: `the page answered as "${out.name}", a brand whose home is not ${registrableHost(h.host)} — the name is withdrawn rather than bound to the wrong door`,
              unreadableReason: s.reason,
              settledBy: "model",
            })
            return
          }
          const verified = out.spans.filter((sp) => checkQuote(serpText, sp) === "ok")
          /**
           * A SNIPPET MAY NAME A VENDOR. IT MAY NOT NAME A PUBLISHER.
           *
           * Judging from search text at all is a deliberate trade — 61 of one
           * map's 63 blanks carried enough of it to say something. What was
           * never checked is WHICH of the things it says hold up. Measured
           * over 217 hosts that were judged from their page in one run and
           * from a snippet in another, the same host both ways:
           *
           *   the snippet claimed a MARKET relation    80% the page agreed
           *   the snippet claimed a CHANNEL relation   48% the page agreed
           *
           * The second is a coin flip, and it is not a symmetric one. Across
           * those hosts the snippet path moved 44 rows from market to channel
           * and 1 the other way, 15 from market to unknown against 1 back —
           * 59 demotions to 2 promotions, 29.5 to 1. Engine drift would move
           * them both ways; this only moves down. The reason is visible once
           * stated: a vendor's blog post ranking for a market term reads,
           * in a search result, exactly like a publication about that market.
           *
           * That was first read as "keep the market half, refuse the channel
           * half", and the band split below replaced it once the same pairing
           * was run per relation instead of per band — the market/channel
           * line turned out to be an artefact of `covers` outvoting everything
           * else in its band. What survives from this paragraph is the
           * PRINCIPLE, not the split: an unreadable host whose relation the
           * evidence will not carry is recorded as `unknown`, because "a
           * reader can finish an unknown, and cannot correct an invention".
           * It shipped 2checkout.com on the stripe map as a publisher writing
           * educational articles; unknown would have been true.
           *
           * UNLOCKING THESE HOSTS INSTEAD was the other candidate and it was
           * costed and dropped. The gate above admits `seenIn >= 3`, which is
           * 10 of shopify.com's 124 block-shaped unreadable hosts — 94 of them
           * have seenIn 1 — so unlocking the rest is roughly $0.99 against a
           * $0.90 run. Widening the gate needs a signal for WHICH ones are
           * worth it, and there isn't one in the data: over 25,000
           * page-judged hosts, the share that turn out to be market entities
           * runs 65%, 63%, 58%, 72% across rank bands 1-3, 4-6, 7-10 and 11+,
           * which is no gradient at all, and seenIn lifts it only from 63% at
           * one query to about 70% at two or more. Nothing here says which
           * blocked host is worth a dollar per hundred, so the money is not
           * spent and the claim is withheld instead.
           *
           * A SIGNAL WAS FOUND LATER, and this paragraph should not be read as
           * saying none exists. What it actually establishes is that RANK and
           * `seenIn` are not signals — which is true and was the right thing to
           * check first, since those are the two the pipeline already had.
           *
           * The one that works is the BLOCK SHAPE, and it separates by 11x.
           * Re-fetching the block-shaped hosts a shopify run left unplaced,
           * through the unlocker (16b8782):
           *
           *   http-4xx      10 of 11 recovered, every one a usable page
           *   thin-render    2 of 12 recovered, ONE of them usable
           *
           * A 4xx is the site's judgement of the fetcher, which is what an
           * unlocker exists to overturn; `thin-render` is a fact about the
           * page, which it cannot. thin-render is 24% of the eligible
           * population across 12 runs, so a quarter of the spend this
           * paragraph priced was buying 8% odds.
           *
           * WHETHER THAT REOPENS THE DECISION IS UNMEASURED. The arithmetic
           * above is for ALL 124 block-shaped hosts at seenIn 1; restricted to
           * 4xx it is roughly three quarters of that, at 91% page recovery
           * rather than the blended rate assumed here — a different trade, and
           * nobody has costed it. The second look spends its escalations this
           * way already and rescues 72-90% of the hosts whose page it gets, so
           * the evidence points at "worth re-costing" rather than at an answer.
           *
           * MEASURED ON THE WIRE, two shopify.com runs either side of it:
           *
           *              snippet rows   channel claims   unknown   kept
           *   before              140               87         4   1100
           *   after               183                9        98   1242
           *
           * And the nine that survive are not snippet guesses. The gate
           * withholds them, which leaves them unplaced, which is what the
           * second look is for — it fetches a search-surfaced page and places
           * them on evidence. thecmo.com comes back `covers` with a real
           * `why` and its `because` carries both halves: the claim withheld
           * and the page that finally answered. So the two stages compose:
           * this refuses to guess, and the next one goes and looks.
           *
           * IT ALSO HANDS THE SECOND LOOK A MUCH BIGGER JOB, which is worth
           * knowing before reading its numbers. The same run went from ~8
           * unplaced hosts to 98, so the stage was asked about 60 of them —
           * its cap — and reported 42 failures where earlier runs reported 1
           * or 2. That is not a regression and it is already anticipated at
           * `SECOND_LOOK_CAP`: the population it now sees is precisely the
           * hosts whose page would not open, and "about half of a real run's
           * second looks landed on a page that was ALSO walled". When it does
           * get a page it usually places the host, so the failures are the
           * fetch and not the judgement.
           *
           * "Every time — 11 of 11 on that run" is what this said, and five
           * later runs put it lower — rescued against looks that got a page:
           *
           *   13/18  72%     15/20  75%     24/28  86%
           *   36/40  90%     38/44  86%     (the last is cloudflare)
           *
           * 72% to 90%, not 100%. One run of eleven was too small to carry the
           * word "every", and the sentence it supported never needed it. What
           * matters is the ratio between the two failure modes: the fetch
           * fails far more often than the judgement does, which is why
           * 16b8782 and 86ddf10 went after the fetch and not the prompt.
           */
          /**
           * PER RELATION, NOT PER BAND — the band split above was measured on
           * an aggregate that hid the answer.
           *
           * Pairing every snippet claim in the run corpus against the majority
           * verdict the same host got when a run DID read its page — 948 such
           * pairs — the agreement is nothing like uniform inside either band:
           *
           *   lists          224      88%     [channel, kept]
           *   discusses       49      82%     [channel, kept]
           *   competitor      90      59%     -> page says lists 13%
           *   covers         439      54%     -> page says competitor 15%
           *   adjacent       105      30%     -> page says competitor 36%
           *   none            20      25%     -> page says adjacent 30%
           *   substitute,      21       0%     pooled: 0 of 21 correct
           *   integration,
           *   dependency,
           *   target
           *
           * `covers` is 62% of all channel claims, so it dragged the channel
           * average to the 48% the band split was built on and buried `lists`
           * at 88% and `discusses` at 82% underneath it. Those two are the
           * most reliable things a snippet says, and the band gate refused
           * them. This keeps them.
           *
           * The bar is 80% agreement, and the three relations that miss it
           * badly are refused whichever band they sit in. `adjacent` at 30%
           * is wrong more often than right and its most common truth is
           * `competitor` — a rival misfiled as a neighbour. `covers` at 54%
           * is the model's shrug: highest volume, lowest signal, and the row
           * that ships 2checkout.com on the stripe map as a publisher writing
           * educational articles. `none` is a claim too — it drops the host —
           * and at 25% it is the least supported of all.
           *
           * The rare market relations are 0 for 21 individually too thin to
           * read, but pooled they are not: if the true rate were even 50%,
           * 0 of 21 would be a one-in-two-million result.
           *
           * WHAT IT COSTS AND BUYS, on shopify's snippet-judged rows:
           *
           *   band gate    keeps 62 rows   ~23 correct   ~39 wrong
           *   this gate    keeps 28 rows   ~25 correct    ~3 wrong
           *
           * The same number of true rows, with thirty-six fewer false ones.
           * A gate that refuses more is only worth it if what it keeps is
           * worth more, and here what it keeps is nearly all of the truth.
           *
           * ON THE WIRE, three shopify.com runs. "Snippet-only" is a row this
           * branch kept and the second look never revisited; "rescued" is one
           * it withheld that a real page then placed:
           *
           *   band gate    adjacent 67, competitor 7                 11 rescued
           *   band gate    adjacent 51, competitor 19, +2            23 rescued
           *   this gate    lists 23, discusses 4                     34 rescued
           *
           * Exactly the allowlist survives, and nothing else does. The rows
           * the gate stops keeping do not simply vanish either — withholding
           * them is what sends them to the second look, and the count it
           * places on real evidence went 11 to 34 over the same three runs.
           * So the map trades ~70 rows guessed at 30-59% for ~27 guessed at
           * 82-88% plus 34 read off an actual page.
           *
           * The caveat that belongs with it: `understand` read shopify as 43,
           * 43 and 56 products on those three runs, so nothing here is a
           * controlled comparison and no map-level number is claimed from it.
           * What it does establish is that the gate does on the wire what it
           * says it does, which is the part that was not previously checked.
           *
           * AND IT DOES NOT GUT THE CHANNEL LAYER, which is the obvious
           * objection to a gate that refuses `covers` — the relation with the
           * highest volume of the lot. Channel rows on the map, all sources:
           *
           *   band gate    180 rows, 16% of kept   covers 128, lists 33
           *   band gate    139 rows, 13% of kept   covers 100, lists 33
           *   this gate    181 rows, 16% of kept   covers  96, lists 70
           *
           * The share holds because most `covers` rows were never snippet
           * guesses — they come from hosts whose page opened, which this
           * branch does not touch. What moved is the composition: `lists`
           * doubled, because the band gate had been refusing the single most
           * reliable thing a snippet says, and the `covers` that went away
           * were the guessed ones.
           *
           * IT GENERALISES — cloudflare.com, a second anchor, before and after
           * everything on this branch:
           *
           *              snippet-only kept rows                    kept   cost
           *   before     covers 75, adjacent 21, competitor 17,    1122  $1.05
           *              discusses 16, lists 15   (144 rows)
           *   after      lists 24, discusses 14    (38 rows)       1165  $1.25
           *
           * The same collapse to the allowlist, on an anchor whose plan was cut
           * far harder than shopify's — 163 queries fired of 592 queued, 28%.
           * And the map did not shrink: `kept` rose by 43 even though ~106
           * snippet-guessed rows were withheld, because the second look placed
           * 32 hosts on real pages where the earlier run placed 3.
           *
           * Two caveats. The second-look comparison is confounded BY this gate
           * — the earlier run had few unplaced hosts to look at precisely
           * because it was guessing at them instead (asked 13, this one 60 of
           * 141) — so that column shows the two stages composing, not an
           * independent gain. And the run took 30 minutes against 19, which is
           * the real price: 25 unlocker escalations at up to a two-minute
           * timeout each is most of it.
           */
          /**
           * AND IT SETTLES THE `admit()` BYPASS, which was a real complaint
           * about this branch: it returns before either `admit()` call below,
           * so the gate in verdict.ts written for unreadable hosts never sees
           * a snippet judgement.
           *
           * That bypass is now harmless, and by subsumption rather than by
           * luck. `admit()` has exactly two rules:
           *
           *   the aggregator rule  requires `page?.readable`, and a snippet
           *                        judgement has no readable page by
           *                        definition — inapplicable, not evaded
           *   the commercial rule  refuses `competitor` and `substitute`
           *                        when the page could not be read
           *
           * The second is precisely what this allowlist already does, and
           * more: `competitor` and `substitute` are not in it, so they are
           * withheld here before `admit()` would have had the chance. Routing
           * this branch through it would change no row.
           *
           * THAT HOLDS ONLY WHILE THE ALLOWLIST EXCLUDES THEM. Add
           * `competitor` to the set above on some future evidence and the
           * bypass goes live again — verdict.ts's rule would want to refuse
           * exactly the row this gate just admitted. Whoever widens it owes
           * the `admit()` call this branch currently does not need.
           */
          const SNIPPET_MAY_SAY = new Set(["lists", "discusses"])
          const overreach = !SNIPPET_MAY_SAY.has(out.relation)
          emit({
            name: out.name || h.host, domain: h.host,
            kind: out.kind, what: out.what,
            relation: overreach ? "unknown" : out.relation,
            why: overreach ? "" : out.why,
            because: overreach
              ? `its front page could not be read this run (${s.status}), and the search results read as ${out.relation} — a call that the host's own page bears out less than 80% of the time, so the relation is withheld rather than guessed`
              : `its front page could not be read this run (${s.status}); judged from the search results that surfaced it`,
            unreadableReason: s.reason,
            settledBy: "model",
            ...(verified.length ? { spans: verified } : {}),
            descSpans: { verified: verified.length, claimed: out.spans.length },
          })
          return
        } catch {
          // A failed call falls through to the blank the host would have
          // gotten anyway.
        }
      }
      stats.settledFree += 1
      emit({
        name: h.host, domain: h.host, kind: "unknown", what: "",
        relation: "unknown", why: "",
        // The sentence keeps the flattened verdict — it reads right — and the
        // code beside it keeps the distinction the sniffer already earned.
        because: `its front page could not be read this run (${s.status})`,
        unreadableReason: s.reason,
        settledBy: "predicate",
      })
      return
    }

    const page: JudgedPage = {
      url,
      readable: true,
      outboundHosts: outboundHosts(raw.body, url),
    }

    if (threshold !== null) {
      const shape = admit({ host: h.host, kind: "company", relation: "competitor" }, page, {
        anchor: deps.anchor, aggregatorThreshold: threshold,
      })
      if (!shape.ok && shape.kind === "directory") {
        stats.aggregators += 1
        stats.settledFree += 1
        emit({
          name: h.host, domain: h.host, kind: shape.kind,
          what: "a page that enumerates vendors in this market",
          relation: shape.relation, why: shape.because, because: shape.because,
          settledBy: "predicate",
        })
        return
      }
    }

    // Residue: one host, one judgement, from the page itself.
    stats.modelJudged += 1
    const pageText = condense(s.text, 6_000).slice(0, 4_000)
    let out: Awaited<ReturnType<JudgeDeps["classify"]>>
    try {
      out = await deps.classify(h, pageText)
    } catch (err) {
      emit({
        name: h.host, domain: h.host, kind: "unknown", what: "",
        relation: "unknown", why: "",
        because: `the model call failed (${err instanceof Error ? err.message : String(err)})`,
        settledBy: "model",
      })
      return
    }
    // This gate is structurally unreachable today, and that is worth saying
    // out loud rather than letting it read as load-bearing. Classify only
    // ever runs on a page that was just read, so the own-page rule is
    // satisfied by construction; and the aggregator rule was either already
    // settled by the pre-model check above with the same threshold, or
    // disabled into infinity here. It stays wired so that if residue
    // classification ever runs off anything but a just-read page — a snippet
    // fallback, a cached body — the downgrade path already exists instead of
    // needing to be remembered.
    const gate = admit({ host: h.host, kind: out.kind, relation: out.relation }, page, {
      anchor: deps.anchor, aggregatorThreshold: threshold ?? Number.POSITIVE_INFINITY,
    })
    // The canary, kept: how much of the description the model just wrote is
    // actually on the page it was written from. Computed against the exact
    // text the model saw, on the model's own prose — before any fallback —
    // so the meter keeps metering the model when the span gate below has
    // already replaced what the reader sees.
    // THE MODEL CAME BACK WEARING THE ANCHOR'S NAME, on a host that is not the
    // anchor. It was asked what THIS host is and answered with the market's most
    // famous brand, which is the one answer that cannot be a near miss.
    //
    // MEASURED, and it is not rare: six of nine runs on disk have one. Figma's
    // map carried a "Figma" whose domain was egnyte.com; Cloudflare's an
    // "exabeam.com", Shopify's an "eginnovations.com", Twilio's an "egain.com",
    // GitHub's two. All enterprise sites behind bot protection, all named after
    // the anchor.
    //
    // WHY IT IS WORTH ITS OWN BRANCH rather than a rename. The linker resolves a
    // mention to an entity BY NAME, so a second entity called "Figma" collects
    // every page in the run that mentions Figma: 273 of the 2,461 edges in that
    // map, 11% of the whole graph, pointing at a file-sharing company. The map's
    // own anchor was split in half and half of it was labelled Egnyte.
    //
    // AND EVERYTHING IT SAID GOES, not just the name. That row's `why` was
    // "defines the category of collaborative interface design tools" — a true
    // sentence about Figma, attached to Egnyte. A model that returned the wrong
    // subject was not describing this page, so its kind, relation and reasons
    // are about the same wrong subject. The span gate below catches the
    // description and cannot catch any of the rest, because a hallucinated
    // sentence about the anchor is still ungrounded text either way.
    //
    // The entity survives wearing the refusal, which is what an unreadable host
    // gets: the host was found, and what it is went unsettled this run.
    if (anchorIdentityTheft(out.name ?? "", h.host, deps.anchor)) {
      emit({
        name: h.host, domain: h.host, kind: "unknown", what: "",
        relation: "unknown", why: "",
        because: `the model answered with the anchor's own identity for this host, so nothing it said about it stands`,
        settledBy: "model",
      })
      return
    }

    // THE NAME'S HOME IS ELSEWHERE. "SendGrid" judged onto
    // sendgrid.kke.co.jp — the brand spelled in a subdomain of someone
    // else's registrable domain — drags every mention of the brand onto a
    // reseller's door, and the brand's own domain never enters the map. The
    // name is withdrawn the same way the anchor-identity branch above
    // withdraws one: the model was describing a company this host is not.
    {
      if (wrongDoor(out.name ?? "", h.host)) {
        emit({
          name: h.host, domain: h.host, kind: "unknown", what: "",
          relation: "unknown", why: "",
          because: `the page answered as "${out.name}", a brand whose home is not ${registrableHost(h.host)} — the name is withdrawn rather than bound to the wrong door`,
          settledBy: "model",
        })
        return
      }
    }

    const grounding = descriptionGrounding(out.what, pageText)
    groundingSum += grounding.score
    groundingN += 1
    stats.groundingMean = Math.round((groundingSum / groundingN) * 100) / 100
    const descGrounded = Math.round(grounding.score * 100) / 100

    // THE GUARANTEE. Every span the model claimed is checked in code as a
    // literal substring of the SAME condensed text it was just handed — the
    // evidence mint's own containment, not a second implementation, not a
    // second model pass. A span that fails is dropped; a non-empty what with
    // no surviving span never reaches the reader — it is replaced by a
    // sentence that says so, because the downgrade doctrine holds here too:
    // the entity survives, wearing the refusal, and an invention dies where
    // a reader would have believed it.
    //
    // The gate's honest scope: containment proves each span is FROM the page
    // — that the span SUPPORTS the what beside it is still the model's claim,
    // and descGrounded above stays that claim's meter.
    const { spans: claimed, ...judged } = out
    const verified = claimed.filter((sp) => checkQuote(pageText, sp) === "ok")
    const descSpans = { verified: verified.length, claimed: claimed.length }
    // Receipts: capped by the one exported implementation, so the second
    // look's stored receipts obey the same budget.
    const receipts = capReceipts(verified)
    // An empty what claims nothing, so there is nothing to refuse; the
    // fallback names the kind the entity actually ships with.
    const whatFor = (kind: string) =>
      judged.what.trim() !== "" && verified.length === 0
        ? `${judged.name || h.host} — ${kind} whose description could not be tied to its page this run`
        : judged.what
    const spanFields = { descSpans, ...(receipts.length ? { spans: receipts } : {}) }

    if (!gate.ok) {
      emit({ ...judged, what: whatFor(gate.kind), domain: h.host, kind: gate.kind, relation: gate.relation, because: gate.because, settledBy: "model", descGrounded, ...spanFields })
      return
    }
    emit({ ...judged, what: whatFor(judged.kind), domain: h.host, settledBy: "model", descGrounded, ...spanFields })
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (deps.signal?.aborted) return
      // Checked in the same breath as the abort and for the same reason: a
      // worker that has just finished a host is the only place a phase can be
      // left early without abandoning work that was already paid for.
      if (deps.stop?.()) return
      const h = queue.pop()
      if (!h) return
      await judgeOne(h)
    }
  }
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 8, hosts.length || 1) }, worker))
  return { entities, probePages, stats }
}

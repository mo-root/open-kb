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
export async function judgeHosts(hosts: HostCandidate[], deps: JudgeDeps) {
  const threshold = deps.aggregatorThreshold
  const entities: Judged[] = []
  const probePages: Array<{ url: string; html: string }> = []
  const stats: KernelStats = { fetched: 0, unreadable: 0, unreadableByReason: {}, aggregators: 0, modelJudged: 0, settledFree: 0, groundingMean: null }
  const countDeadEnd = (reason: UnreadableReason) => {
    stats.unreadable += 1
    stats.unreadableByReason[reason] = (stats.unreadableByReason[reason] ?? 0) + 1
  }
  const anchorKey = registrableHost(deps.anchor)
  /**
   * The anchor's own brand, as a string two spellings of it both reduce to.
   *
   * Only ever compared against a name the model wrote, so it has to survive the
   * ways a brand is written down: "Figma", "figma", "FIGMA". Punctuation goes
   * for the same reason — "e-gain" and "eGain" are one identity.
   */
  const identityKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "")
  const anchorLabel = identityKey(anchorKey.split(".")[0] ?? "")
  const queue = [...hosts]

  // The running mean's raw ingredients — the mean itself is stored rounded,
  // and rounding the addends before averaging would drift it.
  let groundingSum = 0
  let groundingN = 0

  const emit = (e: Judged) => {
    entities.push(e)
    deps.onJudged?.(e)
  }

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
    const s = sniff(raw)
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

    if (s.status !== "found") {
      countDeadEnd(s.reason)
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
    if (
      // A one- or two-letter anchor label ("x.com") would match names that have
      // nothing to do with it, so the rule declines to fire rather than rename
      // real entities on a coincidence.
      anchorLabel.length >= 3 &&
      registrableHost(h.host) !== anchorKey &&
      identityKey(out.name ?? "") === anchorLabel
    ) {
      emit({
        name: h.host, domain: h.host, kind: "unknown", what: "",
        relation: "unknown", why: "",
        because: `the model answered with the anchor's own identity for this host, so nothing it said about it stands`,
        settledBy: "model",
      })
      return
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
    // Receipts: whole verified spans while they fit the budget; a first span
    // longer than the whole budget is cut to it — a prefix of a literal
    // substring is still a literal substring.
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

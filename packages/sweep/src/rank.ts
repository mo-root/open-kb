import {
  sniff, condense, admit, outboundHosts, registrableHost,
  type FetchPort, type JudgedPage,
} from "@open-kb/core"

export interface HostCandidate {
  host: string
  seenIn: number
  intents: string[]
  titles: string[]
  desc: string
  /** The highest-ranked hit URL for this host, when the caller has one. An
   *  aggregator's ranked page is a better answer key than its front page. */
  topHit?: string
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
  settledBy: "predicate" | "model"
}

export interface KernelStats {
  fetched: number
  unreadable: number
  aggregators: number
  modelJudged: number
  settledFree: number
}

export interface JudgeDeps {
  fetcher: FetchPort
  classify: (h: HostCandidate, pageText: string) => Promise<{ name: string; kind: string; what: string; relation: string; why: string }>
  anchor: string
  aggregatorThreshold: number | null
  concurrency?: number
  signal?: AbortSignal
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
  const stats: KernelStats = { fetched: 0, unreadable: 0, aggregators: 0, modelJudged: 0, settledFree: 0 }
  const anchorKey = registrableHost(deps.anchor)
  const queue = [...hosts]

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
      stats.unreadable += 1
      stats.settledFree += 1
      deps.onFetch?.(url, false, Date.now() - started)
      emit({
        name: h.host, domain: h.host, kind: "unknown", what: "",
        relation: "unknown", why: "",
        because: `its front page fetch threw this run (${err instanceof Error ? err.message : String(err)})`,
        settledBy: "predicate",
      })
      return
    }
    stats.fetched += 1
    const s = sniff(raw)
    deps.onFetch?.(url, s.status === "found", raw.ms)

    // An answer key is worth keeping whatever the verdict on the host is —
    // except the anchor's own page, which names the anchor by definition and
    // would let the map grade itself.
    if (raw.body && registrableHost(h.host) !== anchorKey && raw.body.toLowerCase().includes(anchorKey)) {
      probePages.push({ url, html: raw.body })
    }

    if (s.status !== "found") {
      stats.unreadable += 1
      stats.settledFree += 1
      emit({
        name: h.host, domain: h.host, kind: "unknown", what: "",
        relation: "unknown", why: "",
        because: `its front page could not be read this run (${s.status})`,
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
    let out: Awaited<ReturnType<JudgeDeps["classify"]>>
    try {
      out = await deps.classify(h, condense(s.text, 6_000).slice(0, 4_000))
    } catch (err) {
      emit({
        name: h.host, domain: h.host, kind: "unknown", what: "",
        relation: "unknown", why: "",
        because: `the model call failed (${err instanceof Error ? err.message : String(err)})`,
        settledBy: "model",
      })
      return
    }
    const gate = admit({ host: h.host, kind: out.kind, relation: out.relation }, page, {
      anchor: deps.anchor, aggregatorThreshold: threshold ?? Number.POSITIVE_INFINITY,
    })
    if (!gate.ok) {
      emit({ ...out, domain: h.host, kind: gate.kind, relation: gate.relation, because: gate.because, settledBy: "model" })
      return
    }
    emit({ ...out, domain: h.host, settledBy: "model" })
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (deps.signal?.aborted) return
      const h = queue.pop()
      if (!h) return
      await judgeOne(h)
    }
  }
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 8, hosts.length || 1) }, worker))
  return { entities, probePages, stats }
}

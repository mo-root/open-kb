"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { StatTile } from "@/components/viz";
import { AgentPanel, type AgentChunk } from "./AgentPanel";
import { EventFeed } from "./EventFeed";
import { FindingsPanel, type EntityData } from "./FindingsPanel";
import { SearchesPanel, readSearched, type SearchView } from "./SearchesPanel";
import { PlanCard, UnderstandingCard } from "./PlanCard";
import { DecisionsStrip, type Decision } from "./DecisionsStrip";
import { ResultPanel, type RunResult } from "./ResultPanel";
import { StageTracker } from "./StageTracker";
import {
  advance,
  allDone,
  formatDuration,
  formatUsd,
  initialStates,
  readCost,
  readPlanned,
  readProgress,
  readResult,
  readTrace,
  readUnderstanding,
  STAGES,
  STAGE_BLURB,
  STAGE_LABELS,
  type CostView,
  type FeedItem,
  type PlanView,
  type Stage,
  type StageState,
  type TraceView,
  type UnderstandingView,
} from "./types";

/**
 * The map surface: one domain in, a live sweep out.
 *
 * v1's BuildWorkflow with its engine replaced. `POST /api/map` starts a plain
 * async function against an in-memory registry (lib/runs.ts) instead of a
 * durable workflow; the surface only ever knew about NDJSON, so nothing below
 * changed. v1 also gated on a per-run dollar limit, where this bounds a run by
 * query count.
 *
 * Five independent NDJSON streams, so the verbose trace channel cannot slow the
 * cost readout:
 *
 *   /api/run/{id}/stream               results
 *   /api/run/{id}/stream?ns=progress   stage + status
 *   /api/run/{id}/stream?ns=agent      the model's own output
 *   /api/run/{id}/stream?ns=cost       { usd, tokens, serpCalls, unlockerCalls }
 *   /api/run/{id}/stream?ns=trace      one row per tool call
 */

/**
 * Read one namespaced NDJSON stream, reconnecting until the caller aborts.
 *
 * THE failure this fixes. A serverless response caps at 300s, so the response
 * ends after about five minutes while a run keeps going. A single fetch saw
 * `done` and stopped, so the rail sat on one stage for the rest of a run that
 * was working perfectly, the product looked broken while doing exactly what it
 * was asked.
 *
 * `startIndex` is what makes the reconnect lossless: the count of frames already
 * delivered is sent back, so the next response resumes rather than replaying
 * from zero and double-counting every cost frame.
 */
async function readNdjson(
  url: string,
  onLine: (v: unknown) => void,
  signal: AbortSignal,
  /** Asked before giving up. `false` keeps reading however long the silence. */
  isOver: () => Promise<boolean> = async () => true,
): Promise<void> {
  let received = 0;
  // consecutive empty reconnects, not total attempts.
  //
  // THE failure this fixes. The counter used to be the loop's own index, so
  // every reconnect, including the ones that delivered, counted toward giving
  // up. The results stream emits `understanding` and `planned` in its first
  // seconds and then nothing for the minutes of sweep and classification, so it
  // was already several iterations in when the silence began and quit shortly
  // after. It never saw `complete`.
  let quiet = 0;
  while (!signal.aborted) {
    const next = received > 0 ? `${url}${url.includes("?") ? "&" : "?"}startIndex=${received}` : url;
    const before = received;
    received += await readOnce(next, onLine, signal);
    if (signal.aborted) return;
    if (received > before) {
      quiet = 0;
      continue;
    }
    quiet += 1;
    // Silence is not the end of a run, it is what the middle of one looks
    // like. Only the run itself can say, so it is asked.
    if (quiet > 3 && (await isOver())) return;
    await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** Math.min(quiet, 5))));
  }
}

/** One connection. Returns how many lines it delivered. */
async function readOnce(
  url: string,
  onLine: (v: unknown) => void,
  signal: AbortSignal,
): Promise<number> {
  let n = 0;
  const res = await fetch(url, { signal }).catch(() => null);
  if (!res) return n;
  const reader = res.body?.getReader();
  if (!reader) return n;
  // A StrictMode remount aborts the first fetch; without this the locked
  // stream's rejection surfaces as an uncaught AbortError in the console.
  reader.closed.catch(() => {});
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
        n += 1;
      } catch {
        // A torn line is not worth failing the whole view over.
      }
    }
  }
  return n;
}

/**
 * Is this progress line the run deciding whether to spend more?
 *
 * The planner narrates two different kinds of thing under the same agent name.
 * Setup ("catalog: 40 queries, none name the anchor") is a description of work
 * already done. A verdict ("round 2 added only 3 — stopping, further queries
 * are buying corroboration") is the run choosing, mid-flight, what to do with
 * the rest of the budget. Only the second belongs above the fold.
 *
 * Matched on shape, and loosely: `enough` and `round N` are the two openings
 * the assess loop writes, and an unmatched line still appears in the feed and
 * the stage rail, so the cost of missing one is that it is merely not promoted.
 */
function isSpendDecision(agent: string, message: string): boolean {
  if (agent.trim().toLowerCase() !== "plan") return false;
  const m = message.trimStart();
  return /^enough\b/i.test(m) || /^round\s+\d+/i.test(m);
}

/**
 * What a visitor who is not paying needs to know before they type.
 *
 * Passed in rather than read here, because only a server component can see
 * `OPENKB_PUBLIC_RUNS_PER_DAY` and only the store can count today's runs. The
 * numbers are measured, not quoted from a rate card — see `MEASURED` in
 * lib/public-runs.ts, which is where they are written down.
 *
 * ABSENT ON AN ORDINARY DEPLOYMENT, and that is the point: with no invite this
 * component renders exactly what it has always rendered, down to the price line
 * under the input, which is the right line for an operator who is spending
 * their own money and the wrong one for a stranger who is spending none.
 */
export interface RunInvite {
  /** Runs a day this deployment pays for. */
  limit: number;
  /** How many of them are left, counted before the page was drawn. */
  remaining: number;
  /** About how long one takes, in minutes. */
  minutes: number;
  /** About how many entities one returns. */
  entities: number;
}

/**
 * THIS COMPONENT KNOWS NOTHING ABOUT THE DEMO, and it is the second thing to
 * have held that job.
 *
 * It took a `demo` prop for a while: app/page.tsx read `OPENKB_DEMO` (only a
 * server component can) and passed the answer down, and this surface responded
 * by disabling its own input, greying its own button and printing a paragraph
 * above both explaining why. That is a form that exists to say no. The demo
 * branches one level up — app/page.tsx renders a gallery of the maps instead of
 * this, or, when the deployment has a daily allowance, renders this WITH the
 * gallery underneath it — so the run-starter is only ever mounted where it can
 * actually run, and every control on it is live by construction rather than by
 * a prop agreeing to be.
 *
 * It still knows nothing about the demo with `invite` in hand. The prop says
 * how many runs are left, which is a fact about an allowance and not about a
 * flag; a private deployment that sets a daily cap gets the same line.
 *
 * The guard never lived here anyway. `POST /api/map` refuses through `runGate`,
 * which is where it has to be: this is client code, and a reader with the
 * devtools open can call that endpoint whatever the page renders.
 */
export function BuildWorkflow({
  invite,
  children,
}: {
  invite?: RunInvite;
  /**
   * Whatever the page wants under the run surface — on a public deployment,
   * the maps it already holds.
   *
   * Rendered only while no run has started. A visitor who has typed a domain is
   * watching their own run and a grid of somebody else's maps below it is a
   * competing offer at the exact moment they committed to waiting four minutes.
   */
  children?: ReactNode;
}) {
  const router = useRouter();
  /**
   * Send the reader to the finished map.
   *
   * `prefetch` first so the navigation is instant on arrival rather than a
   * cold render of a page that has to derive a 300-node graph. The delay is
   * for the eye, not the machine: the completion line in the feed should be
   * read before the view changes under it.
   */
  // Both completion paths call this — the `complete` frame and the fallback
  // fetch that learns a closed stream succeeded — and either may arrive first.
  // Without the guard a run navigates twice, and the second push lands while
  // the first is still resolving.
  const navigated = useRef(false);
  const goToMap = useCallback(
    (runId: string) => {
      if (navigated.current) return;
      navigated.current = true;
      const href = `/kb/${runId}`;
      router.prefetch(href);
      window.setTimeout(() => router.push(href), 1200);
    },
    [router],
  );
  const [input, setInput] = useState("");

  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  /**
   * How long this run should take, in seconds, as the route worked it out from
   * its own function limit — `budget.estimatedSeconds` on the start response.
   *
   * IT RODE BACK ON THAT RESPONSE FOR MONTHS AND NOTHING READ IT. The surface
   * showed a rising elapsed counter and no denominator, which is a stopwatch,
   * not progress: at 2m 30s a reader cannot tell whether they are nearly there
   * or a third of the way in, and four minutes of that is how a visitor decides
   * the thing is broken and closes the tab. The estimate is the denominator,
   * and it is honest about being one — it comes from the same arithmetic that
   * sized the run, so it is the app's own claim rather than a guess about it.
   *
   * Null until the run starts, and it stays null if a response somehow carries
   * no budget. Nothing below invents a number for it: no estimate, no bar.
   */
  const [expectedSec, setExpectedSec] = useState<number | null>(null);

  const [states, setStates] = useState<Record<Stage, StageState>>(initialStates);
  const [stageLog, setStageLog] = useState<Partial<Record<Stage, string[]>>>({});
  const [cost, setCost] = useState<CostView | null>(null);
  const [agentChunks, setAgentChunks] = useState<AgentChunk[]>([]);
  const [spendHistory, setSpendHistory] = useState<number[]>([]);
  const [calls, setCalls] = useState<TraceView[]>([]);
  const [understanding, setUnderstanding] = useState<UnderstandingView | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [entities, setEntities] = useState<EntityData[]>([]);
  const [searches, setSearches] = useState<SearchView[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  /** Set by the Stop button, cleared by the next run. Distinguishes the ending
   *  the reader chose from the one that happened to them. */
  const [stopped, setStopped] = useState(false);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const decisionId = useRef(0);

  const feedId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const startedAt = useRef<number>(0);

  // A run outlives the component only on the server; the streams must not.
  useEffect(() => () => abort.current?.abort(), []);

  // The wall clock. A sweep is minutes long and the single most reassuring
  // thing on the screen is proof that time is passing at all.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 1000);
    return () => clearInterval(t);
  }, [running]);

  /** The feed is a live tail, not the archive: a wide sweep emits a line per
   *  stage plus a row per call, and an unbounded list re-renders every one of
   *  them on every frame. */
  const addFeed = useCallback((tone: FeedItem["tone"], text: string) => {
    setFeed((f) => {
      const next = [...f, { id: feedId.current++, tone, text }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const startRun = useCallback(async () => {
    const target = input.trim();
    if (!target) return;

    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;

    setStates(initialStates());
    setStageLog({});
    setCost(null);
    setSpendHistory([]);
    setCalls([]);
    setAgentChunks([]);
    setUnderstanding(null);
    setPlan(null);
    setEntities([]);
      setSearches([]);
    setFeed([]);
    setResult(null);
    navigated.current = false;
    setErrorText(null);
    setStopped(false);
    setDecisions([]);
    setRunId(null);
    setExpectedSec(null);
    startedAt.current = Date.now();
    setElapsed(0);
    setRunning(true);

    let started: { runId: string };
    try {
      const res = await fetch("/api/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: target }),
        signal: ctrl.signal,
      });
      const body = (await res.json().catch(() => null)) as
        | {
            runId?: string;
            error?: string;
            budget?: { estimatedSeconds?: number; clockSeconds?: number };
          }
        | null;
      if (!res.ok || !body?.runId) {
        // The API rejects an input that names no company before starting a run,
        // and that message is the useful one, not "HTTP 400".
        setErrorText(body?.error ?? `HTTP ${res.status}`);
        setRunning(false);
        return;
      }
      started = { runId: body.runId };
      // The route's own estimate for the run it just sized. Guarded rather than
      // trusted: a zero or a missing field would make the bar below divide by
      // nothing, and `null` renders no bar at all, which is the honest fallback.
      const est = body.budget?.estimatedSeconds;
      if (typeof est === "number" && Number.isFinite(est) && est > 0) setExpectedSec(est);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setErrorText(err instanceof Error ? err.message : String(err));
      setRunning(false);
      return;
    }

    setRunId(started.runId);
    addFeed("accent", `▶ map ${target}`);

    const onResult = (v: unknown) => {
      const frame = readResult(v);
      if (!frame) return;

      const asSearched = readSearched(v);
      if (asSearched) {
        setSearches((prev) => [...prev, asSearched]);
        return;
      }

      const asPlan = readPlanned(v);
      if (asPlan) {
        setPlan(asPlan);
        setStates((s) => advance(s, "plan"));
        addFeed("accent", `plan: ${asPlan.count} queries · est ${formatUsd(asPlan.estimatedUsd)} of search`);
        return;
      }

      const asUnderstanding = readUnderstanding(v);
      if (asUnderstanding) {
        setUnderstanding(asUnderstanding);
        setStates((s) => advance(s, "understand"));
        addFeed("accent", `understood: ${asUnderstanding.sells}`);
        return;
      }

      const p = frame.payload;
      switch (frame.kind) {
        case "ranked":
        case "candidates": {
          const rows = Array.isArray(p.candidates) ? (p.candidates as EntityData[]) : [];
          if (rows.length) {
            setEntities((cur) => mergeEntities(cur, rows));
            addFeed("green", `+${rows.length} on the map`);
          }
          break;
        }
        case "error":
          setErrorText(String(p.message ?? p.error ?? "the run reported an error"));
          addFeed("red", `error: ${String(p.message ?? p.error ?? "")}`);
          setRunning(false);
          break;
        case "complete": {
          const r = (p.result ?? p) as RunResult;
          setResult(r);
          setStates(allDone);
          setRunning(false);
          addFeed("green", `complete: ${r.kept ?? 0} on the map · ${formatUsd(r.usd)}`);
          // Straight to the map. A run that just spent two minutes and real money
          // ending on a summary card, with the thing it produced one more click
          // away, makes the reader do the last step themselves for no reason.
          // Short pause so the final feed line is seen rather than flashed past.
          goToMap(started.runId);
          break;
        }
      }
    };

    /** Is the run actually over? Asked before any reader gives up on silence,
     *  because a quiet stream is what the middle of a sweep looks like. */
    const runIsOver = async (): Promise<boolean> => {
      const r = await fetch(`/api/run/${started.runId}`, { signal: ctrl.signal }).catch(() => null);
      if (!r?.ok) return false; // cannot tell → keep reading
      const body = (await r.json().catch(() => null)) as { status?: string } | null;
      return !!body?.status && body.status !== "running";
    };

    // When the results stream closes without a `complete` frame the run threw,
    // or the connection dropped. Either way the surface must stop claiming to be
    // live, a spinner that never ends is the failure mode this guards. Only the
    // current run may clear the flag; an abort caused by a newer run must not.
    void readNdjson(`/api/run/${started.runId}/stream`, onResult, ctrl.signal, runIsOver)
      .catch(() => {})
      .finally(() => {
        if (abort.current !== ctrl) return;
        setRunning(false);
        // THE result must NOT depend ON catching A frame. Ask the run for its
        // own summary, the same object the `complete` frame carries, held by
        // the registry rather than by whoever happened to be watching.
        void (async () => {
          const r = await fetch(`/api/run/${started.runId}`, { signal: ctrl.signal }).catch(() => null);
          if (!r?.ok || abort.current !== ctrl) return;
          const body = (await r.json().catch(() => null)) as
            | { status?: string; result?: RunResult; error?: string }
            | null;
          if (!body) return;
          if (body.result) {
            // `setResult(prev => prev ?? …)`: a `complete` frame that DID arrive
            // is the same value, and re-setting it would churn the panel.
            setResult((prev) => prev ?? body.result!);
            setStates(allDone);
            // The other way a run finishes: the stream closed and this fetch is
            // what learned it succeeded. `goToMap` is idempotent enough that
            // arriving here after a `complete` frame already fired is harmless,
            // and a run whose frame never arrived still lands on its map.
            goToMap(started.runId);
          } else if (body.error) {
            setErrorText((prev) => prev ?? body.error!);
          }
        })();
      });

    void readNdjson(
      `/api/run/${started.runId}/stream?ns=progress`,
      (v) => {
        const p = readProgress(v);
        if (!p) return;
        if (p.stage) {
          const stage = p.stage;
          setStates((s) => advance(s, stage));
          setStageLog((m) => ({ ...m, [stage]: [...(m[stage] ?? []), p.message] }));
        }
        /* Lift the wave verdicts out of the rail.
           Matched on the SHAPE of a spend decision, not on where it lands in the
           run: `stageOf("plan")` is the Plan stage, and by the time these arrive
           that stage is closed, so the rail files them as history of something
           finished. Gating on arrival order instead would assume all setup
           narration precedes the first search — true of today's fixed wave loop,
           and not something an agent-driven phase has to honour. */
        if (isSpendDecision(p.agent, p.message)) {
          setDecisions((d) => [
            ...d,
            { id: decisionId.current++, text: p.message, atSec: p.atSec },
          ]);
        }
        // The elapsed marker is what makes a slow stage visible: two minutes
        // between two lines reads as a stall, and sometimes it is one.
        addFeed(
          "muted",
          `${p.atSec !== undefined ? `[${String(Math.floor(p.atSec / 60)).padStart(2, "0")}:${String(p.atSec % 60).padStart(2, "0")}] ` : ""}${p.agent}: ${p.message}`,
        );
      },
      ctrl.signal,
      runIsOver,
    ).catch(() => {});

    void readNdjson(
      `/api/run/${started.runId}/stream?ns=cost`,
      (v) => {
        const c = readCost(v);
        if (!c) return;
        setCost(c);
        setSpendHistory((h) => (h.length > 400 ? [...h.slice(-400), c.usd] : [...h, c.usd]));
      },
      ctrl.signal,
      runIsOver,
    ).catch(() => {});

    void readNdjson(
      `/api/run/${started.runId}/stream?ns=agent`,
      (v) => {
        if (!v || typeof v !== "object") return;
        // Capped like the trace list, and for the same reason: this is a live
        // view, not the archive. The tail is what a reader is following.
        setAgentChunks((c) =>
          c.length > 4000 ? [...c.slice(-4000), v as AgentChunk] : [...c, v as AgentChunk],
        );
      },
      ctrl.signal,
      runIsOver,
    ).catch(() => {});

    void readNdjson(
      `/api/run/${started.runId}/stream?ns=trace`,
      (v) => {
        const t = readTrace(v);
        if (!t) return;
        setCalls((c) => (c.length > 400 ? [...c.slice(-400), t] : [...c, t]));
        // The reason, when one travelled. "serp failed: <query>" names what
        // broke and says nothing about why; the provider's own message is the
        // difference between a retryable throttle and a dead zone.
        if (!t.ok)
          addFeed(
            "amber",
            `${t.tool} failed: ${t.argsDigest}${t.error ? ` — ${t.error}` : ""}`,
          );
      },
      ctrl.signal,
      runIsOver,
    ).catch(() => {});
  }, [input, addFeed]);

  /**
   * Distinct hosts any search has returned, whether or not one has been judged
   * yet.
   *
   * THE FIRST NUMBER THAT MOVES. Entities arrive at the classify stage, two
   * minutes in on a measured run, so `entities.length` sits at zero through the
   * whole of the plan and sweep — the exact stretch where a visitor is deciding
   * whether anything is happening. Hosts start landing with the first search
   * result. It is a weaker fact than an entity (a host here is a URL somebody
   * ranked, not a company this run has vouched for) and the label says so.
   */
  const hostsSeen = useMemo(() => {
    const seen = new Set<string>();
    for (const s of searches) {
      for (const hit of s.hits) {
        try {
          seen.add(new URL(hit.url).hostname.replace(/^www\./, ""));
        } catch {
          // a hit whose URL will not parse is not a host, and not worth a throw
        }
      }
    }
    return seen.size;
  }, [searches]);

  /** The stage the rail is on, as a word the progress panel can say. Falls back
   *  to the first stage before any frame has arrived — the run is reading the
   *  company's own pages by then, so "Understand" is true rather than a guess. */
  const activeStage: Stage = STAGES.find((s) => states[s] === "active") ?? "understand";

  /** How far through the estimate this run is, capped at 100. A run that
   *  overruns its estimate is not a run that is 130% done: the bar parks at the
   *  end and the elapsed figure beside it keeps counting, which is what an
   *  overrun actually looks like. */
  const pct =
    expectedSec === null ? null : Math.min(100, Math.round((elapsed / (expectedSec * 1000)) * 100));

  const messages: Partial<Record<Stage, string>> = {};
  const chips: Partial<Record<Stage, string[]>> = {};
  for (const [stage, lines] of Object.entries(stageLog) as [Stage, string[]][]) {
    messages[stage] = lines[lines.length - 1];
    // The newest line is already showing as the active stage's live message;
    // repeating it as a chip underneath reads as the event happening twice.
    chips[stage] = states[stage] === "done" ? lines : lines.slice(0, -1);
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      {/* ------------------------------------------------------------ input -- */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
          Map a market
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          One domain in, everyone else in its market out. The catalog is written
          before any company name is known — so the queries cannot look this
          company up, and what comes back is the market rather than its press.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500">
              domain
            </span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim() && !running) void startRun();
              }}
              placeholder="resend.com"
              spellCheck={false}
              /* Nothing disables this field any more — the demo used to, and it
                 branches a level up now. The two `disabled:` variants stay
                 because this page's rendering is pinned byte-for-byte
                 (app/page.test.tsx), and a class attribute is part of the
                 bytes; they cost nothing and they are what a disabled state
                 would look like if one ever comes back. */
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
            />
          </label>
          <button
            type="button"
            onClick={startRun}
            disabled={!input.trim() || running}
            className="rounded-lg bg-sky-500 px-5 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "Mapping…" : "Map"}
          </button>
          {/* Shown only while a run is live. Until this existed the only way to
              stop a sweep was to close the tab, which does not stop it, or to
              kill the server, which loses everything it had paid for. */}
          {running && runId && (
            <button
              type="button"
              onClick={() => {
                // Recorded here, not sniffed out of the error text downstream:
                // the run's stop message is prose and matching on prose breaks
                // the moment someone rewords it. This is the one place that
                // knows for certain the ending was chosen.
                setStopped(true)
                void fetch(`/api/run/${runId}/cancel`, { method: "POST" }).catch(() => {})
              }}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-400 transition hover:border-rose-600/60 hover:text-rose-400"
              title="Stop the run. Everything found so far is kept."
            >
              Stop
            </button>
          )}
        </div>

        {/* TWO READERS, TWO LINES, and which one is on screen is decided by who
            is paying.

            THE OPERATOR (no invite) gets the price. $0.0015 is Bright Data's
            SERP rate, and a query is THREE of those, not one — reading only the
            first page of results was leaving most of a market unread (7 hosts
            from page 1 against 37 across five pages on one measured query). The
            model half depends on how much text comes back and cannot be
            promised. The second clause says what BOUNDS it: a run started here
            has to finish inside this deployment's function limit, so it is
            given a query budget worked out from that limit and stops at it —
            the plan card below names the number once the run has one. Saying
            only the first half invited a reader to read a narrow map as a weak
            engine.

            THE VISITOR (invite) gets the time, because that is the only thing
            they are spending. A stranger quoted a bill they are not paying is
            being asked to decide, on the owner's behalf, whether they are worth
            twenty cents; a stranger told "about four minutes" is being told the
            one thing that will actually make them leave. The count of runs left
            is here rather than in a refusal for the same reason — a number
            before you type is information, and the same number after you type
            is a door in your face. */}
        {invite ? (
          <>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              <span className="tnum text-sky-300">
                {invite.remaining} of {invite.limit}
              </span>{" "}
              {invite.limit === 1 ? "run" : "runs"} left today · about {invite.minutes} minutes ·
              roughly {invite.entities} entities · both measured
            </p>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">
              It costs you nothing but the wait — this deployment pays the search and
              model providers. Leaving the page does not stop the run.
            </p>
          </>
        ) : (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            a question reads 3 result pages at $0.0015 each · here the planner asks as many as fit this host&rsquo;s
            clock
          </p>
        )}
      </div>

      {/* ---------------------------------------------------------- the wait -- */}
      {/* FOUR MINUTES IS THE PRODUCT'S HARDEST SCREEN, and everything below it
          was already on the page: the stage rail, the searches, the findings,
          the feed. What was missing is the thing a person actually asks while
          waiting — how far through am I, and has it found anything — and both
          answers were spread across three panels a reader had to assemble
          themselves while wondering whether to close the tab.

          So: one strip, above the fold, on the four facts. The phase in words.
          The clock against the run's OWN estimate rather than against nothing.
          What it has seen so far, starting with hosts, which move a minute
          before entities do. And the run's link, before it is needed rather
          than after — the run outlives the tab, and a visitor who knows that
          can leave without losing anything, which is a better outcome than one
          who stays out of fear. */}
      {runId && (
        <div className="mb-5 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-sm font-medium text-slate-200">
              {running
                ? STAGE_LABELS[activeStage]
                : errorText
                  ? "Stopped"
                  : "Finished — opening the map"}
            </span>
            <span className="tnum shrink-0 font-mono text-[11px] text-slate-500">
              {formatDuration(elapsed)}
              {expectedSec !== null && <> of about {formatDuration(expectedSec * 1000)}</>}
            </span>
          </div>

          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            {running
              ? STAGE_BLURB[activeStage]
              : errorText
                ? "Everything the run found before it stopped is kept."
                : "The map is written. Taking you to it."}
          </p>

          {/* No estimate, no bar. A progress bar with an invented denominator
              is the one thing here worse than no bar at all. */}
          {pct !== null && (
            <div
              className="mt-3 h-1 w-full overflow-hidden rounded-full bg-slate-800"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="how far through its estimate this run is"
            >
              <div
                className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${
                  running ? "bg-sky-500" : "bg-slate-600"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}

          {/* The running tally, in the order the run produces it. Every one of
              these is a count of something that arrived, so a reader watching
              this line is watching the run work rather than watching a spinner
              that would look identical if the process had died. */}
          <div className="tnum mt-2.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <span>{searches.length} questions asked</span>
            <span>{hostsSeen} hosts seen</span>
            <span className={entities.length > 0 ? "text-sky-300" : undefined}>
              {entities.length} on the map
            </span>
            <span>{formatUsd(cost?.usd)} spent</span>
          </div>

          <KeepLink runId={runId} ready={!running && !errorText} />
        </div>
      )}

      {/* ------------------------------------------------------------- spend -- */}
      {runId && (
        <div className="mb-6">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile
              label="spent"
              value={formatUsd(cost?.usd)}
              hint="models + search, so far"
              trend={spendHistory}
            />
            {/* THE TILE THAT WAS MISSING, and it is the one a reader waiting
                four minutes actually wants: what has this bought me. The count
                was on the page — `FindingsPanel` has held it all along — but
                three panels below the fold, under the searches and the trace,
                which is not where anyone looks to find out whether the wait is
                producing anything. */}
            <StatTile
              label="on the map"
              value={entities.length}
              hint="classified so far"
              tone={entities.length > 0 ? "text-sky-300" : "text-slate-100"}
            />
            <StatTile label="elapsed" value={formatDuration(elapsed)} hint="wall clock" />
            {/* "questions asked", not "serp calls". Two different quantities
                were wearing one name: lib/stream-adapter.ts counts one per
                search SPAN — one per question — while the sweep bills
                `serpCalls += PAGES`, a page count. So this tile showed a
                fraction of the number the finished run reports under the same
                words, on the same screen as a line saying a question reads
                several pages.

                The tile now names what it actually counts, and states no page
                multiplier: PAGES is `opts.pages ?? 3`, set per run, so any
                number written here would be a guess about a knob the caller
                turns. */}
            <StatTile
              label="questions asked"
              value={cost?.serpCalls ?? 0}
              hint="one per planned query"
            />
            {/* Usually zero, and that is the truth rather than a dead tile: the
                sweep reads a company's own pages with a free direct fetch and
                only falls back to the paid unlocker when that returns nothing. */}
            <StatTile label="unlocker" value={cost?.unlockerCalls ?? 0} hint="paid page fetches" />
            <StatTile label="tokens" value={cost?.tokens ?? 0} hint="prompt + completion" />
          </div>
          <div className="mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <span
              className={`h-1.5 w-1.5 rounded-full ${running ? "animate-pulse bg-sky-400" : "bg-slate-600"}`}
            />
            {running ? "live" : "finished"}
            <span className="text-slate-600">run {runId.slice(0, 8)}</span>
          </div>
        </div>
      )}

      {/* Above the two-column grid on purpose: this is the run telling you it
          is about to spend more of your money, and it does not belong in a
          side rail under a stage that has already closed. Renders nothing
          until the first wave verdict arrives. */}
      <DecisionsStrip decisions={decisions} />

      {/* -------------------------------------------------- stages + panels -- */}
      {runId || errorText ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          {/* Capped and scrollable, matching NotesTab.tsx:57. A sticky element
              taller than the viewport pins its TOP and strands everything past
              the fold with no way to reach it — and this rail grows all run, one
              chip per progress line, so on a Deep run `Classify` and `Map` were
              unreachable exactly while they were the stages worth watching. */}
          <div className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
            <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-5">
              <div className="mb-4 font-mono text-[11px] uppercase tracking-wider text-slate-500">
                pipeline
              </div>
              <StageTracker states={states} messages={messages} chips={chips} />
            </div>
          </div>

          <div className="min-w-0 space-y-6">
            {/* The order is the argument: what it understood, what it therefore
                asked and why, then what came back. */}
            {understanding && <UnderstandingCard u={understanding} />}
            {plan && <PlanCard plan={plan} />}
            <AgentPanel chunks={agentChunks} />
            <SearchesPanel searches={searches} />
            <FindingsPanel calls={calls} entities={entities} />
            <EventFeed items={feed} running={running} />
            {(result || errorText || stopped) && (
              <ResultPanel result={result} errorText={errorText} stopped={stopped} />
            )}
          </div>
        </div>
      ) : null}

      {/* The maps this deployment already holds, on a public front page. Gone
          the moment a run starts — see the prop's own note.

          `!runId` and not `!runId && !errorText`: a request REFUSED before a
          run existed (the allowance ran out between the page render and the
          click, a domain that names no company) leaves the reader with an error
          panel, and taking the gallery away at the same time would leave them
          with an error panel and nothing else. The maps are the fallback for
          every ending that is not a run. */}
      {!runId && children}
    </div>
  );
}

/**
 * The run's own address, handed over before it is needed.
 *
 * WHY IT IS NOT A LINK WHILE THE RUN IS GOING. `/kb/<id>` is written when the
 * run finishes, so following it mid-run reaches `notFound()` — and a visitor
 * who clicks the link this app just gave them and lands on a 404 has been told
 * something false about their own run. So it is text you can copy while the run
 * is in flight and a link once there is something behind it. The sentence
 * beside it is the part that matters most: the run is a background task on the
 * server and closing the tab does not stop it, which almost nobody assumes.
 *
 * Copy is best-effort. `navigator.clipboard` needs a secure context and can be
 * refused outright, so a failure leaves the button saying what it always said
 * over a path that is selectable anyway, rather than reporting an error about a
 * convenience.
 */
function KeepLink({ runId, ready }: { runId: string; ready: boolean }) {
  const [copied, setCopied] = useState(false);
  const href = `/kb/${runId}`;

  const copy = useCallback(() => {
    const url = typeof window === "undefined" ? href : new URL(href, window.location.origin).href;
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [href]);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-800/70 pt-2.5 text-[11px] text-slate-500">
      <span>{ready ? "Your map:" : "Close the tab if you like — the run keeps going. Your map lands at"}</span>
      {ready ? (
        <a href={href} className="font-mono text-sky-400 hover:text-sky-300">
          {href}
        </a>
      ) : (
        <code className="select-all font-mono text-slate-400">{href}</code>
      )}
      <button
        type="button"
        onClick={copy}
        className="rounded border border-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500 transition hover:border-slate-700 hover:text-slate-300"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

/** Merge a classified batch into what is already on screen without losing
 *  fields an earlier batch supplied. */
function mergeEntities(current: EntityData[], incoming: EntityData[]): EntityData[] {
  const by = new Map(current.map((e) => [e.domain, e]));
  for (const row of incoming) {
    if (!row?.domain) continue;
    by.set(row.domain, { ...by.get(row.domain), ...row });
  }
  return [...by.values()];
}

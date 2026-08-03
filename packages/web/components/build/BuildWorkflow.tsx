"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StatTile } from "@/components/viz";
import { AgentPanel, type AgentChunk } from "./AgentPanel";
import { EventFeed } from "./EventFeed";
import { FindingsPanel, type EntityData } from "./FindingsPanel";
import { SearchesPanel, readSearched, type SearchView } from "./SearchesPanel";
import { PlanCard, UnderstandingCard } from "./PlanCard";
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
 * How thorough, not how many.
 *
 * A query count is an implementation detail, and asking a reader for one asks
 * them to already know that 50 queries is about $0.35 and three minutes. v1 asked
 * for a dollar budget for exactly this reason. Depth goes one step further: the
 * reader picks an intent and sees what it costs, rather than picking a number and
 * discovering what it bought.
 *
 * The numbers are anchored on runs we paid for, and they are ranges because the
 * count below is a starting budget rather than a total: the agent assesses the
 * map after each wave and fires more queries at whatever looks thin, so a run
 * that finds a market with an obvious hole in it costs more than one that does
 * not. Measured anchors, 12 queries → 4½ min and $0.35; 50 queries → $1.26.
 *
 * These were badly stale once. They were written when a query meant one SERP
 * call and a run meant one wave, and they survived both changes unchanged,
 * quietly promising a third of the real bill.
 */
const DEPTHS = [
  { key: "quick", label: "Quick look", queries: 12, about: "~4 min · ~$0.45", note: "enough to see the shape of a market" },
  { key: "standard", label: "Standard", queries: 40, about: "~7 min · ~$0.90", note: "the one to reach for" },
  { key: "deep", label: "Deep", queries: 80, about: "~12 min · ~$1.60", note: "buys corroboration more than breadth" },
] as const;
type DepthKey = (typeof DEPTHS)[number]["key"];
const DEFAULT_DEPTH: DepthKey = "standard";

export function BuildWorkflow() {
  const [input, setInput] = useState("");
  const [depth, setDepth] = useState<DepthKey>(DEFAULT_DEPTH);

  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);

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
    setErrorText(null);
    setRunId(null);
    startedAt.current = Date.now();
    setElapsed(0);
    setRunning(true);

    // `Number("")` is 0, and a sweep of zero queries returns an empty map that
    // reads as a quiet market rather than as an empty field. The API refuses it
    // too; falling back here means the user never has to see that refusal.
    const n = (DEPTHS.find((d) => d.key === depth) ?? DEPTHS[1]).queries;

    let started: { runId: string };
    try {
      const res = await fetch("/api/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: target, queries: n }),
        signal: ctrl.signal,
      });
      const body = (await res.json().catch(() => null)) as
        | { runId?: string; error?: string }
        | null;
      if (!res.ok || !body?.runId) {
        // The API rejects an input that names no company before starting a run,
        // and that message is the useful one, not "HTTP 400".
        setErrorText(body?.error ?? `HTTP ${res.status}`);
        setRunning(false);
        return;
      }
      started = { runId: body.runId };
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setErrorText(err instanceof Error ? err.message : String(err));
      setRunning(false);
      return;
    }

    setRunId(started.runId);
    addFeed("accent", `▶ map ${target} — ${n} queries`);

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
        if (!t.ok) addFeed("amber", `${t.tool} failed: ${t.argsDigest}`);
      },
      ctrl.signal,
      runIsOver,
    ).catch(() => {});
  }, [input, depth, addFeed]);

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
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-400"
            />
          </label>
          <div role="radiogroup" aria-label="How thorough" className="flex gap-1.5">
            {DEPTHS.map((d) => {
              const on = d.key === depth;
              return (
                <button
                  key={d.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setDepth(d.key)}
                  title={d.note}
                  className={`rounded-lg border px-3 py-2 text-left transition ${
                    on
                      ? "border-sky-400 bg-sky-500/10"
                      : "border-slate-700 bg-slate-900 hover:border-slate-600"
                  }`}
                >
                  <span className={`block text-sm ${on ? "text-slate-100" : "text-slate-300"}`}>
                    {d.label}
                  </span>
                  <span className="tnum block font-mono text-[10px] text-slate-500">{d.about}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={startRun}
            disabled={!input.trim() || running}
            className="rounded-lg bg-sky-500 px-5 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "Mapping…" : "Map"}
          </button>
        </div>

        {/* What it costs is stated rather than discovered. $0.0015 is Bright
            Data's SERP rate, and a query is THREE of those, not one — reading
            only the first page of results was leaving most of a market unread
            (7 hosts from page 1 against 37 across five pages on one measured
            query). The model half depends on how much text comes back and
            cannot be promised. */}
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
          a query reads 3 result pages at $0.0015 each · the agent adds waves where the map looks thin
        </p>
      </div>

      {/* ------------------------------------------------------------- spend -- */}
      {runId && (
        <div className="mb-6">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile
              label="spent"
              value={formatUsd(cost?.usd)}
              hint="models + search, so far"
              trend={spendHistory}
            />
            <StatTile label="elapsed" value={formatDuration(elapsed)} hint="wall clock" />
            <StatTile label="serp calls" value={cost?.serpCalls ?? 0} hint="searches bought" />
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
            {(result || errorText) && <ResultPanel result={result} errorText={errorText} />}
          </div>
        </div>
      ) : null}
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

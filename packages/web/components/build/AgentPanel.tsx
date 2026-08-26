"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * What the models actually said, live.
 *
 * THE GAP this fills. A run showed five stage headlines and nothing about how it
 * reached them, the sentence the model wrote about what this company sells, the
 * reason it gave for putting a host on the map. All of that was produced, paid
 * for, and thrown away.
 *
 * port NOTE. v1 fed this panel a genuine token stream from `runAgent`'s
 * writable. This engine calls `generateObject`, which returns a whole object
 * rather than streaming one, so what arrives here is each model call's output,
 * verbatim, as text chunks, not a live reasoning trace. It is the model's own
 * words either way; it is just not word-by-word. Switching the sweep to
 * `streamObject` is what would close that gap.
 *
 * The chunks are AI-SDK-shaped. Only three kinds matter for reading along —
 * text deltas, tool calls, and tool results, and everything else is protocol
 * noise that would drown them, so it is dropped rather than rendered.
 */

export interface AgentChunk {
  type?: string;
  delta?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  /** Who produced it. Restored by lib/stream-adapter.ts off `span.agentId`,
   *  which `readUi` was discarding. Absent on a frame from an older run. */
  agent?: string;
  [k: string]: unknown;
}

interface Entry {
  id: number;
  kind: "text" | "tool" | "result";
  body: string;
  tool?: string;
  agent: string;
}

/** Unattributed frames keep working, under a name that says what they are
 *  rather than guessing which agent they came from. */
const UNKNOWN = "run";

/** One short line for a tool call, because the full input is routinely a whole
 *  document and the point here is to follow the agent, not to re-read the
 *  corpus it is reading. */
export function summarise(v: unknown, max = 130): string {
  if (v == null) return "";
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(v);
  }
}

export function AgentPanel({ chunks }: { chunks: readonly AgentChunk[] }) {
  const [pinned, setPinned] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  const [only, setOnly] = useState<string | null>(null);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    let id = 0;
    for (const c of chunks) {
      const t = String(c.type ?? "");
      const agent = typeof c.agent === "string" && c.agent ? c.agent : UNKNOWN;
      // Consecutive text deltas are one thought, not one line each — a token
      // stream rendered as rows is unreadable.
      //
      // THE SWARM CORRECTION. This used to merge into whatever the previous
      // entry was, full stop. With one agent at a time that was right. With
      // several in flight it welded two different models' answers into one
      // paragraph — `Promise.all` over concurrent calls interleaves their
      // frames, and the join was silent, so the panel read as a single
      // confused voice. Text now merges only into the same agent's own last
      // entry, which is the narrowest rule that still collapses a token
      // stream.
      if (t === "text-delta" || t === "text") {
        const piece = String(c.delta ?? c.text ?? "");
        if (!piece) continue;
        const last = out[out.length - 1];
        if (last?.kind === "text" && last.agent === agent) last.body += piece;
        else out.push({ id: id++, kind: "text", body: piece, agent });
      } else if (t === "tool-input-available" || t === "tool-call") {
        /* Kept, deliberately. Nothing in the repo fed these branches while the
           engine called `generateObject`, and they read as dead code — but
           `packages/core/src/discovery.ts` is a `ToolLoopAgent` with real tool
           definitions, and phase one of the swarm is exactly an agent choosing
           which pages to read. This is the surface that shows it choosing. */
        out.push({
          id: id++,
          kind: "tool",
          tool: String(c.toolName ?? "tool"),
          body: summarise(c.input),
          agent,
        });
      } else if (t === "tool-output-available" || t === "tool-result") {
        out.push({
          id: id++,
          kind: "result",
          tool: String(c.toolName ?? "tool"),
          body: summarise(c.output),
          agent,
        });
      }
    }
    return out;
  }, [chunks]);

  /** Who has spoken, in the order they first spoke. Doubles as the filter row:
   *  with a swarm the useful question is "what is discover doing", and reading
   *  one agent's thread out of five interleaved ones is not a thing eyes do. */
  const agents = useMemo(() => {
    const seen: string[] = [];
    for (const e of entries) if (!seen.includes(e.agent)) seen.push(e.agent);
    return seen;
  }, [entries]);

  const shown = useMemo(
    () => (only ? entries.filter((e) => e.agent === only) : entries),
    [entries, only],
  );

  // A filtered-to agent that stops appearing (a new run, a different phase)
  // must not leave the panel permanently empty with no visible cause.
  useEffect(() => {
    if (only && !agents.includes(only)) setOnly(null);
  }, [only, agents]);

  // Follow the tail, but stop the moment the reader scrolls up, yanking
  // someone back to the bottom while they are reading is worse than not
  // following at all.
  useEffect(() => {
    const el = boxRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
    // `shown`, not `entries`: filtered to one lane, the tail that matters is
    // that lane's tail, and the panel must re-follow when the filter changes.
  }, [shown.length, pinned]);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">
          What the models said
        </h2>
        <div className="flex items-center gap-3">
          {/* The lane picker. Only drawn once more than one agent has actually
              spoken — a single-agent run must not grow a control that filters
              nothing. */}
          {agents.length > 1 && (
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setOnly(null)}
                aria-pressed={only === null}
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                  only === null
                    ? "bg-sky-500/15 text-sky-300"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                all
              </button>
              {agents.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setOnly((cur) => (cur === a ? null : a))}
                  aria-pressed={only === a}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                    only === a
                      ? "bg-sky-500/15 text-sky-300"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          )}
          <span className="tnum font-mono text-[11px] text-slate-500">
            {shown.length} events
          </span>
          <button
            type="button"
            onClick={() => setPinned((p) => !p)}
            className={`font-mono text-[11px] transition-colors ${
              pinned ? "text-sky-400 hover:text-sky-300" : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {pinned ? "following" : "paused"}
          </button>
        </div>
      </header>

      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (atBottom !== pinned) setPinned(atBottom);
        }}
        className="max-h-[26rem] overflow-y-auto px-4 py-3"
      >
        {shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Nothing yet — each model call&rsquo;s answer lands here as it returns.
          </p>
        ) : (
          <ol className="space-y-2.5">
            {shown.map((e, i) => {
              /* The name is printed only when the speaker CHANGES. Stamping it
                 on every line turns a paragraph into a chat log; printing it at
                 the hand-off is what makes an interleaved stream readable. */
              const turn = i === 0 || shown[i - 1].agent !== e.agent;
              return (
                <li key={e.id} className="text-sm leading-relaxed">
                  {turn && agents.length > 1 && (
                    <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                      {e.agent}
                    </div>
                  )}
                  {e.kind === "text" ? (
                    <p className="whitespace-pre-wrap text-slate-300">{e.body}</p>
                  ) : (
                    <p className="font-mono text-xs">
                      <span
                        className={e.kind === "tool" ? "text-sky-400" : "text-emerald-400"}
                      >
                        {e.kind === "tool" ? "→" : "←"} {e.tool}
                      </span>{" "}
                      <span className="text-slate-500">{e.body}</span>
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

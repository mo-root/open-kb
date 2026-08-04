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
function summarise(v: unknown, max = 130): string {
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

  const entries = useMemo(() => {
    const out: Entry[] = [];
    let id = 0;
    for (const c of chunks) {
      const t = String(c.type ?? "");
      // Consecutive text deltas are one thought, not one line each, a token
      // stream rendered as rows is unreadable.
      if (t === "text-delta" || t === "text") {
        const piece = String(c.delta ?? c.text ?? "");
        if (!piece) continue;
        const last = out[out.length - 1];
        if (last?.kind === "text") last.body += piece;
        else out.push({ id: id++, kind: "text", body: piece });
      } else if (t === "tool-input-available" || t === "tool-call") {
        out.push({
          id: id++,
          kind: "tool",
          tool: String(c.toolName ?? "tool"),
          body: summarise(c.input),
        });
      } else if (t === "tool-output-available" || t === "tool-result") {
        out.push({
          id: id++,
          kind: "result",
          tool: String(c.toolName ?? "tool"),
          body: summarise(c.output),
        });
      }
    }
    return out;
  }, [chunks]);

  // Follow the tail, but stop the moment the reader scrolls up, yanking
  // someone back to the bottom while they are reading is worse than not
  // following at all.
  useEffect(() => {
    const el = boxRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [entries.length, pinned]);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">
          What the models said
        </h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-slate-500">
            {entries.length} events
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
        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Nothing yet — each model call&rsquo;s answer lands here as it returns.
          </p>
        ) : (
          <ol className="space-y-2.5">
            {entries.map((e) => (
              <li key={e.id} className="text-sm leading-relaxed">
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
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

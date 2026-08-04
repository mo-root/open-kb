"use client";

import { NodeGlyph } from "@/components/icons";

/* The run's own spend decisions, promoted.
   ---------------------------------------------------------------------------
   The sweep does not fire a fixed catalog and stop. After each wave an agent is
   asked whether the map is done, and it answers in sentences the run writes
   straight to the progress stream:

     enough — 118 hosts (noted gap: …)
     round 2: <what is missing> — 9 more queries queued
     round 2 added only 3 — stopping, further queries are buying corroboration

   These are the most consequential lines the product produces. They are the
   moment it decides to spend more of your money, or not to. And they were
   arriving under `agent: "plan"`, which `stageOf` maps to the Plan stage —
   which by then is `done`, so `BuildWorkflow` filed them into `chips` and
   `StageTracker` drew them as small grey chips underneath a stage the reader
   has already watched close.

   The decision to buy another wave was rendered as history of a finished step.
   Here it is instead: above the fold, in the highlight pink reserved for the
   things that matter, newest first, with the clock reading a reader can check
   against the meter.

   Nothing is reworded. These are the run's own strings — a paraphrase here
   would be this surface claiming to know why the agent decided what it did. */

export interface Decision {
  id: number;
  text: string;
  atSec?: number;
}

function clock(atSec: number): string {
  const m = Math.floor(atSec / 60);
  const s = atSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function DecisionsStrip({ decisions }: { decisions: readonly Decision[] }) {
  if (decisions.length === 0) return null;

  // Newest first: the live question is always "what did it just decide", and a
  // strip that grows downward pushes that answer off the bottom of a long run.
  const rows = [...decisions].reverse();

  return (
    <section className="mb-6 rounded-lg border border-[color-mix(in_srgb,var(--highlight)_35%,transparent)] bg-[color-mix(in_srgb,var(--highlight)_6%,transparent)] p-4">
      <div className="mb-2 flex items-center gap-2">
        <NodeGlyph
          kind="signal"
          size={13}
          className="shrink-0"
          style={{ color: "var(--highlight)" }}
        />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-300">
          What it decided to buy
        </h2>
        <span className="tnum ml-auto font-mono text-[11px] text-slate-500">
          {decisions.length}
        </span>
      </div>
      <ol className="space-y-1.5">
        {rows.map((d) => (
          <li key={d.id} className="flex min-w-0 gap-2.5 text-[13px] leading-snug">
            {d.atSec !== undefined && (
              <span className="tnum shrink-0 font-mono text-[11px] leading-5 text-slate-500">
                {clock(d.atSec)}
              </span>
            )}
            <span className="min-w-0 break-words text-slate-200">{d.text}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2.5 text-[11px] leading-snug text-slate-500">
        After each wave the run asks whether the map is still growing. Every line
        here is that answer, in its own words — the point where it chose to spend
        more, or to stop.
      </p>
    </section>
  );
}

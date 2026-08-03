import {
  STAGES,
  STAGE_BLURB,
  STAGE_LABELS,
  type Stage,
  type StageState,
} from "./types";

/* The run's spine. Ported from public-kb's StageTracker, same numbered
   markers, same connecting rule, same chip row — widened to this engine's nine
   stages and given the one thing the old rail lacked: a sentence under the
   ACTIVE stage saying what it is doing. "Sweep" on its own tells a reader
   nothing about where their money is going. */

function Marker({ state, index }: { state: StageState; index: number }) {
  const num = String(index + 1).padStart(2, "0");
  if (state === "done") {
    return (
      <span className="tnum flex h-5 w-6 items-center justify-center rounded border border-emerald-500/40 bg-emerald-500/10 font-mono text-[9px] text-emerald-400">
        {num}
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className="relative flex h-5 w-6 items-center justify-center">
        <span className="absolute inset-0 animate-pulse rounded bg-sky-400/20" />
        <span className="tnum relative rounded border border-sky-400/70 px-1 font-mono text-[9px] text-sky-300">
          {num}
        </span>
      </span>
    );
  }
  return (
    <span className="tnum flex h-5 w-6 items-center justify-center rounded border border-slate-800 font-mono text-[9px] text-slate-600">
      {num}
    </span>
  );
}

export function StageTracker({
  states,
  messages = {},
  chips = {},
}: {
  states: Record<Stage, StageState>;
  /** The latest progress line for a stage, shown while it is active. */
  messages?: Partial<Record<Stage, string>>;
  /** What the stage produced, once it is done. */
  chips?: Partial<Record<Stage, string[]>>;
}) {
  return (
    <ol className="relative space-y-1">
      {STAGES.map((stage, i) => {
        const state = states[stage];
        const stageChips = chips[stage] ?? [];
        return (
          <li key={stage} className="relative flex gap-3 pb-4">
            {i < STAGES.length - 1 && (
              <span
                // 20px, not 8px. The rule starts 24px down and the next marker
                // begins 4px past this item, so `100%-8px` ran 12px into a 20px
                // badge, and being absolute over static markers, it painted a
                // hairline straight through the 02/03/04 digits.
                className={`absolute left-[11px] top-6 h-[calc(100%-20px)] w-px ${
                  state === "done" ? "bg-emerald-500/30" : "bg-slate-800"
                }`}
              />
            )}
            <Marker state={state} index={i} />
            <div className="min-w-0 flex-1">
              <div
                className={`text-sm font-medium ${
                  state === "pending"
                    ? "text-slate-600"
                    : state === "active"
                      ? "text-sky-300"
                      : "text-slate-200"
                }`}
              >
                {STAGE_LABELS[stage]}
              </div>
              {state === "active" && (
                <div className="mt-0.5 text-[11px] leading-snug text-slate-500">
                  {STAGE_BLURB[stage]}
                </div>
              )}
              {state === "active" && messages[stage] && (
                <div className="tnum mt-1 break-words text-[11px] text-sky-400/90">
                  {messages[stage]}
                </div>
              )}
              {stageChips.length > 0 && state !== "pending" && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {stageChips.map((c, j) => (
                    <span
                      key={j}
                      className="tnum rounded border border-slate-700 bg-slate-800/50 px-1.5 py-0.5 text-[11px] text-slate-300"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

"use client";

import {
  DEFAULT_SETTINGS,
  RANGES,
  type GraphSettings as Settings,
} from "@/lib/graph/settings";

/* The graph's control panel.
   ---------------------------------------------------------------------------
   There is no single right tuning for a force graph. A 60-node map and a
   680-node map want different repulsion; how much text belongs on screen is
   taste. Every one of these was a constant compiled into the canvas, so the
   only way to disagree with a choice was to edit the source.

   Grouped the way the reader thinks rather than the way the code is organised:
   DISPLAY is what things look like, FORCES is how they arrange themselves. The
   numbers read out beside each slider because "repel force 2.35" is a setting
   someone can reproduce, and an unlabelled handle is not.

   Multipliers throughout, so 1.00 is always "as designed" and the reset button
   has an obvious meaning. */

function Slider({
  label,
  value,
  onChange,
  range,
  format = (v: number) => v.toFixed(2),
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  range: { min: number; max: number; step: number };
  format?: (v: number) => string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-slate-300">{label}</span>
        <span className="tnum font-mono text-[10px] text-slate-500">{format(value)}</span>
      </span>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        title={hint}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-full bg-slate-800 accent-sky-400"
      />
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
        {title}
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

export function GraphSettingsPanel({
  settings,
  onChange,
  onReheat,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
  /** Re-run the layout from the current positions — Obsidian's "Animate". */
  onReheat: () => void;
}) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <div className="w-60 rounded-md border border-slate-800 bg-slate-950/90 p-3 shadow-lg backdrop-blur">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
          Display &amp; forces
        </span>
        <button
          type="button"
          onClick={() => onChange(DEFAULT_SETTINGS)}
          className="font-mono text-[10px] uppercase tracking-wider text-slate-500 transition-colors hover:text-sky-300"
          title="Back to the tuned defaults"
        >
          reset
        </button>
      </div>

      <div className="space-y-4">
        <Section title="Display">
          <Slider
            label="Node size"
            value={settings.nodeScale}
            range={RANGES.nodeScale}
            onChange={(v) => set("nodeScale", v)}
            hint="Scales every node. Collision scales with it, so bigger nodes claim more room rather than overlapping."
          />
          <Slider
            label="Link thickness"
            value={settings.linkWidth}
            range={RANGES.linkWidth}
            onChange={(v) => set("linkWidth", v)}
          />
          <Slider
            label="Text size"
            value={settings.labelPx}
            range={RANGES.labelPx}
            format={(v) => `${v}px`}
            onChange={(v) => set("labelPx", v)}
          />
          <Slider
            label="Text fade threshold"
            value={settings.labelThreshold}
            range={RANGES.labelThreshold}
            format={(v) => v.toFixed(0)}
            onChange={(v) => set("labelThreshold", v)}
            hint="How big a node must be on screen before it names itself. Higher = labels appear only as you zoom in. 0 shows every label at every zoom."
          />
          <label className="flex items-center justify-between">
            <span className="text-[11px] text-slate-300">Arrows</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.arrows}
              onClick={() => set("arrows", !settings.arrows)}
              title="Draw the direction of each relation. Off by default — hundreds of arrowheads read as texture, not information."
              className={`relative h-4 w-8 rounded-full transition-colors ${
                settings.arrows ? "bg-sky-500" : "bg-slate-700"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                  settings.arrows ? "translate-x-4.5" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
        </Section>

        <Section title="Forces">
          <Slider
            label="Center force"
            value={settings.centerForce}
            range={RANGES.centerForce}
            onChange={(v) => set("centerForce", v)}
            hint="How hard the map is held together. Lower lets the lobes drift apart; 0 lets them float free."
          />
          <Slider
            label="Repel force"
            value={settings.repelForce}
            range={RANGES.repelForce}
            onChange={(v) => set("repelForce", v)}
            hint="How hard nodes push each other away. The main dial for how spread out the map is."
          />
          <Slider
            label="Link force"
            value={settings.linkForce}
            range={RANGES.linkForce}
            onChange={(v) => set("linkForce", v)}
            hint="How strongly a relation pulls two entities together."
          />
          <Slider
            label="Link distance"
            value={settings.linkDistance}
            range={RANGES.linkDistance}
            onChange={(v) => set("linkDistance", v)}
            hint="How long the springs are. Raise it to open up crowded market lobes."
          />
          <button
            type="button"
            onClick={onReheat}
            className="w-full rounded border border-slate-700 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-400 transition-colors hover:border-sky-500/50 hover:text-sky-300"
          >
            Animate
          </button>
        </Section>
      </div>
    </div>
  );
}

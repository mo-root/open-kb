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

function Toggle({
  label,
  on,
  onChange,
  hint,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-slate-300">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        title={hint}
        onClick={() => onChange(!on)}
        className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${
          on ? "bg-sky-500" : "bg-slate-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
            on ? "translate-x-4.5" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}

/* Three named starting points, because dialling a dozen controls to reach a
   look you can describe in one word is a chore. They write the same settings
   any hand could; nothing here is hidden or unreachable by the sliders.
   Exported so a test can check every numeric field a preset sets actually
   falls inside the slider range that field owns in lib/graph/settings.ts —
   nothing but `Partial<Settings>` ties this table to RANGES today, so a
   preset edited to a value outside its own slider's bounds would compile
   clean and only show up as a control with its thumb off the track. */
export const PRESETS: { key: string; label: string; hint: string; patch: Partial<Settings> }[] = [
  {
    key: "quiet",
    label: "Quiet",
    hint: "Obsidian's restraint in our palette: colour and size carry the meaning, nothing else competes.",
    patch: {
      typeRings: false,
      glow: false,
      linkOpacity: 0.06,
      linkWidth: 0.8,
      labelThreshold: 11,
      nodeSpacing: 1,
      linkCurve: 0,
    },
  },
  {
    key: "airy",
    label: "Airy",
    hint: "The same map with room to breathe: smaller marks, wider spacing, edges down to a whisper and a slight bow so the anchor's fan reads as separate threads.",
    patch: {
      typeRings: false,
      glow: false,
      nodeScale: 0.85,
      nodeSpacing: 1.7,
      linkOpacity: 0.05,
      linkWidth: 0.7,
      linkCurve: 0.14,
      labelThreshold: 13,
      repelForce: 1.3,
    },
  },
  {
    key: "detailed",
    label: "Detailed",
    hint: "Every encoding on — rings, glow, stronger edges, names earlier.",
    patch: {
      typeRings: true,
      glow: true,
      nodeScale: 1,
      nodeSpacing: 1,
      linkOpacity: 0.22,
      linkWidth: 1.2,
      linkCurve: 0,
      labelThreshold: 6,
    },
  },
];

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
    <div className="w-full rounded-md border border-slate-800 bg-slate-950/90 p-3 shadow-lg backdrop-blur">
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

      <div className="mb-3 flex gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            title={p.hint}
            onClick={() => onChange({ ...settings, ...p.patch })}
            className="flex-1 rounded border border-slate-800 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-400 transition-colors hover:border-sky-500/50 hover:text-sky-300"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        <Section title="Marks">
          <Toggle
            label="Colour by type"
            on={settings.colorByType}
            onChange={(v) => set("colorByType", v)}
            hint="Off: one neutral ink for every node, so size alone carries the meaning — Obsidian's approach, in our palette."
          />
          <Toggle
            label="Favicons"
            on={settings.showIcons}
            onChange={(v) => set("showIcons", v)}
            hint="Each site's own mark, drawn once the node is big enough on screen."
          />
          <Toggle
            label="Type rings"
            on={settings.typeRings}
            onChange={(v) => set("typeRings", v)}
            hint="A coloured rim around the favicon. Adds no information the fill does not already carry."
          />
          <Toggle
            label="Glow"
            on={settings.glow}
            onChange={(v) => set("glow", v)}
            hint="Cyan bloom on the hovered node and its edges."
          />
          <Toggle
            label="Labels grow with zoom"
            on={settings.labelsScaleWithZoom}
            onChange={(v) => set("labelsScaleWithZoom", v)}
            hint="On: zooming in makes names bigger, like Obsidian. Off: names stay one size and more of them appear."
          />
        </Section>

        {/* Hover was doing a click's job — see settings.ts. Its own section,
            because "what happens when I move the mouse" is the first thing
            anyone wants back under their control. */}
        <Section title="Hover">
          <Toggle
            label="Hover card"
            on={settings.hoverCard}
            onChange={(v) => set("hoverCard", v)}
            hint="Rest the pointer on a node and its card appears — kind, relation, placement, neighbours. Click still pins it."
          />
          <Toggle
            label="Hover dims the map"
            on={settings.hoverDims}
            onChange={(v) => set("hoverDims", v)}
            hint="Obsidian's focus-on-hover: everything that is not a neighbour recedes. Off by default — the pointer crosses dozens of nodes on the way anywhere, so the whole map strobes while you are simply moving your hand. Clicking still dims."
          />
        </Section>

        <Section title="Display">
          <label className="block">
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-slate-300">Size by</span>
            </span>
            <div
              role="radiogroup"
              aria-label="Size nodes by"
              className="mt-1 flex overflow-hidden rounded-md border border-slate-800"
            >
              {(
                [
                  {
                    key: "prominence" as const,
                    label: "Prominence",
                    hint: "How often the market's own searches returned this host, and how well it ranked. A count the run made, not a judgement.",
                  },
                  {
                    key: "placement" as const,
                    label: "Placement",
                    hint: "How firmly the classifier placed this against the anchor — competitor outranks covers.",
                  },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  role="radio"
                  aria-checked={settings.sizeBy === opt.key}
                  title={opt.hint}
                  onClick={() => set("sizeBy", opt.key)}
                  className={`flex-1 px-2 py-1 text-[11px] transition-colors ${
                    settings.sizeBy === opt.key
                      ? "bg-sky-500/20 text-sky-300"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </label>
          <Slider
            label="Node size"
            value={settings.nodeScale}
            range={RANGES.nodeScale}
            onChange={(v) => set("nodeScale", v)}
            hint="Scales every node. Collision scales with it, so bigger nodes claim more room rather than overlapping."
          />
          <Slider
            label="Link opacity"
            value={settings.linkOpacity}
            range={RANGES.linkOpacity}
            onChange={(v) => set("linkOpacity", v)}
            hint="How present the edges are at rest. Low reads as a hairline mesh; high makes the wiring the subject."
          />
          <Slider
            label="Link thickness"
            value={settings.linkWidth}
            range={RANGES.linkWidth}
            onChange={(v) => set("linkWidth", v)}
          />
          <Slider
            label="Link curve"
            value={settings.linkCurve}
            range={RANGES.linkCurve}
            onChange={(v) => set("linkCurve", v)}
            hint="Bow in the edges. Straight is the honest reading of a relation; a little curve fans the anchor's edges apart instead of stacking them into one block of ink."
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
          <Slider
            label="Node spacing"
            value={settings.nodeSpacing}
            range={RANGES.nodeSpacing}
            onChange={(v) => set("nodeSpacing", v)}
            hint="The air dial. Collision is the only force with a hard floor on how close two nodes may sit, so this is what decides whether a crowded lobe reads as distinct sites or as one filled disc."
          />
        </Section>

        {/* The lobe forces get their own section because they answer a
            different question from the ones above: not "where does this node
            go" but "which group is it part of, and where does the GROUP go". */}
        <Section title="Lobes">
          <Slider
            label="Cluster pull"
            value={settings.clusterPull}
            range={RANGES.clusterPull}
            onChange={(v) => set("clusterPull", v)}
            hint="How tightly each market draws itself into a rosette. A node's lobe is the fan it hangs off — the biggest thing it is attached to. 0 lets the springs alone decide."
          />
          <Slider
            label="Cluster spacing"
            value={settings.clusterSpacing}
            range={RANGES.clusterSpacing}
            onChange={(v) => set("clusterSpacing", v)}
            hint="Clear space demanded between two lobes. The only force that knows a lobe exists as a thing rather than as a set of nodes — node collision is perfectly happy to let two whole markets interleave. 0 lets them sit on each other."
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

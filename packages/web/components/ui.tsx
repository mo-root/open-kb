import React from "react";
import { TYPE_COLOR, type NodeType } from "@/lib/nodeTypes";

/* The shared chip vocabulary, ported from v1's components/ui.tsx.
   `Chip` for a neutral tag, `KindChip` for a classified entity, and — since the
   KB-browsing pages landed — v1's `SectionHead`, `MicroHead`, `TypeChip` and
   `RelevanceBadge` alongside them.

   PORT NOTE. v1's copy of this file carried a LOCAL `TYPE_COLOR` map with a
   "reconcile when lib/nodeTypes.ts lands" note on it. It has landed, so the
   palette is imported rather than copied: `ui.tsx`, `icons/NodeGlyph.tsx` and
   the graph all read the one map, and the hexes in it stay identical to
   globals.css's `--type-*` tokens. */

// Entity-kind -> chip tone. The same kind wears the same hue everywhere:
// companies and products take the blue action ramp, communities the lavender,
// publishers and directories the muted slate. Cyan (emerald) is reserved for
// data-flow, rose for genuine alerts, so neither appears here.
//
// Hand-copied from `JUDGED_KINDS` (`@open-kb/core/judge`), which has SEVEN
// members — this listed six, missing `unknown`. `onMap()`
// (packages/sweep/src/sweep.ts) filters `kind === "noise"` out before any
// entity reaches a live build stream or a kept KB page (`FindingsPanel.tsx`'s
// `entities`, `NoteView.tsx`'s `note.kind`, `ProductsTab.tsx`'s `pl.kind` all
// read post-filter), so `noise` above is already dead but harmless. `unknown`
// is NOT filtered — `onMap`'s own doc comment says so ("NOT unknown, which is
// the other empty-looking relation and stays") — so a kept `unknown` entity
// fell through `KindChip`'s `?? "text-slate-300 border-slate-600/50
// bg-slate-700/30"` fallback to the exact tone already worn by `publisher`/
// `directory`, indistinguishable from a directory listing on the one chip
// that exists to say what kind of thing this is. Same shape of gap as
// SELF-105's `FAMILY_TONE`, B3's `RELATION_ORDER` and SELF-106's
// `KIND_COLOR`. Exported and pinned by ui.test.tsx against the real union.
export const KIND_TONES: Record<string, string> = {
  company: "text-amber-300 border-amber-500/40 bg-amber-500/10",
  product: "text-sky-300 border-sky-500/40 bg-sky-500/10",
  community: "text-violet-300 border-violet-400/40 bg-violet-400/10",
  publisher: "text-slate-300 border-slate-600/50 bg-slate-700/30",
  directory: "text-slate-300 border-slate-600/50 bg-slate-700/30",
  noise: "text-slate-500 border-slate-700/50 bg-slate-800/30",
  unknown: "text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-500/10",
};

export function KindChip({ kind }: { kind: string }) {
  const tone =
    KIND_TONES[kind.toLowerCase().trim()] ?? "text-slate-300 border-slate-600/50 bg-slate-700/30";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {kind}
    </span>
  );
}

// Evidence tier -> badge tone. The provenance ladder (own-page > page >
// snippet) drawn as a brightness ladder on the one action hue: own-page wears
// the strongest ink, page a fainter wash of the same blue, snippet drops to
// neutral slate — the lightest thing on the row, exactly as light as its
// evidence. All classes stay inside the theme-re-keyed ramp steps (200-500 +
// the slate chrome), the same theme-safety rule NoteView's amber downgrade
// box documents. A tier this map has never heard of falls back to neutral
// rather than being dropped: the run asserted it, so the reader shows it.
const TIER_TONES: Record<string, string> = {
  "own-page": "text-sky-300 border-sky-400/60 bg-sky-500/15",
  page: "text-sky-300/90 border-sky-500/30 bg-sky-500/5",
  snippet: "text-slate-400 border-slate-700/60 bg-slate-800/30",
};

/** Where an entity's best evidence came from (swarm runs). The caller passes
 *  the gloss (viewTypes' TIER_BLURB) so the words stay defined in one place. */
export function TierBadge({ tier, title }: { tier: string; title?: string }) {
  const tone =
    TIER_TONES[tier.toLowerCase().trim()] ?? "text-slate-300 border-slate-600/50 bg-slate-700/30";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${tone}`}
    >
      <span className="text-[9px] uppercase tracking-wider opacity-70">evidence</span>
      {tier}
    </span>
  );
}

export function Chip({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "sky" | "amber" | "emerald" | "rose";
}) {
  const tones: Record<string, string> = {
    slate: "text-slate-300 border-slate-700 bg-slate-800/50",
    sky: "text-sky-300 border-sky-500/30 bg-sky-500/10",
    amber: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    emerald: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    rose: "text-rose-300 border-rose-500/30 bg-rose-500/10",
  };
  return (
    <span
      className={`tnum inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Console section header (level A): the top rank inside a KB tab —
 * "Products" / "Ecosystem".
 */
export function SectionHead({
  title,
  count,
  blurb,
}: {
  title: string;
  count?: number;
  blurb?: string;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-200">
        {title}
        {count !== undefined && (
          <span className="tnum ml-2 font-normal text-slate-500">{count}</span>
        )}
      </h2>
      {blurb && <p className="mt-0.5 text-[11px] text-slate-500">{blurb}</p>}
    </div>
  );
}

/**
 * Console micro header (level B): platform / day / group labels inside a
 * section, one rank, one style, everywhere.
 */
export function MicroHead({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-slate-500">
      {title}
      {count !== undefined && (
        <span className="tnum ml-2 text-slate-500">{count}</span>
      )}
    </h3>
  );
}

/**
 * A related entity rendered as a chip tinted by its node type. `dead` marks a
 * target with nothing behind it (rendered muted, non-interactive), in v1 an
 * unresolved wikilink, here an entity the map named but never placed.
 */
export function TypeChip({
  type,
  label,
  onClick,
  dead,
  title,
}: {
  type: NodeType;
  label: string;
  onClick?: () => void;
  dead?: boolean;
  title?: string;
}) {
  const color = TYPE_COLOR[type];
  const style: React.CSSProperties = dead
    ? {}
    : {
        color,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
      };
  const cls =
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition";
  if (dead || !onClick) {
    return (
      <span
        className={`${cls} border-slate-700 bg-slate-800/40 text-slate-500`}
        title={title ?? (dead ? "unresolved link" : undefined)}
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`${cls} hover:brightness-125`}
      style={style}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </button>
  );
}

export function relevanceTone(n: number): string {
  // Blue-only tiers: cyan (emerald ramp) is reserved for data-flow and both the
  // old -400 steps failed AA on paper. sky-300 is the tuned paper link tone
  // (~5:1 light / legible on navy dark); high vs mid read apart via border/fill
  // strength, not an unsanctioned hue.
  if (n >= 85) return "text-sky-300 border-sky-500/40 bg-sky-500/15";
  if (n >= 60) return "text-sky-300 border-sky-500/25 bg-sky-500/10";
  return "text-slate-400 border-slate-600/40 bg-slate-700/20";
}

/**
 * port NOTE, v1 called this "rel", short for relevance, and its number was
 * measured during the build. This engine measures no such thing: the number is
 * a placement rank derived from the relation the classifier assigned (see
 * lib/kb-from-run.ts's RELATION_WEIGHT). The badge therefore says "place", and
 * the tooltip says what it is. The component name and the `relevance` field
 * keep v1's spelling because they are the contract every KB surface is written
 * against; the word a reader sees does not.
 */
export function RelevanceBadge({ value }: { value: number }) {
  return (
    <span
      className={`tnum inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${relevanceTone(
        value,
      )}`}
      title={`placement ${Math.round(
        value,
      )} — how firmly the classifier placed this against the anchor, not a measured relevance`}
    >
      <span className="opacity-60">place</span>
      {Math.round(value)}
    </span>
  );
}

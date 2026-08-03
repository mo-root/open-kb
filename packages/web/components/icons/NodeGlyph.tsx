// NodeGlyph — the bureau's icon system. One ultra-light SVG glyph per semantic
// note type, drawn like drafting-instrument marks: 24x24 viewBox, thin strokes
// (1.4, auto-bumped at small sizes so marks survive 1x displays), stroke =
// currentColor so callers pick the colour via the node-type palette. No fills
// except tiny accent dots (radar blips, window lights, speech dots) — the
// dots grow proportionally at small sizes so they never render sub-pixel.
//
// Usage:
//   <NodeGlyph kind="player" size={16} className="text-rose-400" />
//   glyphForNotePath("players/apify-com.md") // -> "player"

import type { ReactNode, SVGProps } from "react";
import type { NodeType } from "@/lib/nodeTypes";

export type GlyphKind =
  | "product" // stacked layers / package
  | "player" // diamond marker — a rival plotted on the map
  | "community" // three linked nodes
  | "person" // head + shoulders (people.md)
  | "hiring" // briefcase
  | "signal" // broadcast wave from a point
  | "topic" // concentric radar rings with a blip
  | "competitor" // crosshair
  | "opportunity" // four-point spark
  | "docs" // page with fold + text lines
  | "presence" // speech bubble
  | "channels" // broadcast tower, waves both sides
  | "company" // building / hub
  | "alert"; // survey triangle + stem + dot — warnings, violations

export const GLYPH_KINDS: readonly GlyphKind[] = [
  "product",
  "player",
  "community",
  "person",
  "hiring",
  "signal",
  "topic",
  "competitor",
  "opportunity",
  "docs",
  "presence",
  "channels",
  "company",
  "alert",
];

/** Node type -> its bureau glyph. Core is the hub — the company building.
 *  Shared by the composition bar, the graph legend and any future consumer
 *  so all surfaces draw the same mark for the same type. */
export const TYPE_GLYPH: Record<NodeType, GlyphKind> = {
  core: "company",
  product: "product",
  player: "player",
  community: "community",
};

/* Inner marks per kind, as functions of the accent-dot scale `dot` (1 at
   full size; >1 at small sizes so dots stay visible). Everything inherits
   stroke/width/caps from the <svg>; accent dots opt out with
   fill="currentColor" stroke="none". */
const GLYPHS: Record<GlyphKind, (dot: number) => ReactNode> = {
  // Stacked layers: top face + two chevrons beneath.
  product: () => (
    <>
      <path d="M12 3.5 20 8 12 12.5 4 8 Z" />
      <path d="M4 11.8 12 16.3 20 11.8" />
      <path d="M4 15.4 12 19.9 20 15.4" />
    </>
  ),

  // Diamond survey marker with a plotted centre point.
  player: (dot) => (
    <>
      <path d="M12 3.2 20.8 12 12 20.8 3.2 12 Z" />
      <circle cx="12" cy="12" r={1.2 * dot} fill="currentColor" stroke="none" />
    </>
  ),

  // Three nodes, linked; connectors trimmed clear of the rings.
  community: () => (
    <>
      <circle cx="12" cy="5.5" r="2.2" />
      <circle cx="5.5" cy="17" r="2.2" />
      <circle cx="18.5" cy="17" r="2.2" />
      <path d="M10.57 8.02 6.93 14.48" />
      <path d="M13.43 8.02 17.07 14.48" />
      <path d="M8.4 17 H15.6" />
    </>
  ),

  // Head + shoulders.
  person: () => (
    <>
      <circle cx="12" cy="8.2" r="3.4" />
      <path d="M5.2 19.8 a6.8 6.8 0 0 1 13.6 0" />
    </>
  ),

  // Briefcase: case, handle, seam, clasp dot.
  hiring: (dot) => (
    <>
      <rect x="4.5" y="8" width="15" height="11.5" rx="2" />
      <path d="M9.3 8 V6.8 a1.8 1.8 0 0 1 1.8 -1.8 h1.8 a1.8 1.8 0 0 1 1.8 1.8 V8" />
      <path d="M4.5 12.8 H19.5" />
      <circle cx="12" cy="12.8" r={1 * dot} fill="currentColor" stroke="none" />
    </>
  ),

  // A source point broadcasting rightward — three widening arcs.
  signal: (dot) => (
    <>
      <circle cx="5.5" cy="12" r={1.3 * dot} fill="currentColor" stroke="none" />
      <path d="M8.33 9.17 A4 4 0 0 1 8.33 14.83" />
      <path d="M10.45 7.05 A7 7 0 0 1 10.45 16.95" />
      <path d="M12.57 4.93 A10 10 0 0 1 12.57 19.07" />
    </>
  ),

  // Concentric radar rings, centre point, one blip in the outer band.
  topic: (dot) => (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r={1.2 * dot} fill="currentColor" stroke="none" />
      <circle cx="16.6" cy="7.4" r={1 * dot} fill="currentColor" stroke="none" />
    </>
  ),

  // Crosshair: ring, four ticks crossing it, centre point.
  competitor: (dot) => (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 3 V7" />
      <path d="M12 17 V21" />
      <path d="M3 12 H7" />
      <path d="M17 12 H21" />
      <circle cx="12" cy="12" r={1.2 * dot} fill="currentColor" stroke="none" />
    </>
  ),

  // Four-point spark with a stray glint.
  opportunity: (dot) => (
    <>
      <path d="M12 3 C12.75 7.9 15.1 10.25 20 12 C15.1 13.75 12.75 16.1 12 21 C11.25 16.1 8.9 13.75 4 12 C8.9 10.25 11.25 7.9 12 3 Z" />
      <circle cx="18.6" cy="5.4" r={0.9 * dot} fill="currentColor" stroke="none" />
    </>
  ),

  // Page with folded corner and rule lines.
  docs: () => (
    <>
      <path d="M14 3.5 H7.5 A2 2 0 0 0 5.5 5.5 V18.5 A2 2 0 0 0 7.5 20.5 H16.5 A2 2 0 0 0 18.5 18.5 V8 Z" />
      <path d="M14 3.5 V8 H18.5" />
      <path d="M9 9.8 H11" />
      <path d="M9 13 H15" />
      <path d="M9 16.3 H15" />
    </>
  ),

  // Speech bubble with three dots.
  presence: (dot) => (
    <>
      <path d="M7.5 16.2 A3 3 0 0 1 4.5 13.2 V8 A3 3 0 0 1 7.5 5 H16.5 A3 3 0 0 1 19.5 8 V13.2 A3 3 0 0 1 16.5 16.2 H11 L7.5 19.4 Z" />
      <circle cx="9.2" cy="10.6" r={1 * dot} fill="currentColor" stroke="none" />
      <circle cx="12" cy="10.6" r={1 * dot} fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="10.6" r={1 * dot} fill="currentColor" stroke="none" />
    </>
  ),

  // Broadcast tower: emitter dot, waves both sides, legs + crossbar.
  channels: (dot) => (
    <>
      <circle cx="12" cy="7.5" r={1.3 * dot} fill="currentColor" stroke="none" />
      <path d="M9.53 5.03 A3.5 3.5 0 0 0 9.53 9.97" />
      <path d="M14.47 5.03 A3.5 3.5 0 0 1 14.47 9.97" />
      <path d="M7.76 3.26 A6 6 0 0 0 7.76 11.74" />
      <path d="M16.24 3.26 A6 6 0 0 1 16.24 11.74" />
      <path d="M9.5 20.5 12 9.4" />
      <path d="M14.5 20.5 12 9.4" />
      <path d="M10.6 15.6 H13.4" />
    </>
  ),

  // Building on a ground line: facade, door arch, window lights.
  company: (dot) => (
    <>
      <path d="M6.5 20.5 V5.2 A1.7 1.7 0 0 1 8.2 3.5 H15.8 A1.7 1.7 0 0 1 17.5 5.2 V20.5" />
      <path d="M4 20.5 H20" />
      <path d="M10.6 20.5 V17.5 a1.4 1.4 0 0 1 2.8 0 V20.5" />
      <circle cx="9.8" cy="7.6" r={0.95 * dot} fill="currentColor" stroke="none" />
      <circle cx="14.2" cy="7.6" r={0.95 * dot} fill="currentColor" stroke="none" />
      <circle cx="9.8" cy="11.6" r={0.95 * dot} fill="currentColor" stroke="none" />
      <circle cx="14.2" cy="11.6" r={0.95 * dot} fill="currentColor" stroke="none" />
    </>
  ),

  // Survey triangle with stem + dot — the bureau's warning mark.
  alert: (dot) => (
    <>
      <path d="M12 4 20.7 19.6 H3.3 Z" />
      <path d="M12 9.8 V14.4" />
      <circle cx="12" cy="17.2" r={1.1 * dot} fill="currentColor" stroke="none" />
    </>
  ),
};

export interface NodeGlyphProps
  extends Omit<SVGProps<SVGSVGElement>, "children"> {
  kind: GlyphKind;
  /** Rendered width & height in px. Default 16. */
  size?: number;
  /** Stroke weight in viewBox units. Default auto: 1.4, bumped to 1.9 at
   *  sizes <= 13px so hairlines don't dissolve on 1x displays. */
  strokeWidth?: number;
  /** Accessible name. Omitted -> decorative (aria-hidden). */
  title?: string;
}

export default function NodeGlyph({
  kind,
  size = 16,
  strokeWidth,
  title,
  ...rest
}: NodeGlyphProps) {
  // At <=13px a 1.4 viewBox stroke renders under 0.8px and the accent dots
  // under a pixel — thicken strokes and grow dots so the mark stays crisp.
  const small = size <= 13;
  const sw = strokeWidth ?? (small ? 1.9 : 1.4);
  const dot = small ? 1.5 : 1;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {GLYPHS[kind](dot)}
    </svg>
  );
}

/* ---- path -> glyph mapping ------------------------------------------------
   Mirrors the KB folder shape (see lib/nodeTypes.ts for the colour side):
   top-level folders first, then well-known root notes, "docs" as fallback. */

const ROOT_NOTE_GLYPHS: Record<string, GlyphKind> = {
  "people.md": "person",
  "hiring.md": "hiring",
  "company.md": "company",
  "home.md": "company",
  "channels.md": "channels",
  "presence.md": "presence",
  "socials.md": "presence", // older name for presence.md
  "competitors.md": "competitor",
  "opportunities.md": "opportunity",
  "topics.md": "topic",
  "ecosystem.md": "topic",
  "docs-map.md": "docs",
  "sources.md": "docs",
};

/** Map a KB note path (e.g. "players/apify-com.md", "people.md") to its glyph. */
export function glyphForNotePath(path: string): GlyphKind {
  const p = path.toLowerCase().replace(/^\.?\//, "");
  const top = p.split("/")[0];
  if (top === "products") return "product";
  if (top === "players") return "player";
  if (top === "communities") return "community";
  if (top === "signals") return "signal";
  if (top === "docs" || top === "raw") return "docs";
  const base = p.split("/").pop() ?? p;
  return ROOT_NOTE_GLYPHS[base] ?? "docs";
}

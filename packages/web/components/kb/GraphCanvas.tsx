"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import dynamic from "next/dynamic";
import { forceCollide, forceX, forceY } from "d3-force";
import { RELATION_BLURB, type GraphView } from "@/lib/viewTypes";
import { NodeGlyph, TYPE_GLYPH } from "@/components/icons";
import {
  groupLabel,
  nodeTypeOf,
  TYPE_COLOR,
  TYPE_CSS,
  TYPE_ICON,
  TYPE_LABEL,
  TYPE_ORDER,
  type NodeType,
} from "@/lib/nodeTypes";
import {
  ALPHA_DECAY,
  ALPHA_MIN,
  VELOCITY_DECAY,
  chargeDistanceMax,
  chargeStrength,
  cooldownTicks,
  isHubDegree,
  linkDistance,
  linkStrength,
  seedPosition,
  tetherAspect,
  tetherStrength,
  warmupTicks,
} from "@/lib/graph/layout";
import { IconCache } from "@/lib/graphIcons";
import { GraphLegend } from "./GraphLegend";
import { GraphSearch } from "./GraphSearch";
import { GraphSettingsPanel } from "./GraphSettings";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type GraphSettings as Settings,
} from "@/lib/graph/settings";
import { labelPriority, planLabels, type LabelCandidate } from "@/lib/graph/labels";
import { rankMatches } from "@/lib/graph/search";

// react-force-graph-2d gives us zoom / pan / physics for free. dynamic() cannot
// carry the library's generics, so we import it as an untyped boundary (the
// catalog-app pattern) and keep every accessor typed internally against our own
// FNode/FLink shapes. ssr:false because the library touches window/canvas.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <p className="absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-[0.18em] text-slate-600">
      loading graph engine…
    </p>
  ),
}) as unknown as React.ComponentType<
  Record<string, unknown> & { ref?: React.Ref<unknown> }
>;

/* ---- node / link shapes fed to the library. force-graph mutates these in
   place (adding x/y/vx/vy/fx/fy), so we hold ONE memoised copy per graph and
   never rebuild it on hover/focus — otherwise the layout would reset. ----

   PORT NOTE — THREE FIELDS CHANGED, AND ALL THREE FOR THE SAME REASON.

   v1's map was markdown notes wired by `[[wikilinks]]`, so a node knew whether
   it was a REGISTRY note (`isIndex`) and a link knew whether it was
   STRUCTURAL ("this table of contents mentions that note"). This engine writes
   no notes and no tables of contents, so both fields would be constants —
   `false` on every node, `false` on every edge — and the controls built on them
   would be controls that do nothing.

   What this engine has instead is `relation`: the classifier's judgement about
   how each entity stands to the anchor, or `none` when it would not judge. A
   `none` entity is on the map and connected to nothing, which is the same
   TOPOLOGY the index machinery existed to manage — so the machinery is kept and
   re-pointed at the fact that is real. `isIndex` became `isOrphan`, and the
   toggle that hid registry clutter now hides (or reveals) the entities nobody
   placed, with the count on the button. */
interface FNode {
  id: string;
  title: string;
  type: NodeType;
  group: string;
  /** The classifier's own word: company · product · community · publisher ·
   *  directory. Six kinds share four colours, so this is what the detail card
   *  shows to keep the collapse visible. */
  kind: string;
  relation: string;
  rel: number;
  deg: number;
  hub: boolean; // high-degree → weaker/longer springs (declusters the star)
  isHub: boolean; // THE anchor — drawn with a cyan ring
  isOrphan: boolean; // relation: none — on the map, wired to nothing
  r: number; // radius in graph units — SIZE encodes placement
  domain?: string; // player nodes: the entity's domain, for its favicon
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}
interface FLink {
  source: string | FNode;
  target: string | FNode;
  hubLink: boolean;
  /** Degree of the busier endpoint — how many children this spring must seat. */
  parentDeg: number;
  /** What this edge asserts. v1's edges were untyped wikilinks with nothing to
   *  say; every edge here carries the relation the classifier assigned, which
   *  is the whole content of the map. */
  relation: string;
  /** measured = a page named both ends; inferred = model reasoning. Inferred
   *  draws dashed. */
  confidence: string;
}

// A serialisable snapshot of the clicked node, drives the React detail card.
interface Detail {
  id: string;
  title: string;
  type: NodeType;
  group: string;
  kind: string;
  relation: string;
  rel: number;
  deg: number;
  isHub: boolean;
  isOrphan: boolean;
  domain: string;
}

// The handful of imperative force-graph methods we drive off the ref. dynamic()
// erases the real generics, so we describe just this surface and cast to it.
interface FgMethods {
  d3Force: (name: string, fn?: unknown) => D3Force | undefined;
  d3ReheatSimulation?: () => void;
  zoomToFit?: (ms?: number, px?: number) => void;
  centerAt?: (x?: number, y?: number, ms?: number) => void;
  /** Absolute zoom level, animated over `ms`. Used to land a search hit. */
  zoom?: (k?: number, ms?: number) => number;
}

/* A d3 force, as far as this file drives it. Every setter returns the force so
   calls chain, which is what lets charge configure strength and both distance
   bounds in one expression. All optional: `d3Force("link")` and
   `d3Force("charge")` return different forces and neither has the other's
   setters. */
interface D3Force {
  strength?: (v: unknown) => D3Force;
  distance?: (v: unknown) => D3Force;
  distanceMax?: (v: number) => D3Force;
  distanceMin?: (v: number) => D3Force;
  radius?: (v: unknown) => D3Force;
}

/* The pane's height is CSS, not a number: the ResizeObserver below reads the
   real box, so the canvas follows the viewport instead of a frozen 520px that
   letterboxed the graph on every screen taller than a laptop. min-h keeps it
   usable on short windows. */
const PANE_H = "h-[min(78dvh,900px)] min-h-[520px]";
const FALLBACK_H = 520; // only if clientHeight reads 0 mid-transition
const HUB_DEGREE_FRAC = 0.3; // node counts as a hub above this share of node count
const STAR_EDGE_FRAC = 0.4; // banner threshold: one node carrying > this share of edges
/* Screen radius a node must reach before it may claim a label. This IS the
   zoom reveal: `r * scale` grows as the reader zooms in, so a lobe that was
   anonymous dots at the overview names itself once they zoom into it. */
const LABEL_MIN_SCREEN_R = 9;

/* Ceiling on labels per frame. A deep zoom into a dense lobe can qualify
   hundreds; past this many the screen is not more informative, only slower. */
const MAX_LABELS = 60;

const TOP_LABELS = 6; // top-N by relevance get an always-on label
const DARK_INK = "rgba(10,20,31,0.9)"; // glyph ink drawn on bright node fills
// Near-paper chip drawn behind a competitor favicon. Held constant across
// themes, like the node palette, so a dark-on-transparent brand mark always
// reads, whether the page is light or dark.
const FAVICON_BACKING = "#F2F6FF";
// Only paint a favicon once the node is ≥ ~16px across on screen; smaller than
// this the mark turns to mush, so we keep the crisp type glyph instead.
/* Screen radius below which a node is a plain coloured dot.
   Raised from 8. At the fitted overview zoom a 295-node map put a favicon chip
   on almost every node, and 289 competing logos at 9px is noise that HIDES the
   thing the overview is for — the shape of the market and where its lobes are.
   At 11 the overview reads as clean typed dots and the marks resolve as the
   reader zooms into a lobe, which is the zoom-reveal Obsidian gets right. */
const FAVICON_MIN_SCREEN_R = 11;

/* Deterministic seeding: same KB (+ reset count) → same starting layout, so a
   reset is a genuine re-layout (fresh node objects) rather than an in-place
   mutation of the memoised data. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Blend `hex` toward `toward` by `t` (0 = untouched, 1 = fully `toward`).
 *
 * Used to recede a node into the page rather than making it transparent:
 * `globalAlpha` composites against whatever is behind, which on the navy theme
 * erases the node and on paper bleaches it, while mixing toward the surface
 * colour keeps a readable silhouette in both.
 */
function mixHex(hex: string, toward: string, t: number): string {
  const a = parseHex(hex);
  const b = parseHex(toward);
  if (!a || !b) return hex;
  const k = Math.min(1, Math.max(0, t));
  const ch = (x: number, y: number) => Math.round(x + (y - x) * k);
  return `rgb(${ch(a[0], b[0])},${ch(a[1], b[1])},${ch(a[2], b[2])})`;
}

/** `#rgb` / `#rrggbb` -> [r,g,b], or null for anything else. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* port NOTE, `slugToDomain` and its COMPOUND_TLD table are gone.
   v1 reconstructed a competitor's domain by un-mangling the note FILENAME
   ("firecrawl-dev.md" → "firecrawl.dev"), with a table of registry TLDs so
   "core-ac-uk" did not become "core-ac.uk". It was a careful workaround for a
   store that could only name a file. Every node here arrives with its `domain`
   as a field off /api/kb/[id]/graph, so the guess is replaced by the fact. */

/* Coarse-pointer (touch) detection as an external store: taps replace hover
   and the caption says so. */
function subscribeCoarsePointer(cb: () => void): () => void {
  const mq = window.matchMedia("(pointer: coarse)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const getCoarsePointer = () => window.matchMedia("(pointer: coarse)").matches;
const getCoarsePointerServer = () => false;

/* Reduced-motion as an external store too, drives warmup/cooldown props (so
   it must be reactive) without a setState-in-effect. Freezes the layout fast. */
function subscribeReducedMotion(cb: () => void): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const getReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const getReducedMotionServer = () => false;

/* A d3-force that nudges each market node toward its own type's centroid, so
   segments loosely group (mild same-type clustering) instead of radiating off
   the hub. Core is exempt — it sits central via the default centering force. */
type DForce = ((alpha: number) => void) & {
  initialize?: (nodes: FNode[]) => void;
};
function makeClusterForce(): DForce {
  let nodes: FNode[] = [];
  const force: DForce = (alpha: number) => {
    const cent: Partial<Record<NodeType, { x: number; y: number; n: number }>> = {};
    for (const nd of nodes) {
      if (nd.x == null || nd.y == null) continue;
      const c = (cent[nd.type] ??= { x: 0, y: 0, n: 0 });
      c.x += nd.x;
      c.y += nd.y;
      c.n += 1;
    }
    for (const nd of nodes) {
      if (nd.type === "core" || nd.x == null || nd.y == null) continue;
      const c = cent[nd.type];
      if (c && c.n > 1) {
        nd.vx = (nd.vx ?? 0) + (c.x / c.n - nd.x) * 0.06 * alpha;
        nd.vy = (nd.vy ?? 0) + (c.y / c.n - nd.y) * 0.06 * alpha;
      }
    }
  };
  force.initialize = (n: FNode[]) => {
    nodes = n;
  };
  return force;
}

/* Ultra-light control-bar marks (drafting-instrument weight, currentColor) —
   enter/exit fullscreen, reset, and the filter funnel. */
function ControlIcon({
  name,
  size = 15,
}: {
  name: "expand" | "compress" | "reset" | "filter" | "sliders";
  size?: number;
}) {
  const p = (d: string) => <path d={d} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {name === "expand" && (
        <>
          {p("M4 9V5a1 1 0 0 1 1-1h4")}
          {p("M20 9V5a1 1 0 0 0-1-1h-4")}
          {p("M4 15v4a1 1 0 0 0 1 1h4")}
          {p("M20 15v4a1 1 0 0 1-1 1h-4")}
        </>
      )}
      {name === "sliders" && (
        <>
          {p("M4 8h10")}
          {p("M18 8h2")}
          {p("M4 16h4")}
          {p("M12 16h8")}
          <circle cx="16" cy="8" r="2" />
          <circle cx="10" cy="16" r="2" />
        </>
      )}
      {name === "compress" && (
        <>
          {p("M9 4v4a1 1 0 0 1-1 1H4")}
          {p("M15 4v4a1 1 0 0 0 1 1h4")}
          {p("M9 20v-4a1 1 0 0 0-1-1H4")}
          {p("M15 20v-4a1 1 0 0 1 1-1h4")}
        </>
      )}
      {name === "reset" && (
        <>
          {p("M4 12a8 8 0 1 1 2.4 5.7")}
          {p("M4 20v-4.5h4.5")}
        </>
      )}
      {name === "filter" && p("M5 5h14l-5.5 6.5V18l-3 1.6v-8.1L5 5z")}
    </svg>
  );
}

export function GraphCanvas({
  slug,
  openNote,
}: {
  slug: string;
  openNote: (p: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<unknown>(null);
  const shouldFitRef = useRef(true); // gate zoomToFit to first-settle + resets

  // The payload is lib/viewTypes' GraphView, straight off /api/kb/[slug]/graph:
  // the engine's own graph (lib/kb/graph.ts) plus the two things a reader needs
  // and the engine does not, a display title and the folder to colour by.
  const [graph, setGraph] = useState<GraphView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleTypes, setVisibleTypes] = useState<Record<NodeType, boolean>>({
    core: true,
    product: true,
    player: true,
    community: true,
  });
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  /* Starts at the defaults on BOTH server and client, then adopts the saved
     values after mount. Reading localStorage during the initial render would
     make the server and client markup disagree and hydration would tear. */
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(() => setSettings(loadSettings()), []);
  const updateSettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
  }, []);
  // The unplaced, entities the classifier put on the map and then would not
  // connect to the anchor (`relation: "none"`), are shown by default.
  //
  // v1's equivalent control defaulted the other way, and for a good reason: its
  // registry notes carried 241 of 467 edges and collapsed the force layout into
  // a ball, so hiding them was what made the graph read as a map rather than a
  // hairball. Nothing like that is true here. An unplaced entity has no edges
  // at all, so it cannot collapse anything; the tether force below holds it in
  // frame and it sits in the outer ring, visibly unconnected.
  //
  // And it is usually a LOT of the map, on a 40-query run, 22 of 40. Hiding
  // the majority of what the run found, by default, to make the picture tidier
  // is exactly the dishonesty this project refuses: a map that shows only what
  // it could classify is a map that looks finished. The control is there for a
  // reader who wants the wired subgraph, with the count on the button.
  const [showUnplaced, setShowUnplaced] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  /* Hover lives in a ref, not in state.
     `autoPauseRedraw={false}` means this canvas repaints every frame anyway, so
     the painter can simply read the current value — while `useState` re-rendered
     a 1,300-line component on every mousemove, up to 60 times a second, purely
     to change one node's alpha. Nothing in the JSX reads it. */
  const hoverRef = useRef<string | null>(null);
  const [hoverLink, setHoverLink] = useState<FLink | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusSet, setFocusSet] = useState<Set<string> | null>(null);
  /* The live search query. Non-matches dim through the SAME channel hover and
     focus use, so the three never fight over the canvas: whichever is most
     specific wins, and a query is the least specific of the three. */
  const [query, setQuery] = useState("");
  const [size, setSize] = useState({ w: 800, h: FALLBACK_H });
  const [resetSeed, setResetSeed] = useState(0); // bump → rebuild data → re-layout

  // Canvas needs concrete colours, not CSS-var strings. We resolve the shared
  // --type-* / --dataflow / ink tokens from computed styles on mount, but hold
  // them in a REF (not state), the fallbacks below are the canonical brand
  // hexes and equal the resolved vars, so there is no flash and no re-render;
  // the accessors read the ref at paint time, after the effect has resolved it.
  const paletteRef = useRef({
    type: { ...TYPE_COLOR },
    dataflow: "#00E0FF",
    text: "#E8EEF9",
    muted: "#9DB2D6",
    paper: "#0E1B34", // page surface (--bg)
    font: "ui-sans-serif, system-ui, sans-serif",
  });

  /* Favicons for ANY node that has a domain, fetched only when one is actually
     about to be drawn. Two changes from the old cache: it is no longer limited
     to players (that left 139 communities and 20 products as bare dots on a
     295-node map), and it no longer prefetches the whole graph on mount — the
     painter asks per frame, so a node too small to show a mark never costs a
     request. See lib/graphIcons.ts. */
  const iconsRef = useRef<IconCache | null>(null);
  // Bump-only counter: an async favicon load flips autoPauseRedraw's engine off,
  // so we force one React render, the fresh nodeCanvasObject closure makes the
  // kapsule repaint (no simulation reheat, layout untouched).
  const [, forceRepaint] = useState(0);
  const bumpFavicon = useCallback(() => forceRepaint((n) => n + 1), []);
  if (iconsRef.current === null) iconsRef.current = new IconCache(bumpFavicon);
  useEffect(() => () => iconsRef.current?.dispose(), []);

  // coarse pointer (touch) → tap-driven interaction + adjusted caption
  const coarse = useSyncExternalStore(
    subscribeCoarsePointer,
    getCoarsePointer,
    getCoarsePointerServer,
  );
  // reduced motion → freeze the layout quickly (warmup instead of animation)
  const reduceMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    getReducedMotionServer,
  );

  // resolve the palette from CSS vars (client-only reads) into a ref, no
  // setState, so a brand tweak to --type-*/--dataflow still moves the canvas
  // without a cascading render. The canvas draws concrete hexes, so when the
  // ThemeToggle flips documentElement.dataset.theme (which re-keys every var)
  // we must re-resolve and force one repaint, otherwise labels keep the stale
  // theme's ink (--text) and vanish against the flipped surface.
  useEffect(() => {
    const resolve = () => {
      const rs = getComputedStyle(document.documentElement);
      const cssVar = (name: string, fb: string) =>
        rs.getPropertyValue(name).trim() || fb;
      paletteRef.current = {
        type: {
          product: cssVar("--type-product", TYPE_COLOR.product),
          player: cssVar("--type-player", TYPE_COLOR.player),
          community: cssVar("--type-community", TYPE_COLOR.community),
          core: cssVar("--type-core", TYPE_COLOR.core),
        },
        dataflow: cssVar("--dataflow", "#00E0FF"),
        text: cssVar("--text", "#E8EEF9"),
        muted: cssVar("--muted", "#9DB2D6"),
        paper: cssVar("--bg", "#0E1B34"),
        font:
          getComputedStyle(document.body).fontFamily ||
          "ui-sans-serif, system-ui, sans-serif",
      };
    };
    resolve();
    const mo = new MutationObserver(() => {
      resolve();
      bumpFavicon(); // forces a fresh nodeCanvasObject closure → kapsule repaint
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => mo.disconnect();
  }, [bumpFavicon]);

  // clear the focus highlight + detail card (stable, used by the Escape effect)
  const clearFocus = useCallback(() => {
    setDetail(null);
    setFocusId(null);
    setFocusSet(null);
  }, []);

  // load graph
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/kb/${slug}/graph`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((g: GraphView) => !cancelled && setGraph(g))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Derived degree / adjacency / hub / sizing / topology stats, the single
  // source of truth the graph data and every accessor read from.
  const meta = useMemo(() => {
    const nodes = graph?.nodes ?? [];
    const links = graph?.edges ?? [];
    const degById = new Map<string, number>();
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) {
      degById.set(n.id, 0);
      adj.set(n.id, new Set());
    }
    // v1 filtered structural (table-of-contents) edges out of degree and
    // adjacency here, not just out of the picture, because degree drives node
    // sizing, the hub ring, the focus set and the detail card's neighbour
    // count. This engine emits no such edges, every edge is a relation the
    // classifier asserted, so every link is active and the name is kept for
    // the readers downstream.
    const activeLinks = links;
    for (const l of activeLinks) {
      if (!degById.has(l.source) || !degById.has(l.target)) continue;
      degById.set(l.source, (degById.get(l.source) ?? 0) + 1);
      degById.set(l.target, (degById.get(l.target) ?? 0) + 1);
      adj.get(l.source)!.add(l.target);
      adj.get(l.target)!.add(l.source);
    }
    const maxRel = Math.max(1, ...nodes.map((n) => n.relevance || 0));

    // THE anchor hub: highest degree; a core-type node wins near-ties.
    let hubId = "";
    let hubScore = -1;
    let maxId = "";
    let maxDeg = 0;
    for (const n of nodes) {
      const deg = degById.get(n.id) ?? 0;
      if (deg > maxDeg) {
        maxDeg = deg;
        maxId = n.id;
      }
      const score = deg + (nodeTypeOf(n.group) === "core" ? 0.5 : 0);
      if (score > hubScore) {
        hubScore = score;
        hubId = n.id;
      }
    }
    const share = activeLinks.length ? maxDeg / activeLinks.length : 0;
    const maxTitle = nodes.find((n) => n.id === maxId)?.title ?? maxId;

    const typeCounts = { core: 0, product: 0, player: 0, community: 0 } as Record<
      NodeType,
      number
    >;
    for (const n of nodes) typeCounts[nodeTypeOf(n.group)]++;
    const presentTypes = TYPE_ORDER.filter((t) => typeCounts[t] > 0);

    const topSet = new Set(
      [...nodes]
        .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
        .slice(0, TOP_LABELS)
        .map((n) => n.id),
    );
    const orphanCount = nodes.filter((n) => n.relation === "none").length;

    return {
      degById, adj, maxRel, maxDeg, share, maxTitle, hubId,
      typeCounts, presentTypes, topSet, activeLinks, orphanCount,
    };
  }, [graph]);

  // Build the force-graph data per graph (and per reset). Kept stable across
  // hover/focus renders so the simulation and node positions survive
  // interaction; a resetSeed bump makes a fresh copy (new node objects, seeded
  // start positions) so "reset" is a real re-layout without mutating a memo.
  const data = useMemo(() => {
    // Hidden nodes are removed from the data, not merely hidden from the paint.
    // Left in the simulation they have no links, so charge repulsion flings
    // them far off-screen, and zoomToFit measures every node, visible or not,
    // so those invisible outliers inflated the bounding box and left the real
    // cluster stranded tiny in the middle.
    const list = (graph?.nodes ?? []).filter(
      (n) => showUnplaced || n.relation !== "none",
    );
    const nodeCount = Math.max(1, list.length);
    const rng = mulberry32(hashStr(slug) ^ (nodeCount + resetSeed * 0x9e3779b1));
    const nodes: FNode[] = list.map((n) => {
      const type = nodeTypeOf(n.group);
      const deg = meta.degById.get(n.id) ?? 0;
      const rel = Math.max(0, n.relevance || 0);
      const isHub = n.id === meta.hubId;
      // Seeded from the id, not from `rng()`: the old seed advanced per node, so
      // the opening shape depended on iteration order and a reset produced a
      // different map. Same graph, same opening, every time.
      const seed = seedPosition({ id: n.id, deg, r: 0, isHub }, nodeCount, meta.maxDeg);
      return {
        id: n.id,
        title: n.title,
        type,
        group: n.group,
        kind: n.kind,
        relation: n.relation,
        rel: n.relevance || 0,
        deg,
        // Hub-ness is SHAPE, not identity, and it is an absolute degree rather
        // than a share of the node count. `deg > nodeCount * 0.3` demanded 88
        // edges on a 295-node map, so the markets carrying 82, 64 and 55
        // children all scored as leaves and were laid out with leaf springs —
        // which is precisely why they rendered as filled discs.
        hub: isHubDegree(deg),
        isHub,
        isOrphan: n.relation === "none",
        r: 4 + Math.sqrt(rel / meta.maxRel) * 12, // honest sqrt scale, 4–16px
        // Every node that HAS a domain may show its mark. Restricting this to
        // players meant 139 communities with instantly recognisable icons
        // (serverfault, superuser, youtube) and 20 products drew as bare dots.
        domain: n.domain || undefined,
        x: seed.x,
        y: seed.y,
        // The anchor is pinned. Everything is nominally attached to it, so if
        // it drifts the whole map swims after it.
        ...(isHub ? { fx: 0, fy: 0 } : {}),
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: FLink[] = (graph?.edges ?? [])
      .filter((l) => byId.has(l.source) && byId.has(l.target))
      .map((l) => {
        const s = byId.get(l.source)!;
        const t = byId.get(l.target)!;
        return {
          source: l.source,
          target: l.target,
          hubLink: s.isHub || t.isHub,
          // How many children the busier end is seating. The spring has to be
          // long enough to give them a circumference to sit on.
          parentDeg: Math.max(s.deg, t.deg),
          relation: l.label ?? "",
          confidence: l.confidence ?? "measured",
        };
      });
    return { nodes, links, byId };
  }, [graph, meta, slug, resetSeed, showUnplaced]);

  const nodeCount = Math.max(1, data.nodes.length);

  /* What the search box searches. Derived from the same node list the canvas
     draws, so a hidden type is not findable — a result that cannot be shown is
     not a result. */
  const searchItems = useMemo(
    () =>
      data.nodes
        .filter((n) => visibleTypes[n.type])
        .map((n) => ({
          id: n.id,
          title: n.title,
          domain: n.domain,
          type: n.type,
          deg: n.deg,
        })),
    [data, visibleTypes],
  );

  /* Which nodes the query matches. Empty query = null, meaning "no query
     dimming", which is a different state from "matched nothing" — the latter
     must dim the whole map so the reader sees their search failed. */
  const matchSet = useMemo(() => {
    if (!query.trim()) return null;
    return new Set(rankMatches(searchItems, query, 500).map((m) => m.id));
  }, [searchItems, query]);

  // Tune the physics for mild same-type clustering. force-graph rebuilds the
  // simulation (and resets forces to defaults) whenever graphData changes, so
  // this re-applies on every data change; a short rAF retry covers the dynamic
  // import populating the ref a tick late.
  useEffect(() => {
    if (!data.nodes.length) return;
    // A new data object means a fresh layout run (mount, index toggle, reset),
    // so arm the fit again, the settled positions are not known until the
    // engine stops, and fitting before then under-fills the pane.
    shouldFitRef.current = true;
    let tries = 0;
    let raf = 0;
    const apply = () => {
      const fg = fgRef.current as FgMethods | null;
      if (!fg?.d3Force) {
        if (tries++ < 30) raf = requestAnimationFrame(apply);
        return;
      }
      /* THE force that was never removed.
         react-force-graph installs charge + link + CENTER. This effect replaced
         the first two and added its own tethers, but `center` stayed — and it
         translates the whole graph every tick to drag the centroid back to the
         origin. With the anchor pinned it can never succeed, so it pushed all
         294 other nodes forever. That was the slow orbit that never settled. */
      fg.d3Force("center", null);

      fg.d3Force("charge")
        // Every force reads its multiplier from the panel, so a slider changes
        // the strength of the DESIGNED recipe rather than replacing it.
        ?.strength?.((n: FNode) => chargeStrength(n) * settings.repelForce)
        // Repulsion had no range limit, so every node pressed on every other
        // node across the whole canvas. All-pairs pressure irons any structure
        // flat into one even disc; capping it lets lobes form.
        ?.distanceMax?.(chargeDistanceMax(nodeCount))
        ?.distanceMin?.(2);

      const link = fg.d3Force("link");
      link?.distance?.((l: FLink) => linkDistance(l, nodeCount) * settings.linkDistance);
      link?.strength?.((l: FLink) => linkStrength(l) * settings.linkForce);

      // Collide at two iterations rather than one: at this density a single
      // pass leaves overlaps that can only be cleared by raising strength to
      // ~1, which visibly jitters.
      fg.d3Force(
        "collide",
        forceCollide<FNode>()
          // Pad and iterations both raised after looking at a settled 295-node
          // map: at (r+5, 0.85, 2) the dense lobes still had visibly stacked
          // favicon chips, because alpha ran out before the overlaps resolved.
          // Three passes clear them without pushing strength to 1, which
          // visibly jitters.
          // Collision follows the drawn size: turning nodes up must give them
          // more room, not make them overlap.
          .radius((n) => n.r * settings.nodeScale + 7)
          .strength(0.9)
          .iterations(3),
      );

      // A weak leash to the origin. The springs and charge decide the shape;
      // this only stops the map wandering out of frame — and holds the
      // disconnected, which have no spring at all.
      /* Shaped to the pane, not to a circle. See tetherAspect: an equal pull on
         both axes settles into a disc, which in a 2:1 pane fits by height and
         wastes half the canvas while crowding the middle. */
      const aspect = tetherAspect(size.w, size.h);
      const tether = (n: FNode) => tetherStrength(n) * settings.centerForce;
      fg.d3Force("x", forceX<FNode>(0).strength((n: FNode) => tether(n) * aspect.x));
      fg.d3Force("y", forceY<FNode>(0).strength((n: FNode) => tether(n) * aspect.y));
      // per-type centroid pull, segments loosely group
      fg.d3Force("cluster", makeClusterForce());
      fg.d3ReheatSimulation?.();
    };
    apply();
    return () => cancelAnimationFrame(raf);
  }, [data, nodeCount, settings, size.w, size.h]);

  // (The eager preload loop that lived here is gone: IconCache fetches on
  // demand from the painter, so nothing is requested for a node the reader
  // never sees at a legible size.)

  // measure the wrap → drive the library's width/height (it needs numbers).
  // Re-measures on the fullscreen transition (wrap box changes).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () =>
      setSize({
        w: wrap.clientWidth || 800,
        h: wrap.clientHeight || FALLBACK_H,
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fullscreen, graph]);

  // Re-ARM the fit when the pane's box changes; do not fit here. The first
  // settle consumes shouldFitRef, so a pane that grows afterwards (tab mount,
  // window resize, fullscreen) would otherwise leave the graph stranded small.
  //
  // Calling zoomToFit directly from here was a bug: once the engine settles the
  // library stops redrawing, so the camera animated across a canvas that was
  // never repainted and every frame painted over the last, nodes smeared into
  // radial streaks. Fitting only ever happens from onEngineStop, where the
  // engine is by definition still driving frames.
  useEffect(() => {
    if (!graph || size.w < 2 || size.h < 2) return;
    shouldFitRef.current = true;
    (fgRef.current as FgMethods | null)?.d3ReheatSimulation?.();
  }, [size.w, size.h, graph]);

  // Fullscreen a11y: lock body scroll, focus-trap Tab within the overlay, and
  // close on Escape.
  useEffect(() => {
    if (!fullscreen) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () =>
      Array.from(
        wrap.querySelectorAll<HTMLElement>(
          'button, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setFullscreen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !wrap.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !wrap.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  // Escape (when not fullscreen) dismisses the detail card + focus.
  useEffect(() => {
    if (fullscreen || !detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearFocus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen, detail, clearFocus]);

  const toggleType = (t: NodeType) => {
    clearFocus();
    setVisibleTypes((v) => ({ ...v, [t]: !v[t] }));
  };

  const resetView = () => {
    clearFocus();
    hoverRef.current = null;
    setHoverLink(null);
    setVisibleTypes({ core: true, product: true, player: true, community: true });
    shouldFitRef.current = true;
    // fresh data → force-graph rebuilds the sim from the seeded positions,
    // dropping any drag-pinned nodes and re-running the layout
    setResetSeed((s) => s + 1);
  };

  const focusNode = (n: FNode, center = false) => {
    setVisibleTypes((v) => (v[n.type] ? v : { ...v, [n.type]: true }));
    setFocusId(n.id);
    setFocusSet(new Set([n.id, ...(meta.adj.get(n.id) ?? [])]));
    if (center && n.x != null && n.y != null) {
      const fg = fgRef.current as FgMethods | null;
      const ms = reduceMotion ? 0 : 600;
      fg?.centerAt?.(n.x, n.y, ms);
      /* Zoom IN to a legible level as part of the same move. Centring alone
         left a search hit as an unreadable dot in the middle of the pane —
         arriving somewhere means the labels around you resolve. Never zooms
         OUT: a reader already close in should not be yanked back. */
      const cur = fg?.zoom?.() ?? 1;
      if (cur < 2) fg?.zoom?.(2, ms);
    }
  };

  /** Land on a node by id — what the search box hands back. */
  const focusById = (id: string) => {
    const n = data.byId.get(id);
    if (n) focusNode(n, true);
  };

  const focusFromDetail = (d: Detail) => {
    const node = data.byId.get(d.id);
    if (node) focusNode(node, true);
  };

  if (error) {
    return <div className="p-6 text-sm text-rose-300">Graph unavailable: {error}</div>;
  }
  if (!graph) {
    // skeleton mirroring the final layout, the bureau shows a chart being
    // plotted, not a spinner
    return (
      <div aria-busy="true">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="h-3 w-36 animate-pulse rounded bg-slate-800/70" />
          <div className="hidden h-3 w-64 animate-pulse rounded bg-slate-800/70 sm:block" />
        </div>
        <div
          className={`relative overflow-hidden rounded-lg border border-slate-800 bg-slate-950/60 ${PANE_H}`}
        >
          <p className="absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-[0.18em] text-slate-600">
            plotting graph…
          </p>
        </div>
      </div>
    );
  }

  const visibleNodeCount = graph.nodes.filter(
    (n) => visibleTypes[nodeTypeOf(n.group)] && (showUnplaced || n.relation !== "none"),
  ).length;
  // v1 raised this banner to apologise for hub-heavy wiring: a KB whose links
  // all ran through one note was a KB whose cross-references had not been
  // written yet, and the copy said so ("rebuilt KBs get denser cross-links").
  //
  // Here the star is not a defect to be grown out of, it is the measurement.
  // The sweep classifies every host against the anchor and never against
  // another host, so anchor→entity is the only edge it can substantiate.
  // Cross-links would have to be invented. The banner therefore states the
  // shape once rather than promising it away, same threshold, opposite claim.
  const showBanner =
    !bannerDismissed && meta.share > STAR_EDGE_FRAC && meta.activeLinks.length > 0;
  const hiddenNodes = graph.nodes.length - data.nodes.length;

  // Surface reads the brand --bg (paper by default, navy under
  // [data-theme="dark"]) rather than a fixed slate, so the canvas and its
  // ink/paper labels flip together and the panel matches the app's 65% surface
  // in both themes.
  const wrapClass = fullscreen
    ? "fixed inset-0 z-50 overflow-hidden"
    : `relative overflow-hidden rounded-lg border border-slate-800 ${PANE_H}`;
  const wrapStyle = { background: "var(--bg)" };

  // --- library accessors (typed against our own shapes) ---
  const asNode = (e: string | FNode | undefined): FNode | undefined =>
    typeof e === "object" ? e : e != null ? data.byId.get(e) : undefined;
  const endId = (e: string | FNode | undefined): string =>
    (typeof e === "object" ? e?.id : e) ?? "";

  // The unplaced filter happens in the `data` memo, so these only handle type
  // filters, a node that reaches here is already meant to be in the layout.
  const nodeVisibility = (n: FNode) => visibleTypes[n.type];
  const linkVisibility = (l: FLink) => {
    const s = asNode(l.source);
    const t = asNode(l.target);
    return !!s && !!t && visibleTypes[s.type] && visibleTypes[t.type];
  };

  // Cyan is the bureau's data-flow hue, every edge and glow is drawn in it.
  // In hover/focus mode the incident edges light up; everything else recedes.
  const linkColor = (l: FLink) => {
    const palette = paletteRef.current;
    const s = endId(l.source);
    const t = endId(l.target);
    if (l === hoverLink) return hexToRgba(palette.dataflow, 0.9);
    const hoverId = hoverRef.current;
    if (hoverId) {
      const inc = s === hoverId || t === hoverId;
      return hexToRgba(palette.dataflow, inc ? 0.55 : 0.05);
    }
    if (focusId) {
      const inc = s === focusId || t === focusId;
      return hexToRgba(palette.dataflow, inc ? 0.55 : 0.03);
    }
    if (matchSet) {
      // An edge is lit only when it actually touches a hit; a search should not
      // brighten the wiring of nodes it did not find.
      const inc = matchSet.has(s) || matchSet.has(t);
      return hexToRgba(palette.dataflow, inc ? 0.4 : 0.03);
    }
    return hexToRgba(palette.dataflow, 0.1);
  };
  const linkWidth = (l: FLink) => {
    const s = endId(l.source);
    const t = endId(l.target);
    if (l === hoverLink) return 1.9 * settings.linkWidth;
    const hoverId = hoverRef.current;
    if (hoverId) return (s === hoverId || t === hoverId ? 1.6 : 1) * settings.linkWidth;
    if (focusId) return (s === focusId || t === focusId ? 1.6 : 1) * settings.linkWidth;
    return settings.linkWidth;
  };

  // The tooltip leads with the classifier's OWN two words, its kind and the
  // relation it placed the entity in, because those are what the run actually
  // decided. "placement", not "relevance": the number is a rank derived from
  // that relation, not a measurement (see lib/kb-from-run.ts).
  const nodeLabel = (n: FNode) =>
    `<div style="font-weight:500;color:${paletteRef.current.text}">${escapeHtml(n.title)}</div>` +
    `<div style="color:${paletteRef.current.muted};font-size:11px">${escapeHtml(n.kind)} · ` +
    `${n.isOrphan ? "unplaced" : escapeHtml(n.relation)} · placement ${Math.round(n.rel)}` +
    `${n.isHub ? " · the anchor" : ""}</div>`;

  const linkLabel = (l: FLink) => {
    const palette = paletteRef.current;
    const s = asNode(l.source);
    const t = asNode(l.target);
    if (!s || !t) return "";
    const blurb = RELATION_BLURB[l.relation] ?? "";
    return (
      `<div style="color:${palette.text}">${escapeHtml(t.title)} → ${escapeHtml(l.relation)}</div>` +
      `<div style="color:${palette.muted};font-size:11px">${escapeHtml(blurb)}</div>`
    );
  };

  // Full custom paint: node dimming (hover/focus focus-mode), the anchor hub's
  // cyan survey ring, a type glyph / hub initial on larger nodes, and labels.
  const nodeCanvasObject = (
    n: FNode,
    ctx: CanvasRenderingContext2D,
    scale: number,
  ) => {
    const palette = paletteRef.current;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const r = n.r * settings.nodeScale;
    const hoverId = hoverRef.current;
    const isHover = n.id === hoverId;
    const isFocus = n.id === focusId;

    // dim non-neighbours of the hovered (or, absent hover, the focused) node
    /* Three ways to be dim, most specific first. Hover beats focus beats
       search, so the channels can never disagree about one node — and a search
       that matches nothing dims the WHOLE map, which is how a reader sees the
       search failed rather than assuming the graph is just busy. */
    let bright = true;
    if (hoverId) bright = isHover || (meta.adj.get(hoverId)?.has(n.id) ?? false);
    else if (focusId) bright = focusSet?.has(n.id) ?? true;
    else if (matchSet) bright = matchSet.has(n.id);
    /* Dimming used to be `globalAlpha = 0.12`, which is a hole rather than a
       recession: on the navy theme it erased the node entirely and on paper it
       bleached it to nearly white, so hovering one company deleted the shape of
       the market around it. The point of dimming is to keep that shape as
       context while moving attention off it — so the colour is mixed toward the
       page surface instead, which recedes in BOTH themes and leaves the
       silhouette readable. */
    ctx.globalAlpha = bright ? (isHover ? 1 : 0.96) : 0.42;

    // cyan glow on the live node(s): hover brightest, then focus, then hub
    if (bright && !reduceMotion) {
      const glow = isHover ? 14 : isFocus ? 9 : n.isHub ? 6 : 0;
      if (glow) {
        ctx.shadowColor = hexToRgba(palette.dataflow, 0.85);
        ctx.shadowBlur = glow;
      }
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = bright
      ? palette.type[n.type]
      : mixHex(palette.type[n.type], palette.paper, 0.72);
    ctx.fill();
    ctx.shadowBlur = 0;

    const isMatch = !hoverId && !focusId && (matchSet?.has(n.id) ?? false);
    if (isHover || isFocus || isMatch) {
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeStyle = palette.text;
      ctx.stroke();
    }

    // the anchor wears a cyan survey ring, the centre of data flow
    if (n.isHub) {
      ctx.beginPath();
      ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
      ctx.lineWidth = 1.25 / scale;
      ctx.strokeStyle = hexToRgba(palette.dataflow, bright ? 0.9 : 0.25);
      ctx.stroke();
    }

    // Type is shape-encoded, not hue-only: player nodes carry the competitor's
    // favicon, the hub its initial, every other node its geometric type glyph —
    // on nodes big enough on screen to hold a mark (screen radius = r * scale).
    const screenR = r * scale;
    ctx.textAlign = "center";

    // Player identity: draw the cached favicon on a paper chip clipped to the
    // node, leaving the pink type fill as a rim so the "player" read survives.
    //
    // NOTE: drawing these third-party images is what taints the canvas. Once
    // tainted, getImageData / toDataURL throw a SecurityError, so a client-side
    // PNG export of the graph is impossible. Do not add an export button.
    // Ask only when the node is big enough to show a mark — that gate is what
    // keeps the request count proportional to what is on screen.
    const favImg =
      screenR >= FAVICON_MIN_SCREEN_R && n.domain
        ? iconsRef.current?.get(n.domain) ?? null
        : null;
    const showFavicon = !!favImg?.complete;

    if (showFavicon && favImg) {
      /* The identity ring, thinned from 0.18r to 0.12r and capped.
         At 0.18 the ring was a third of the node's area, so a hundred players
         at overview zoom read as a field of pink doughnuts rather than as a
         hundred logos — the mark it exists to frame was the smaller half of it.
         It still says "player" at a glance; it no longer outshouts the icon. */
      const rim = Math.min(2.2, Math.max(0.8, r * 0.12));
      const ir = Math.max(1, r - rim); // favicon (and paper backing) radius
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, ir, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = FAVICON_BACKING; // paper backing so transparent marks read
      ctx.fill();
      ctx.clip();
      ctx.drawImage(favImg, x - ir, y - ir, ir * 2, ir * 2);
      ctx.restore();
    } else if (n.isHub) {
      if (screenR >= 9) {
        ctx.fillStyle = DARK_INK;
        ctx.textBaseline = "middle";
        ctx.font = `600 ${r}px ${palette.font}`;
        ctx.fillText((n.title[0] || "•").toUpperCase(), x, y + 0.5 / scale);
        ctx.textBaseline = "alphabetic";
      }
    } else if (screenR >= 7) {
      ctx.fillStyle = DARK_INK;
      ctx.textBaseline = "middle";
      ctx.font = `${r * 0.85}px ${palette.font}`;
      ctx.fillText(TYPE_ICON[n.type], x, y + 0.5 / scale);
      ctx.textBaseline = "alphabetic";
    }

    /* Labels are NOT drawn here any more. Which node gets a name depends on
       what else is already on screen and how far the reader has zoomed — both
       properties of the FRAME, which a per-node painter cannot see. They are
       laid out in one pass in onRenderFramePost, via lib/graph/labels.ts. */
    ctx.globalAlpha = 1;
  };

  /* One pass over the frame to place every label.
     Drawn AFTER the nodes (onRenderFramePost) so a name is never buried under a
     circle painted later, and decided all at once so two labels cannot land on
     top of each other — both things a per-node painter structurally cannot do.
     The reveal is `r * scale`: zoom in and more nodes grow past the threshold,
     which is what makes zooming an act of reading rather than just of framing. */
  const drawLabels = (ctx: CanvasRenderingContext2D, scale: number) => {
    const palette = paletteRef.current;
    const hoverId = hoverRef.current;
    /* Font size in GRAPH units so it lands at a constant size on SCREEN: the
       canvas is scaled by `scale`, so the graph-space size must be its inverse.
       `Math.max(9, 11 / scale)` floored that in graph units, which does the
       opposite of what it looks like — past ~1.2x zoom the floor wins and the
       text grows with the canvas, reaching 36px at 4x. */
    const fpx = settings.labelPx / scale;
    ctx.font = `${fpx}px ${palette.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    const hoverAdj = hoverId ? meta.adj.get(hoverId) : null;

    const candidates: LabelCandidate[] = [];
    for (const n of data.nodes) {
      if (!visibleTypes[n.type]) continue;
      // Dimmed nodes are context, not content — naming them would put the
      // reader's attention back exactly where the dimming just took it from.
      let bright = true;
      if (hoverId) bright = n.id === hoverId || (hoverAdj?.has(n.id) ?? false);
      else if (focusId) bright = focusSet?.has(n.id) ?? true;
      else if (matchSet) bright = matchSet.has(n.id);
      if (!bright) continue;

      const forced =
        n.id === hoverId ||
        n.id === focusId ||
        (!hoverId && !focusId && (matchSet?.has(n.id) ?? false));

      candidates.push({
        id: n.id,
        text: truncate(n.title, 28),
        x: n.x ?? 0,
        y: n.y ?? 0,
        r: n.r,
        priority: labelPriority(n),
        forced,
      });
    }

    const placed = planLabels(candidates, {
      scale,
      minScreenR: settings.labelThreshold,
      maxLabels: MAX_LABELS,
      // Measured against the very ctx that will draw them, so the packing uses
      // real glyph widths rather than a guess at the font's metrics.
      measure: (t) => ctx.measureText(t).width * scale,
      lineHeight: 12,
    });

    for (const l of placed) {
      ctx.font = `${l.forced ? "500 " : ""}${fpx}px ${palette.font}`;
      ctx.fillStyle = l.forced ? palette.text : palette.muted;
      // Halo the label in the page surface (theme-aware): a paper cut-out in
      // light mode, a dark cut-out when --bg flips to navy, so ink labels stay
      // legible against the canvas in both.
      ctx.shadowColor = hexToRgba(palette.paper, 0.85);
      ctx.shadowBlur = 4;
      ctx.fillText(l.text, l.x, l.y);
      ctx.shadowBlur = 0;
    }
  };

  // hit area matches the drawn circle so picking never drifts from the visual
  const nodePointerAreaPaint = (
    n: FNode,
    color: string,
    ctx: CanvasRenderingContext2D,
  ) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, n.r + 2, 0, Math.PI * 2);
    ctx.fill();
  };

  const onNodeClick = (n: FNode) => {
    // One click always does the same thing: focus the node, show its
    // neighbours, raise the card. Opening the note is an explicit button on the
    // card (or a double-click), the old "click the focused node again" gesture
    // was undiscoverable, and it made a second click on a card you were reading
    // navigate away unexpectedly.
    setFocusId(n.id);
    setFocusSet(new Set([n.id, ...(meta.adj.get(n.id) ?? [])]));
    setDetail({
      id: n.id,
      title: n.title,
      type: n.type,
      group: n.group,
      kind: n.kind,
      relation: n.relation,
      rel: n.rel,
      deg: n.deg,
      isHub: n.isHub,
      isOrphan: n.isOrphan,
      domain: n.domain ?? "",
    });
  };

  return (
    <div>
      {showBanner && (
        /* amber-* is remapped to the brand pink ramp in globals.css, the
           highlight hue for advisories/badges. sky-* would render this passive
           notice in the reserved action blue, so it must never be used here. */
        <div className="mb-3 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
          <span className="mt-0.5 shrink-0 text-amber-400">
            <NodeGlyph kind="alert" size={15} />
          </span>
          <p className="flex-1">
            <span className="font-mono text-slate-100">{meta.maxTitle}</span> carries{" "}
            {Math.round(meta.share * 100)}% of all edges, and that is the
            measurement rather than a layout artefact: the sweep classifies every
            host against the anchor and never against another host, so
            anchor&nbsp;→&nbsp;entity is the only relationship it can
            substantiate. Cross-links would have to be invented.
          </p>
          <button
            onClick={() => setBannerDismissed(true)}
            className="shrink-0 rounded border border-amber-500/40 px-1.5 py-0.5 text-amber-300 hover:bg-amber-500/20"
          >
            dismiss
          </button>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-slate-500">
        <span className="tnum">
          {visibleNodeCount === graph.nodes.length
            ? graph.nodes.length
            : `${visibleNodeCount}/${graph.nodes.length}`}{" "}
          nodes · {meta.activeLinks.length} links
          {hiddenNodes > 0 && (
            <span className="ml-2 text-slate-500">
              ({hiddenNodes} unplaced hidden)
            </span>
          )}
        </span>
        {/* The two numbers v1 shipped `dangling` and `orphans` for, said out
            loud. v1's reasoning holds exactly: "a dead wikilink and an
            unreachable note are the two most useful things a reader can know
            about a KB, and hiding them would make every KB look finished." */}
        {(meta.orphanCount > 0 || graph.dangling.length > 0) && (
          <span className="tnum flex flex-wrap items-center gap-x-3 gap-y-1">
            {meta.orphanCount > 0 && (
              <span
                className="text-amber-400/90"
                title="On the map, connected to nothing: the classifier saw these hosts and would not place them against the anchor. Shown, not hidden — a map that reports none is usually a map that stopped looking."
              >
                {meta.orphanCount} unplaced
              </span>
            )}
            {graph.dangling.length > 0 && (
              <span
                className="text-slate-500"
                title="Hosts this run paid a search for and the classifier judged unrelated to the market. There is no node for them — the money is spent and the map is empty there, which is worth knowing."
              >
                {graph.dangling.length} discarded as noise
              </span>
            )}
          </span>
        )}
        <span className="ml-auto">
          {coarse
            ? "tap a node for its card · pinch to zoom"
            : "hover for detail · click for card · double-click to open · scroll to zoom · drag to move"}
        </span>
      </div>

      <div
        ref={wrapRef}
        className={wrapClass}
        style={wrapStyle}
        role={fullscreen ? "dialog" : "img"}
        aria-modal={fullscreen ? true : undefined}
        aria-label={
          fullscreen
            ? `${slug} knowledge graph, fullscreen`
            : `knowledge graph: ${graph.nodes.length} nodes, ${graph.edges.length} links${
                meta.maxTitle ? `, anchor ${meta.maxTitle}` : ""
              }`
        }
      >
        {/* visually-hidden summary for assistive tech (the canvas is opaque) */}
        <p className="sr-only">
          Force-directed market map of {graph.nodes.length} entities and{" "}
          {graph.edges.length} relations. Nodes are sized by placement and
          coloured by type ({meta.presentTypes.map((t) => TYPE_LABEL[t]).join(", ")}
          ). The anchor is {meta.maxTitle}. {meta.orphanCount} entities carry no
          relation to the anchor and {graph.dangling.length} hosts were discarded
          as noise. Use the type filters to show or hide segments; select a node
          to open its detail card, then use its Open entity button to read it.
        </p>

        <ForceGraph2D
          ref={fgRef}
          graphData={data}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeRelSize={4}
          nodeVisibility={nodeVisibility}
          linkVisibility={linkVisibility}
          nodeLabel={nodeLabel}
          linkLabel={linkLabel}
          nodeCanvasObjectMode={() => "replace"}
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={nodePointerAreaPaint}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLineDash={(l: FLink) => (l.confidence === "inferred" ? [3, 3] : null)}
          onNodeHover={(n: FNode | null) => {
            hoverRef.current = n ? n.id : null;
          }}
          onLinkHover={(l: FLink | null) => setHoverLink(l)}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={(n: FNode) => openNote(n.id)}
          onBackgroundClick={clearFocus}
          warmupTicks={warmupTicks(nodeCount, reduceMotion)}
          cooldownTicks={cooldownTicks(nodeCount, reduceMotion)}
          d3AlphaDecay={ALPHA_DECAY}
          // Above zero so the simulation genuinely STOPS. At d3's default of 0 it
          // creeps forever below the visible threshold, holding the render loop
          // open and never letting onEngineStop fire cleanly.
          d3AlphaMin={ALPHA_MIN}
          d3VelocityDecay={VELOCITY_DECAY}
          minZoom={0.4}
          maxZoom={8}
          // The library pauses redrawing once the engine settles, which leaves
          // any camera animation (zoomToFit) smearing over a stale canvas. At
          // ~100 nodes the cost of always redrawing is not worth that class of
          // bug.
          autoPauseRedraw={false}
          onRenderFramePost={drawLabels}
          /* THE RIPPLE.
             Dragging a node moved that node and nothing else: `d3AlphaMin` is
             what finally made the simulation STOP after settling, and a stopped
             simulation has no energy to pass along an edge, so the graph felt
             like a picture rather than a web. Reheating on drag puts energy
             back in, and the neighbours — then their neighbours — follow
             through the springs. */
          onNodeDrag={() => {
            (fgRef.current as FgMethods | null)?.d3ReheatSimulation?.();
          }}
          onNodeDragEnd={(n: FNode) => {
            /* Let go properly. force-graph pins a dragged node by writing
               fx/fy, so without this every node a reader ever touched stayed
               nailed where they dropped it and the layout slowly became a
               collection of pins. The anchor is the one deliberate exception —
               it is pinned by the recipe, not by a drag. */
            if (!n.isHub) {
              n.fx = undefined;
              n.fy = undefined;
            }
            (fgRef.current as FgMethods | null)?.d3ReheatSimulation?.();
          }}
          linkDirectionalArrowLength={settings.arrows ? 3 : 0}
          linkDirectionalArrowRelPos={0.98}
          onEngineStop={() => {
            if (!shouldFitRef.current) return;
            shouldFitRef.current = false;
            (fgRef.current as FgMethods | null)?.zoomToFit?.(400, 56);
          }}
        />

        {/* compact control bar — filters / reset / fullscreen. There is
            deliberately no export button: see the canvas-taint note in
            nodeCanvasObject. */}
        {/* Search sits apart from the icon cluster: it is the one control a
            reader uses while looking AT the map, not at the chrome. */}
        <div className="absolute left-3 top-3 z-20">
          <GraphSearch items={searchItems} onPick={focusById} onQueryChange={setQuery} />
        </div>

        <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950/85 p-1 shadow-lg">
          <button
            onClick={() => setShowSettings((v) => !v)}
            aria-pressed={showSettings}
            title="display & forces"
            className={`inline-flex h-7 items-center gap-1.5 rounded px-2 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors ${
              showSettings
                ? "bg-sky-500/15 text-sky-300"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <ControlIcon name="sliders" />
            tune
          </button>
          <button
            onClick={() => setShowLegend((s) => !s)}
            aria-pressed={showLegend}
            title={showLegend ? "hide filters" : "show filters"}
            className={`inline-flex h-7 items-center gap-1.5 rounded px-2 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors ${
              showLegend
                ? "bg-sky-500/15 text-sky-300"
                : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
            }`}
          >
            <ControlIcon name="filter" size={13} />
            filters
            <span className="sr-only">toggle type filters</span>
          </button>
          {meta.orphanCount > 0 && (
            <button
              onClick={() => {
                shouldFitRef.current = true; // re-fit after the layout re-runs
                setShowUnplaced((s) => !s);
              }}
              aria-pressed={showUnplaced}
              title={
                showUnplaced
                  ? `hide the ${meta.orphanCount} entities the classifier would not place — leaves only the wired map`
                  : `show the ${meta.orphanCount} entities the classifier would not place`
              }
              className={`inline-flex h-7 items-center gap-1.5 rounded px-2 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors ${
                showUnplaced
                  ? "bg-sky-500/15 text-sky-300"
                  : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
              }`}
            >
              <NodeGlyph kind="alert" size={13} />
              <span className="tnum">{meta.orphanCount}</span>
              <span className="sr-only">
                toggle the entities with no relation to the anchor
              </span>
            </button>
          )}
          <button
            onClick={resetView}
            title="reset view"
            className="grid h-7 w-7 place-items-center rounded text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-slate-200"
          >
            <ControlIcon name="reset" />
            <span className="sr-only">reset the graph</span>
          </button>
          <button
            onClick={() => setFullscreen((f) => !f)}
            aria-pressed={fullscreen}
            title={fullscreen ? "exit fullscreen (Esc)" : "fullscreen"}
            className={`grid h-7 w-7 place-items-center rounded transition-colors ${
              fullscreen
                ? "bg-sky-500/15 text-sky-300"
                : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
            }`}
          >
            <ControlIcon name={fullscreen ? "compress" : "expand"} />
            <span className="sr-only">
              {fullscreen ? "exit fullscreen" : "enter fullscreen"}
            </span>
          </button>
        </div>

        {/* Sits under the control bar it belongs to, on the right, so it never
            covers the legend on the left or the search box above it. */}
        {showSettings && (
          <div className="absolute right-3 top-14 z-20 max-h-[calc(100%-4.5rem)] overflow-y-auto">
            <GraphSettingsPanel
              settings={settings}
              onChange={updateSettings}
              onReheat={() => {
                shouldFitRef.current = true;
                (fgRef.current as FgMethods | null)?.d3ReheatSimulation?.();
              }}
            />
          </div>
        )}

        {showLegend && (
          <GraphLegend
            types={meta.presentTypes}
            counts={meta.typeCounts}
            visible={visibleTypes}
            onToggle={toggleType}
          />
        )}

        {/* node detail card — persistent on click, distinct from the transient
            hover tooltip (the library's nodeLabel) */}
        {detail && (
          <div className="absolute right-3 top-14 z-20 w-72 rounded-lg border border-slate-800 bg-slate-950/95 p-3 shadow-xl">
            <div className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-0.5 shrink-0"
                style={{ color: TYPE_CSS[detail.type] }}
              >
                <NodeGlyph kind={TYPE_GLYPH[detail.type]} size={16} />
              </span>
              <p className="flex-1 text-sm font-medium leading-snug text-slate-100">
                {detail.title}
              </p>
              <button
                onClick={clearFocus}
                title="close"
                className="-mr-1 -mt-1 shrink-0 rounded px-1.5 text-slate-500 hover:bg-slate-800/60 hover:text-slate-200"
              >
                <span aria-hidden>×</span>
                <span className="sr-only">close detail card</span>
              </button>
            </div>

            {/* The domain, under the name: an entity here IS a host, and the
                name the model wrote for it is not always the one a reader
                recognises. */}
            {detail.domain && (
              <p className="mt-0.5 pl-6 font-mono text-[10px] text-slate-500">
                {detail.domain}
              </p>
            )}

            <dl className="mt-2.5 space-y-1.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">kind</dt>
                {/* The classifier's OWN word, not the four-colour bucket it
                    landed in. Six kinds share four `--type-*` colours (see
                    lib/kb-from-run.ts's KIND_GROUP), and this is where the
                    collapse is undone — a publisher and a subreddit are both
                    lavender on the canvas and must not read as the same thing
                    on the card. `scope` below carries the bucket. */}
                <dd className="text-slate-300">
                  {detail.kind}
                  {detail.isHub && (
                    <span className="ml-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-amber-300">
                      anchor
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">relation</dt>
                <dd
                  className="truncate text-slate-300"
                  title={RELATION_BLURB[detail.relation] ?? undefined}
                >
                  {detail.isOrphan ? (
                    <span
                      title="The classifier saw this host and would not place it against the anchor. It is on the map and connected to nothing — shown rather than dropped, because a map that reports none of these is usually a map that stopped looking."
                      className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-amber-300"
                    >
                      unplaced
                    </span>
                  ) : (
                    detail.relation
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">scope</dt>
                <dd className="truncate font-mono text-[10px] text-slate-400">
                  {groupLabel(detail.group)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                {/* Not "relevance". The bar is a RANK derived from the relation
                    above, not a measured score — see lib/kb-from-run.ts. */}
                <dt
                  className="text-slate-500"
                  title="How firmly the classifier placed this against the anchor. A rank derived from the relation, not a measurement."
                >
                  placement
                </dt>
                <dd className="tnum flex flex-1 items-center justify-end gap-2 text-slate-300">
                  <span
                    aria-hidden
                    className="h-1 flex-1 overflow-hidden rounded-full bg-slate-800"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.round(
                          (Math.max(0, detail.rel) / meta.maxRel) * 100,
                        )}%`,
                        background: "var(--accent)",
                      }}
                    />
                  </span>
                  {Math.round(detail.rel)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">neighbours</dt>
                <dd className="tnum text-slate-300">{detail.deg}</dd>
              </div>
            </dl>

            <div className="mt-3 flex gap-1.5">
              <button
                onClick={() => openNote(detail.id)}
                // white (non-flipping) on the blue fill: slate-950 flips to dark
                // ink in dark mode and muddied to ~3.7:1 on the same-hue fill.
                className="flex-1 rounded-md bg-sky-500/90 px-2 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-sky-400"
              >
                Open entity
              </button>
              <button
                onClick={() => focusFromDetail(detail)}
                className="rounded-md border border-slate-700 px-2 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-800/60"
              >
                Focus
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

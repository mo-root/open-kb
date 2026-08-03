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
import { GraphLegend } from "./GraphLegend";

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
  /** What this edge asserts. v1's edges were untyped wikilinks with nothing to
   *  say; every edge here carries the relation the classifier assigned, which
   *  is the whole content of the map. */
  relation: string;
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
  d3Force: (
    name: string,
    fn?: unknown,
  ) =>
    | {
        strength?: (v: unknown) => unknown;
        distance?: (v: unknown) => unknown;
        radius?: (v: unknown) => unknown;
      }
    | undefined;
  d3ReheatSimulation?: () => void;
  zoomToFit?: (ms?: number, px?: number) => void;
  centerAt?: (x?: number, y?: number, ms?: number) => void;
}

/* The pane's height is CSS, not a number: the ResizeObserver below reads the
   real box, so the canvas follows the viewport instead of a frozen 520px that
   letterboxed the graph on every screen taller than a laptop. min-h keeps it
   usable on short windows. */
const PANE_H = "h-[min(78dvh,900px)] min-h-[520px]";
const FALLBACK_H = 520; // only if clientHeight reads 0 mid-transition
const HUB_DEGREE_FRAC = 0.3; // node counts as a hub above this share of node count
const STAR_EDGE_FRAC = 0.4; // banner threshold: one node carrying > this share of edges
const TOP_LABELS = 6; // top-N by relevance get an always-on label
const DARK_INK = "rgba(10,20,31,0.9)"; // glyph ink drawn on bright node fills
// Near-paper chip drawn behind a competitor favicon. Held constant across
// themes, like the node palette, so a dark-on-transparent brand mark always
// reads, whether the page is light or dark.
const FAVICON_BACKING = "#F2F6FF";
// Only paint a favicon once the node is ≥ ~16px across on screen; smaller than
// this the mark turns to mush, so we keep the crisp type glyph instead.
const FAVICON_MIN_SCREEN_R = 8;

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
  name: "expand" | "compress" | "reset" | "filter";
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
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverLink, setHoverLink] = useState<FLink | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusSet, setFocusSet] = useState<Set<string> | null>(null);
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

  // Competitor favicons for player nodes, keyed by reconstructed domain. Held in
  // a ref (survives interaction renders) with a per-entry ok flag so the paint
  // decides favicon-vs-glyph off cached state, never re-touching the network.
  const faviconCacheRef = useRef<Map<string, { img: HTMLImageElement; ok: boolean }>>(
    new Map(),
  );
  // Bump-only counter: an async favicon load flips autoPauseRedraw's engine off,
  // so we force one React render, the fresh nodeCanvasObject closure makes the
  // kapsule repaint (no simulation reheat, layout untouched).
  const [, forceRepaint] = useState(0);
  const bumpFavicon = useCallback(() => forceRepaint((n) => n + 1), []);

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
      degById, adj, maxRel, share, maxTitle, hubId,
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
      const angle = rng() * Math.PI * 2;
      const radius = type === "core" ? 20 + rng() * 60 : 100 + rng() * 90;
      return {
        id: n.id,
        title: n.title,
        type,
        group: n.group,
        kind: n.kind,
        relation: n.relation,
        rel: n.relevance || 0,
        deg,
        hub: deg > nodeCount * HUB_DEGREE_FRAC,
        isHub: n.id === meta.hubId,
        isOrphan: n.relation === "none",
        r: 4 + Math.sqrt(rel / meta.maxRel) * 12, // honest sqrt scale, 4–16px
        domain: type === "player" ? n.domain || undefined : undefined,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
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
          hubLink: s.hub || t.hub,
          relation: l.label ?? "",
        };
      });
    return { nodes, links, byId };
  }, [graph, meta, slug, resetSeed, showUnplaced]);

  const nodeCount = Math.max(1, data.nodes.length);

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
      // Charge scales with degree so well-connected nodes claim more space.
      // Every edge here is a relation the classifier asserted, so this responds
      // to real connectivity, which in a star means the anchor, and only the
      // anchor, pushes hard.
      fg.d3Force("charge")?.strength?.(
        (n: FNode) => -30 * (1 + (n.deg / nodeCount) * 3),
      );
      // Springs: every edge is semantic, so the graph can afford long, firm
      // links without collapsing.
      const link = fg.d3Force("link");
      link?.distance?.((l: FLink) => (l.hubLink ? 110 : 55));
      link?.strength?.((l: FLink) => (l.hubLink ? 0.2 : 0.5));
      // Collision: nodes stop overlapping. There was no collide force at all
      // before, which is why favicons sat on top of each other. r is in graph
      // units (4-16); the pad keeps labels and favicon chips clear.
      fg.d3Force(
        "collide",
        forceCollide<FNode>()
          .radius((n) => n.r + 6)
          .strength(0.9),
      );
      // Tether toward the origin. This is the force that makes the unplaced
      // showable at all: an entity with `relation: "none"` has no edge, so no
      // spring holds it, charge repulsion pushes it to infinity, and zoomToFit
      // measures it, a handful of escapees drag the bounding box wide and
      // shrink the real cluster to nothing.
      // Hiding them would be dishonest (they are genuine hosts the run found),
      // so they are held in frame instead: barely-there for connected nodes,
      // firm for the disconnected.
      // 0.09 was not enough: repulsion throws an orphan outward early, and
      // alpha decays before a weak tether can walk it back. It has to win
      // outright from the first tick.
      const pull = (n: FNode) => (n.deg === 0 ? 0.34 : 0.012);
      fg.d3Force("x", forceX<FNode>(0).strength(pull));
      fg.d3Force("y", forceY<FNode>(0).strength(pull));
      // per-type centroid pull, segments loosely group
      fg.d3Force("cluster", makeClusterForce());
      fg.d3ReheatSimulation?.();
    };
    apply();
    return () => cancelAnimationFrame(raf);
  }, [data, nodeCount]);

  // Preload competitor favicons for player nodes (client-only, new Image()
  // touches the DOM). DuckDuckGo's icon service maps a domain to a small .ico;
  // we cache the Image per domain and repaint once each settles. onerror also
  // repaints so the glyph fallback appears promptly instead of waiting on a
  // frame that autoPauseRedraw may never schedule.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const cache = faviconCacheRef.current;
    for (const n of data.nodes) {
      if (n.type !== "player" || !n.domain || cache.has(n.domain)) continue;
      const img = new Image();
      const entry = { img, ok: false };
      cache.set(n.domain, entry);
      img.onload = () => {
        entry.ok = img.naturalWidth > 1 && img.naturalHeight > 1;
        bumpFavicon();
      };
      img.onerror = () => {
        entry.ok = false;
        bumpFavicon();
      };
      img.src = `https://icons.duckduckgo.com/ip3/${n.domain}.ico`;
    }
  }, [data, bumpFavicon]);

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
    setHoverId(null);
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
    if (center && n.x != null && n.y != null)
      (fgRef.current as FgMethods | null)?.centerAt?.(n.x, n.y, 400);
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
    if (hoverId) {
      const inc = s === hoverId || t === hoverId;
      return hexToRgba(palette.dataflow, inc ? 0.55 : 0.05);
    }
    if (focusId) {
      const inc = s === focusId || t === focusId;
      return hexToRgba(palette.dataflow, inc ? 0.55 : 0.03);
    }
    return hexToRgba(palette.dataflow, 0.1);
  };
  const linkWidth = (l: FLink) => {
    const s = endId(l.source);
    const t = endId(l.target);
    if (l === hoverLink) return 1.9;
    if (hoverId) return s === hoverId || t === hoverId ? 1.6 : 1;
    if (focusId) return s === focusId || t === focusId ? 1.6 : 1;
    return 1;
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
    const r = n.r;
    const isHover = n.id === hoverId;
    const isFocus = n.id === focusId;

    // dim non-neighbours of the hovered (or, absent hover, the focused) node
    let bright = true;
    if (hoverId) bright = isHover || (meta.adj.get(hoverId)?.has(n.id) ?? false);
    else if (focusId) bright = focusSet?.has(n.id) ?? true;
    const alpha = bright ? (isHover ? 1 : 0.95) : 0.12;
    ctx.globalAlpha = alpha;

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
    ctx.fillStyle = palette.type[n.type];
    ctx.fill();
    ctx.shadowBlur = 0;

    if (isHover || isFocus) {
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
    const fav =
      n.type === "player" && n.domain
        ? faviconCacheRef.current.get(n.domain)
        : undefined;
    const showFavicon =
      !!fav?.ok && fav.img.complete && screenR >= FAVICON_MIN_SCREEN_R;

    if (showFavicon && fav) {
      const rim = Math.max(1, r * 0.18); // pink identity ring kept around the chip
      const ir = Math.max(1, r - rim); // favicon (and paper backing) radius
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, ir, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = FAVICON_BACKING; // paper backing so transparent marks read
      ctx.fill();
      ctx.clip();
      ctx.drawImage(fav.img, x - ir, y - ir, ir * 2, ir * 2);
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

    // labels: hover/focus bright, a small focus neighbourhood, and the top-N by
    // relevance (plus the hub) always on. Kept ~constant on screen via 1/scale.
    const smallFocus = (focusSet?.size ?? 0) <= 15;
    const showLabel =
      isHover ||
      isFocus ||
      (focusId != null && bright && smallFocus) ||
      ((meta.topSet.has(n.id) || n.isHub) && (focusId == null || bright));
    if (showLabel && bright) {
      const fpx = Math.max(9, 11 / scale);
      ctx.font = `${isHover || isFocus ? "500 " : ""}${fpx}px ${palette.font}`;
      ctx.fillStyle = isHover || isFocus ? palette.text : palette.muted;
      ctx.textBaseline = "alphabetic";
      // Halo the label in the page surface (theme-aware): a paper cut-out in
      // light mode, a dark cut-out when --bg flips to navy, so ink labels stay
      // legible against the canvas in both.
      ctx.shadowColor = hexToRgba(palette.paper, 0.85);
      ctx.shadowBlur = 4;
      ctx.fillText(truncate(n.title, 28), x, y + r + 13 / scale);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
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
          onNodeHover={(n: FNode | null) => setHoverId(n ? n.id : null)}
          onLinkHover={(l: FLink | null) => setHoverLink(l)}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={(n: FNode) => openNote(n.id)}
          onBackgroundClick={clearFocus}
          warmupTicks={reduceMotion ? Math.min(400, nodeCount * 4) : 0}
          cooldownTicks={reduceMotion ? 0 : Math.min(400, 200 + nodeCount)}
          d3AlphaDecay={0.014}
          d3VelocityDecay={0.28}
          minZoom={0.4}
          maxZoom={8}
          // The library pauses redrawing once the engine settles, which leaves
          // any camera animation (zoomToFit) smearing over a stale canvas. At
          // ~100 nodes the cost of always redrawing is not worth that class of
          // bug.
          autoPauseRedraw={false}
          onEngineStop={() => {
            if (!shouldFitRef.current) return;
            shouldFitRef.current = false;
            (fgRef.current as FgMethods | null)?.zoomToFit?.(400, 56);
          }}
        />

        {/* compact control bar — filters / reset / fullscreen. There is
            deliberately no export button: see the canvas-taint note in
            nodeCanvasObject. */}
        <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950/85 p-1 shadow-lg">
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

import Link from "next/link";
import { NodeGlyph } from "@/components/icons";
import type { GlyphKind } from "@/components/icons";
import { builtAtOf, manifestStr } from "@/components/kb/layerMeta";
import type { KbSummary } from "@/lib/viewTypes";

// One KB rendered as an intelligence card:
//   · prov-rail left edge encodes how much of the market got placed
//   · composition bar splits the market into product/player/community mass
//   · glyph counts read the same marks as the graph legend
//   · amber "N unplaced" / emerald "all placed" badge, mono built-date stamp
//
// port NOTE, THE badge. v1 badged `manifest.violations` here: green "verified",
// titled "Every claim is cited, every link resolves, nothing is unsourced, the
// KB passed all integrity checks". This engine runs NO integrity check, and
// `manifestNum(m, "violations") ?? 0` would have rendered that green badge on
// every card, an unearned pass on a test that was never taken, which is the
// exact failure mode this project exists to avoid.
//
// So the slot carries the number that IS measured: how many entities the
// classifier put on the map and then would not place against the anchor
// (`relation: "none"`). It is the most honest number a map has, it is often a
// large fraction of the map, and hiding it would make every run look finished.
type Stat = { glyph: GlyphKind; label: string; value: number; className: string };

export function KbCard({ kb }: { kb: KbSummary }) {
  const m = kb.manifest;
  const c = kb.counts;
  const unplaced = kb.unplaced;
  // The rail reads "how much of this map is actually wired to the anchor" —
  // the one health signal that is real here.
  const placedPct =
    kb.notes > 1 ? Math.round(((kb.notes - 1 - unplaced) / (kb.notes - 1)) * 100) : 0;

  // Counts come from the reader, which tallies the notes actually on disk with
  // registry notes excluded, never from a manifest field, because the manifest
  // records what a build *harvested* and those are different numbers (see the
  // O1 note in components/kb/KbBrowser.tsx).
  const products = c.product;
  const players = c.player;
  const communities = c.community;

  // Composition segments, in graph-legend order; zero-mass segments drop out.
  const segments = [
    { key: "products", value: products, color: "var(--type-product)" },
    { key: "players", value: players, color: "var(--type-player)" },
    { key: "communities", value: communities, color: "var(--type-community)" },
  ].filter((s) => s.value > 0);
  const mass = segments.reduce((sum, s) => sum + s.value, 0);

  // Glyph counts double as the composition bar's legend, and every one of them
  // now reads the same --type-* var its segment does.
  //
  // Community used to be the exception here: the old lavender landed at ~1.6:1
  // on the light card, so the standalone mark had to borrow the violet ramp
  // while the bar segment kept the token — chip and segment were two different
  // colours for one concept. --type-community is a validated orange that holds
  // contrast on paper and on navy, so the workaround is gone and the mark
  // matches its segment again.
  const allStats: Stat[] = [
    { glyph: "docs", label: "notes", value: kb.notes, className: "text-slate-400" },
    { glyph: "product", label: "products", value: products, className: "text-[var(--type-product)]" },
    { glyph: "player", label: "players", value: players, className: "text-[var(--type-player)]" },
    { glyph: "community", label: "communities", value: communities, className: "text-[var(--type-community)]" },
  ];
  const stats = allStats.filter((s) => s.value > 0);

  const built = builtAtOf(m);
  // v1 titled the card with the slug and subtitled it with the brand. A slug
  // here is a run UUID, which names nothing a reader recognises, so the two
  // swap: the domain leads and the run id is the fine print.
  const title = manifestStr(m, "brand", "root", "input") ?? kb.slug;
  /* The run id, cut where it still says something.
     `slug.slice(0, 8)` was written for UUID runs, where the first eight
     characters are the only part anyone can quote. Named runs are shaped
     `clerk-com-202608041037`, and eight characters of that is "clerk-co" — so
     three different maps of the same domain all wore the same subtitle and the
     one line meant to tell them apart told the reader nothing. A named slug
     keeps the part a UUID does not have: the timestamp that distinguishes it. */
  const stamp = /^\d{8,}$/.test(kb.slug.slice(kb.slug.lastIndexOf("-") + 1))
    ? kb.slug.slice(kb.slug.lastIndexOf("-") + 1)
    : null;
  const subtitle = stamp
    ? `run ${stamp.slice(0, 8)}·${stamp.slice(8)}`
    : `run ${kb.slug.slice(0, 8)}`;

  return (
    <Link
      href={`/kb/${kb.slug}`}
      className="prov-rail group block rounded-lg border border-slate-800 bg-slate-900/40 p-4 pl-5 transition duration-200 hover:-translate-y-0.5 hover:border-slate-700 hover:bg-slate-900/70 hover:shadow-[0_18px_40px_-24px_rgba(61,127,252,0.5)]"
      style={{ "--rel": placedPct } as React.CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-display text-[15px] font-semibold text-slate-200 group-hover:text-sky-300">
            {title}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-slate-500">
            {subtitle}
          </div>
        </div>
        {unplaced > 0 ? (
          <span
            title="Entities the classifier put on the map and then would not connect to the anchor. Named rather than hidden — a map that reports none is usually a map that stopped looking."
            className="tnum inline-flex shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-300"
          >
            <NodeGlyph kind="alert" size={12} className="text-amber-300" />
            {unplaced} unplaced
          </span>
        ) : (
          <span
            title="Every entity on this map carries a relation to the anchor."
            className="inline-flex shrink-0 items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300"
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_1px_rgba(0,224,255,0.6)]"
            />
            all placed
          </span>
        )}
      </div>

      {/* composition bar — market mass by node type */}
      {mass > 0 && (
        <div
          className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800/70"
          role="img"
          aria-label={`Composition: ${segments
            .map((s) => `${s.value} ${s.key}`)
            .join(", ")}`}
        >
          {segments.map((s) => (
            <span
              key={s.key}
              className="h-full first:rounded-l-full last:rounded-r-full"
              title={`${s.value} ${s.key}`}
              style={{ width: `${(s.value / mass) * 100}%`, backgroundColor: s.color }}
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-800/60 pt-2.5 text-[11px] text-slate-400">
        {stats.map((s) => (
          <span
            key={s.label}
            className="inline-flex items-center gap-1"
            aria-label={`${s.value} ${s.label}`}
            title={s.label}
          >
            <NodeGlyph kind={s.glyph} size={13} className={s.className} />
            <span className="tnum text-slate-200">{s.value}</span>
          </span>
        ))}
        {built && (
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-slate-500">
            {built.slice(0, 10)}
          </span>
        )}
      </div>
    </Link>
  );
}

import Link from "next/link";
import { NodeGlyph } from "@/components/icons";
import type { GlyphKind } from "@/components/icons";
import { builtAtOf, manifestStr } from "@/components/kb/layerMeta";
import type { KbSummary } from "@/lib/viewTypes";

// One KB rendered as an intelligence card:
//   · prov-rail left edge encodes how much of the market got placed
//   · composition bar splits the market into product/player/community mass
//   · glyph counts read the same marks as the graph legend
//   · mono built-date stamp (the unplaced badge was removed; see below)
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

/** How many markets a showcase card names before it stops and counts the rest.
 *  Three, measured on the six committed maps at the three-column breakpoint:
 *  the chips are full market names and wrap to two or three lines already, and
 *  a fourth pushes the tallest card (stripe, nine markets) past its neighbours
 *  without telling the reader anything the `+5` does not. The cap is what keeps
 *  this a card rather than a list of markets with a domain on top. */
const MARKETS_SHOWN = 3;

/**
 * `showcase` — the same card, saying more.
 *
 * TWO SURFACES, TWO QUESTIONS, and that is the whole reason this is a prop
 * rather than the default. /kb is a dense grid of every run this deployment
 * holds — thirty-six of them, most of the same handful of domains — and the
 * reader's question there is *which one*: the domain, the size, the date. A
 * chip row per card would add a hundred chips to that page and answer nobody.
 *
 * The demo home shows SIX, chosen, and the reader has not decided to open a
 * map yet — their question is *why*. The two extra facts are the two that
 * answer it: how many relations the run drew between the entities (a map, not
 * a list) and which markets it found (what is actually in there).
 *
 * Everything else is identical on purpose. A showcase card is this card, and a
 * visitor who clicks one and lands in /kb should not feel they changed app.
 */
export function KbCard({ kb, showcase = false }: { kb: KbSummary; showcase?: boolean }) {
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

  /* The markets, as provenance drew them. `segments` is already derived off
     `foundBy` in the reading layer — this renders it and infers nothing.
     "unattributed" is dropped here and only here: it is the run's honest
     remainder rather than a market it found, and a chip claiming otherwise
     would be the one dishonest mark on the card. The count it leaves behind is
     not hidden — those entities are in `notes` like every other. */
  const markets = showcase ? kb.segments.filter((s) => s.name !== "unattributed") : [];
  const shownMarkets = markets.slice(0, MARKETS_SHOWN);
  const restMarkets = markets.length - shownMarkets.length;

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
  // Width-aware, because the stamp got two digits longer. `stamp.slice(8)` was
  // written when every stamp was yyyymmddhhmm and rendered the tail as `hhmm`;
  // a seconds stamp made that `hhmmss`, six unseparated digits in the one field
  // whose whole job — see above — is telling repeat maps of a domain apart. The
  // twelve-digit rendering is byte-identical to what it was.
  const subtitle = stamp
    ? `run ${stamp.slice(0, 8)}·${stamp.slice(8, 12)}${stamp.length > 12 ? `:${stamp.slice(12)}` : ""}`
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
        {/* NO BADGE HERE ANY MORE. This corner carried "N unplaced" in amber
            on every card, so the loudest mark on a gallery of finished maps was
            a count of what the engine could not connect. On stripe.com that is
            485 against 2,522 entities, and a reader skimming six cards reads
            six warnings rather than six maps.

            The number is not hidden, only demoted: it is on the map's own
            header and on its overview, where somebody already looking at that
            run will find it. A gallery is a place to choose what to open. */}
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

      {/* the markets this run found — showcase only, see the prop's note */}
      {shownMarkets.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap items-center gap-1">
          {shownMarkets.map((s) => (
            <li
              key={s.name}
              title={`${s.size} ${s.size === 1 ? "entity" : "entities"} surfaced by this market's queries`}
              /* `KIND_TONES.product` from components/ui.tsx, spelled out rather
                 than imported: a market is the anchor's product side, and this
                 is the tone this app already gives that.
                 NOT `--type-product`, which is what the graph paints market
                 NODES with, and the difference is measured. That token is
                 #3D7FFC in both themes — brand law fixes it — and globals.css
                 reserves it for fills, underbars and dots because on paper it
                 lands near 4:1, under the floor for text this small. The sky
                 ramp re-keys per theme (#2E6BE0 on paper at ~5:1, #76A5FF on
                 navy), so the chip stays the same blue idea and stays readable
                 in both. */
              className="inline-flex max-w-full items-center rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300"
            >
              <span className="max-w-[12rem] truncate">{s.name}</span>
            </li>
          ))}
          {restMarkets > 0 && (
            <li className="font-mono text-[10px] text-slate-500">+{restMarkets}</li>
          )}
        </ul>
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
        {/* Edges carry a word rather than a glyph. Every mark in the icon set
            names a KIND of node, and the one that looks like a graph is already
            spoken for by communities — a second use of it on the same row would
            read as a second community count. */}
        {showcase && kb.edges > 0 && (
          <span
            className="inline-flex items-center gap-1"
            aria-label={`${kb.edges} edges between entities`}
            title="Relations the run recorded between two entities — what makes this a map rather than a list. The graph draws the ones whose ends are both on it."
          >
            <span className="tnum text-slate-200">{kb.edges}</span>
            <span className="text-slate-500">edges</span>
          </span>
        )}
        {built && (
          /* A showcase card gives the date its own line. The edges item pushes
             this footer past one row on most maps and not on the shortest, so
             letting it wrap where it happens to wrap made five of the six cards
             two rows tall and the sixth one row — six specimens that should read
             as one set, laid out two different ways. The gallery card, whose
             footer still fits, keeps `ml-auto` and is unchanged. */
          <span
            className={`font-mono text-[10px] uppercase tracking-wider text-slate-500 ${
              showcase ? "w-full text-right" : "ml-auto"
            }`}
          >
            {built.slice(0, 10)}
          </span>
        )}
      </div>
    </Link>
  );
}

import Link from "next/link";
import { builtAtOf, manifestStr } from "@/components/kb/layerMeta";
import type { KbSummary } from "@/lib/viewTypes";

// One KB rendered as an intelligence card:
//   · prov-rail left edge encodes how much of the market got placed
//   · one headline count — how many companies are in this market
//   · the markets provenance drew (showcase)
//   · the evidence under it, and a mono built-date stamp
//
// port NOTE, THE badge. v1 badged `manifest.violations` here: green "verified",
// titled "Every claim is cited, every link resolves, nothing is unsourced, the
// KB passed all integrity checks". This engine runs NO integrity check, and
// `manifestNum(m, "violations") ?? 0` would have rendered that green badge on
// every card, an unearned pass on a test that was never taken, which is the
// exact failure mode this project exists to avoid.
//
// WHAT THE ROW OF GLYPHS WAS AND WHY IT IS GONE. Until this commit the footer
// carried four bare marks with numbers — notes / products / players /
// communities — filtered by a `KIND_FLOOR = 50` that dropped any kind count
// under fifty. Three faults, all measured on the six committed maps:
//
//   · the floor made the field set per-card. stripe.com printed three numbers
//     (2,522 · 1,272 · 772) and brightdata.com printed four (910 · 52 · 404 ·
//     453), so a grid of six specimens showed six different cards.
//   · the glyphs were documented as the composition bar's legend, so a hidden
//     chip left the bar with a band nothing explained. brightdata.com's bar had
//     a 52-wide blue product band and no blue chip; clerk.com's had a 2-wide
//     pink player band and no pink chip.
//   · nothing was labelled. `2522 1272 772 3017` is not four facts, it is a
//     row of numbers, and the floor existed only to hide "1 player" — which was
//     never a small market, it was the classifier calling 1,272 companies
//     `product` and one of them `company`.
//
// One labelled headline replaces all of it. See `companyCount` in
// lib/nodeTypes.ts for why the headline is a union and not `counts.player`.

/** How many markets a showcase card names before it stops and counts the rest.
 *  Three, measured on the six committed maps at the three-column breakpoint:
 *  the chips are full market names and wrap to two or three lines already, and
 *  a fourth pushes the tallest card (stripe, nine markets) past its neighbours
 *  without telling the reader anything the `+5` does not. The cap is what keeps
 *  this a card rather than a list of markets with a domain on top. */
const MARKETS_SHOWN = 3;

/** Thousands separators, because the numbers on this card run to four digits.
 *  `2522` and `3017` side by side read as one long number; `2,522 · 3,017`
 *  reads as two. Fixed locale: the card is rendered on the server and must not
 *  come out differently depending on where the server is. */
const n = (v: number) => v.toLocaleString("en-US");

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
 * answer it: which markets the run found (what is actually in there) and how
 * many relations it drew between the entities (a map, not a list).
 *
 * Everything else is identical on purpose. A showcase card is this card, and a
 * visitor who clicks one and lands in /kb should not feel they changed app.
 *
 * WITHIN EACH SURFACE THE FIELD SET IS FIXED, which is the property the old
 * glyph row did not have. Every card carries a domain, a run stamp, a headline
 * count, an entity count and a date, whatever the numbers are — a market with
 * no companies in it prints `0 companies in this market` rather than dropping
 * the line, because the reader can argue with a zero and cannot argue with an
 * absence. The two showcase rows are conditional on the run having recorded
 * the field at all (see each), and on the six committed maps both are present
 * on all six: markets 5 · 3 · 3 · 8 · 4 · 2, links 487 · 517 · 1,796 · 3,017 ·
 * 2,351 · 6,283.
 */
export function KbCard({ kb, showcase = false }: { kb: KbSummary; showcase?: boolean }) {
  const m = kb.manifest;
  const unplaced = kb.unplaced;
  // The rail reads "how much of this map is actually wired to the anchor" —
  // the one health signal that is real here.
  const placedPct =
    kb.notes > 1 ? Math.round(((kb.notes - 1 - unplaced) / (kb.notes - 1)) * 100) : 0;

  /* THE HEADLINE, and the only count on the card that names a kind.
     `kb.companies`, NOT `counts.player + counts.product`. The two differ by the
     rows the run judged to sell into a DIFFERENT market — 20.1% of every
     company-like row across the stored corpus, and 38.5% on figma — and the
     headline says "in this market", which is the opposite of what the run
     concluded about them. `summaryOf` builds it with the engine's own `onMap`
     so the reader and the writer cannot disagree; see `KbSummary.companies`.
     The count comes from the reader, which tallies the notes actually on disk
     with registry notes excluded, never from a manifest field, because the
     manifest records what a build *harvested* and those are different numbers
     (see the O1 note in components/kb/KbBrowser.tsx). */
  const companies = kb.companies;

  /* THE COMPOSITION BAR IS GONE, and this is the argument rather than a
     preference. It split the map into product / player / community mass under
     `role="img"` and the label "Composition", and it was three things it did
     not say it was:

       · not the composition of the map. Its mass excluded `core`, which is
         where every unreadable host lands — 476 of stripe.com's 2,522 entities
         and 383 of vercel.com's 2,333. The bar drew 81% and 84% of those maps
         and named itself after all of it.
       · not stable across the taxonomy merge. `product` is blue and `player`
         is pink, and the same concept lands in different colours depending on
         when the run happened: stripe.com renders 1,272 blue against 1 pink,
         brightdata.com 52 blue against 404 pink. Two maps of two markets, and
         the loudest difference between the cards is which afternoon the
         classifier ran.
       · not legible without the glyph row, which was its documented legend and
         which the floor was hiding — see the note at the top of this file.

     A two-segment companies-vs-channels bar over the whole map would fix all
     three, and it would still be a bar carrying one ratio that the headline
     and the entity count already let a reader compute. So it goes, and the
     card is a headline, its markets, and its evidence. */

  /* The markets, as provenance drew them. `segments` is already derived off
     `foundBy` in the reading layer — this renders it and infers nothing.
     "unattributed" is dropped here and only here: it is the run's honest
     remainder rather than a market it found, and a chip claiming otherwise
     would be the one dishonest mark on the card. The count it leaves behind is
     not hidden — those entities are in the entity count like every other. */
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

      {/* THE ONE NUMBER THE CARD ARGUES FOR. Sized like a headline because it
          is one: everything under it is the evidence for it. The title spells
          out both edges of the set, because "companies" is a claim and the two
          things it leaves out — hosts the run could not read, and the venues
          this market is discussed in — are 19% and 31% of a map like
          stripe.com. A reader who wants those has the map. */}
      <div
        className="mt-3 flex items-baseline gap-2"
        title="Companies this run placed in the anchor's market. Hosts it judged to sell into a different market are not counted, nor are hosts whose kind it never settled, nor the publishers, directories and communities this market is discussed in."
      >
        <span className="tnum text-2xl font-semibold leading-none text-slate-100">
          {n(companies)}
        </span>
        <span className="text-[11px] text-slate-400">
          {companies === 1 ? "company" : "companies"} in this market
        </span>
      </div>

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

      <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-slate-800/60 pt-2.5 text-[11px] text-slate-400">
        {/* THE EVIDENCE LINE. `notes` is the whole map — the anchor, the
            companies above, the channels and the hosts the run could not read
            — so it is the denominator the headline is a fraction of, and it is
            on every card because every run has one.

            "entities", not "sources", and the deviation from the agreed sketch
            is one measured word. Every note does carry exactly one source in
            this codebase's model (its own host — see `noteOf` in
            lib/kb-from-run.ts), but 476 of stripe.com's 2,522 and 383 of
            vercel.com's 2,333 are hosts whose front page could not be read at
            all (`unreadableReason: http-403 / thin-render`), and calling a page
            nobody could open a source is the same unearned claim as the green
            badge at the top of this file. It is also the word the ledger
            directly above these six cards already uses (`DemoHome`'s "8,569
            entities"), and one number wearing two names on one screen is the
            complaint this card was rewritten to answer. */}
        <span className="tnum" title="Everything on this map: the anchor, the companies counted above, the venues this market is discussed in, and the hosts the run found and could not read.">
          <span className="text-slate-200">{n(kb.notes)}</span> entities
        </span>
        {/* Relations carry a word rather than a glyph. Every mark in the icon
            set names a KIND of node, and the one that looks like a graph is
            already spoken for by communities — a second use of it on the same
            row would read as a second community count. */}
        {showcase && kb.edges > 0 && (
          <>
            <span aria-hidden className="text-slate-700">
              ·
            </span>
            {/* Not "0 links" when there are none. `SweepResult.edges` is
                optional, so zero can mean the run measured no relations OR
                that it predates the field, and a card asserting a flat market
                it never looked for is the more expensive of the two readings
                to be wrong about. All six committed maps recorded some. */}
            <span
              className="tnum"
              title="Relations the run recorded between two entities — what makes this a map rather than a list. The graph draws the ones whose ends are both on it."
            >
              <span className="text-slate-200">{n(kb.edges)}</span> links
            </span>
          </>
        )}
        {built && (
          /* A showcase card gives the date its own line. The links item pushes
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

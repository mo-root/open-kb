"use client";

import { useEffect, useMemo, useState } from "react";
import type { NoteRef, NoteView as NoteData } from "@/lib/viewTypes";
import {
  FAMILY_TONE,
  GROUNDING_ENTITY_BLURB,
  RELATION_BLURB,
  TIER_BLURB,
} from "@/lib/viewTypes";
import { SiteIcon } from "@/components/SiteIcon";
import { KindChip, RelevanceBadge, TierBadge, TypeChip } from "@/components/ui";

/* ---------------------------------------------------------------------------
   PORT NOTE (open-kb) — from a markdown reader to an entity reader.

   v1's NoteView fetched a markdown NOTE and rendered its body: a 300-line block
   parser (headings, GFM tables, fences, blockquotes) feeding the `.note-prose`
   container, `transformWikilinks` rewriting `[[links]]` into two private URL
   schemes, and a `## Relationships` section lifted out and drawn as typed
   chips. Upstream of that it was react-markdown + remark-gfm; the parser
   existed only because neither package was a dependency here.

   None of that has an input any more. This engine writes no markdown, so there
   is no body to parse and no wikilink to resolve — a parser kept "just in case"
   would be 300 lines nothing can reach, and the one thing worse than a missing
   feature is a maintained illusion of one.

   What IS kept is the visual language, slot for slot, because the entity has a
   fact for every slot the note had:

     v1 note                          this entity
     ------------------------------   -----------------------------------------
     relevance badge + note path      placement badge + node id
     title                            the classifier's name for the host
     evidence box                     `why` — why it belongs on this map
     sources (host + retrieved date)  the host itself, linked
     body prose (.note-prose)         `what` — what it is, one line
     relationship chips               the one real edge (the anchor), plus the
                                      entities placed the same way

   The `.note-prose` container is still what wraps the prose, so globals.css
   styles this page without a single rule changing.
--------------------------------------------------------------------------- */

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/* The shape of an entity, drawn before the entity arrives.
   The line "Loading entity…" that stood here was one line tall, so the reading
   column collapsed and then sprang back on every click — arrowing down the
   sidebar made the whole page jump once per keystroke. The skeleton occupies
   the header, the evidence box and the first lines of prose, which is where
   they will actually be, so the fetch lands into a page that has not moved. */
function EntitySkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading entity">
      <div className="mb-5 border-b border-slate-800 pb-4">
        <div className="mb-3 flex gap-2">
          <div className="skeleton h-[18px] w-16" />
          <div className="skeleton h-[18px] w-20" />
          <div className="skeleton h-[18px] w-24" />
        </div>
        <div className="flex items-center gap-2.5">
          <div className="skeleton h-6 w-6 rounded" />
          <div className="skeleton h-7 w-64 max-w-full" />
        </div>
        <div className="skeleton mt-3 h-16 w-full rounded-md" />
      </div>
      <div className="space-y-2">
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-11/12" />
        <div className="skeleton h-4 w-2/3" />
      </div>
    </div>
  );
}

export function NoteView({
  slug,
  path,
  notes,
  openNote,
}: {
  slug: string;
  path: string;
  notes: NoteRef[];
  openNote: (p: string) => void;
}) {
  const [note, setNote] = useState<NoteData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // NotesTab remounts this component per entity (via key), so state starts
    // fresh (loading=true) without a synchronous setState in the effect body.
    let cancelled = false;
    fetch(`/api/kb/${slug}/note?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`,
          );
        return r.json();
      })
      .then((data: NoteData) => {
        if (!cancelled) setNote(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, path]);

  const anchor = useMemo(
    () => notes.find((n) => n.path === "company.md") ?? null,
    [notes],
  );

  /* The chips. v1 drew whatever a note's `## Relationships` section wikilinked
     to; the two rows here are the only two things this map can substantiate:

       1. the ONE edge that exists — this entity to the anchor, or, on the
          anchor's own page, its strongest placements;
       2. the entities the classifier placed the SAME way. That is a
          co-classification and not an asserted relationship between them, so it
          is labelled as one rather than filed under "relationships". */
  const siblings = useMemo(() => {
    if (!note || note.relation === "anchor" || note.relation === "none") return [];
    return notes
      .filter((n) => n.relation === note.relation && n.path !== note.path)
      .slice(0, 12);
  }, [note, notes]);

  const strongest = useMemo(() => {
    if (!note || note.relation !== "anchor") return [];
    return notes.filter((n) => n.path !== "company.md" && n.relation !== "none").slice(0, 12);
  }, [note, notes]);

  if (loading) return <EntitySkeleton />;
  if (error || !note) {
    return (
      <div className="p-6 text-sm text-rose-300">{error ?? "Entity unavailable"}</div>
    );
  }

  const sources = Array.isArray(note.sources) ? note.sources : [];
  const isAnchor = note.relation === "anchor";
  const unplaced = note.relation === "none";

  return (
    <article className="min-w-0">
      <header className="mb-5 border-b border-slate-800 pb-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {typeof note.relevance === "number" && (
            <RelevanceBadge value={note.relevance} />
          )}
          <KindChip kind={note.kind} />
          {/* The provenance ladder, worn where the kind badge lives: a swarm
              run stamps each entity with where its best evidence came from,
              and a reader deciding how far to trust a row should not have to
              open the raw run JSON to find out. */}
          {note.tier && (
            <TierBadge tier={note.tier} title={TIER_BLURB[note.tier]} />
          )}
          {unplaced ? (
            <span
              title="The classifier saw this host and would not place it against the anchor. It is on the map and connected to nothing — shown rather than dropped."
              className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
            >
              unplaced
            </span>
          ) : (
            !isAnchor && (
              <span
                title={RELATION_BLURB[note.relation] ?? undefined}
                className="inline-flex items-center rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-300"
              >
                {note.relation}
              </span>
            )
          )}
          <span className="font-mono text-[11px] text-slate-500">{note.path}</span>
          {note.families?.map((f) => (
            <span
              key={f}
              title={`surfaced by a ${f} query`}
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                FAMILY_TONE[f] ?? "border-slate-700 text-slate-400"
              }`}
            >
              found via {f}
            </span>
          ))}
          {/* The kernel's grounding meter for this one description. Subtle on
              purpose, and the gloss is explicit that this is a drift meter
              for embellished wording, not the share of the sentence that is
              true — the honest framing the morning report established. */}
          {typeof note.descGrounded === "number" && (
            <span
              title={GROUNDING_ENTITY_BLURB}
              className="tnum font-mono text-[10px] text-slate-500"
            >
              desc grounded {note.descGrounded.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <SiteIcon domain={note.domain} name={note.title} size={24} />
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            {note.title || note.path}
          </h1>
        </div>
        {note.evidence && (
          <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-400">
            <span className="mr-2 text-[11px] uppercase tracking-wide text-slate-500">
              {isAnchor ? "buyer" : "why it is on this map"}
            </span>
            {note.evidence}
          </div>
        )}
        {/* The single fact that settled `kind` and `relation` — not `evidence`
            restated, the fact that made it true. Model-judged entities only
            (`.optional()` on the classify schema), so most rows render
            nothing here rather than an empty line. A plain caption under the
            evidence box, not a box of its own: it is a footnote to the claim
            above it, not a second claim. */}
        {note.reasoning && (
          <div className="mt-2 text-xs text-slate-500">
            <span className="mr-2 uppercase tracking-wide text-slate-600">
              the decisive fact
            </span>
            {note.reasoning}
          </div>
        )}
        {note.because && (
          /* amber-* is remapped to the brand-pink ramp in globals.css, and only
             steps 200–500 are re-keyed per theme (see GraphCanvas's advisory
             banner) — border-amber-900/bg-amber-950 would sit outside that
             range and render as a fixed dark literal instead of flipping with
             light mode. Kept inside 200–500, matching the "unplaced" badge
             above and every other amber box in this app. */
          <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
            <span className="mr-2 text-[11px] uppercase tracking-wide text-amber-400">
              downgraded
            </span>
            {note.because}
          </div>
        )}
        {/* The roads: the queries that actually returned this host, most-seen
            first, at most the three the run stored.

            Every other line in this header asks the reader to trust a judgement
            — the classifier's sentence, its relation, its grounding score. This
            one asks them to trust nothing: it is the text that was typed into a
            search box, and the host came back. It sits above `sources` because
            the two together are the whole provenance of a row — what was asked,
            and what answered.

            Absent on the anchor, which was read from its own pages rather than
            searched for, and on any run recorded before the sweep stored them;
            both simply render nothing, the way `families` does. */}
        {(note.roads?.length ?? 0) > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
              found by
            </div>
            <ul
              title="The searches that returned this host, most-seen first. Recorded by the run, not reconstructed here."
              className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-slate-500"
            >
              {note.roads!.map((q) => (
                <li key={q}>&ldquo;{q}&rdquo;</li>
              ))}
            </ul>
          </div>
        )}
        {sources.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
              sources ({sources.length})
            </div>
            {/* One source, and it is the host itself: the run saw this domain in
                a search result and read its title and description. No retrieval
                timestamp travels with an entity, so none is claimed — v1's
                `retrievedAt` slot stays wired and simply renders nothing. */}
            <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
              {sources.map((s, i) => (
                <li key={i}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="tnum inline-flex items-center gap-1.5 text-slate-400 hover:text-sky-300"
                    title={s.url}
                  >
                    <SiteIcon domain={hostOf(s.url)} size={12} />
                    <span>{hostOf(s.url)}</span>
                    {s.retrievedAt && (
                      <span className="text-slate-500">{s.retrievedAt}</span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <div className="note-prose">
        <p>{note.what}</p>
      </div>

      {/* The receipts behind the line above.
          `spans` are the quotes the model claimed its description back, kept
          only where the kernel found them as literal substrings of the page it
          read — the check runs in code, which is what lets the heading say
          "word for word". The header already prints `desc grounded 0.72`; a
          number about evidence is worth much less than the evidence, and the
          quotes were sitting in every stored map with no reader.

          A slate quote rail rather than the amber box `because` uses: amber
          means "this claim was downgraded" everywhere else in this app, and
          these are the opposite of a downgrade. The engine caps the set at 360
          characters in total, so there is nothing to truncate here. */}
      {(note.spans?.length ?? 0) > 0 && (
        <section className="mt-4">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">
            quoted from its page, checked word for word
          </div>
          <ul className="space-y-1.5 border-l border-slate-800 pl-3">
            {note.spans!.map((s, i) => (
              <li key={i} className="text-[13px] leading-snug text-slate-400">
                &ldquo;{s}&rdquo;
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The accounts a swarm merge folded into this node and kept (`also` on
          the run's entity row). Two writers colliding on one host is usually
          two true descriptions of one company — most visibly a product landing
          on the company that sells it — and until the row carried them, the
          folded product's name survived only in the run's memory. Named
          entries lead with the name they lost. */}
      {(note.also?.length ?? 0) > 0 && (
        <section className="mt-6 border-t border-slate-800 pt-4">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
            also recorded here ({note.also!.length})
          </div>
          <p className="mb-2 max-w-2xl text-xs text-slate-500">
            Accounts merged into this node when two writers landed on the same
            host — kept, not discarded. A product folded into the company that
            sells it stays recoverable by name.
          </p>
          <ul className="space-y-1.5">
            {note.also!.map((a, i) => (
              <li key={i} className="text-sm text-slate-400">
                {a.name && (
                  <span className="mr-2 font-medium text-slate-200">{a.name}</span>
                )}
                {a.what}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(anchor || strongest.length > 0) && (
        <section className="mt-6 border-t border-slate-800 pt-4">
          <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
            {isAnchor ? "strongest placements" : "relation"}
          </div>
          <div className="flex flex-wrap gap-2">
            {isAnchor
              ? strongest.map((n) => (
                  <TypeChip
                    key={n.path}
                    type={n.type}
                    label={`${n.title} · ${n.relation}`}
                    title={RELATION_BLURB[n.relation] ?? undefined}
                    onClick={() => openNote(n.path)}
                  />
                ))
              : anchor && (
                  <TypeChip
                    type={anchor.type}
                    label={
                      unplaced
                        ? `${anchor.title} · no relation asserted`
                        : `${anchor.title} · ${note.relation}`
                    }
                    title={
                      unplaced
                        ? "The classifier declined to place this entity against the anchor, so there is no edge on the graph either."
                        : RELATION_BLURB[note.relation]
                    }
                    dead={unplaced}
                    onClick={unplaced ? undefined : () => openNote(anchor.path)}
                  />
                )}
          </div>
        </section>
      )}

      {siblings.length > 0 && (
        <section className="mt-5 border-t border-slate-800 pt-4">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
            placed the same way
          </div>
          <p className="mb-2 text-xs text-slate-500">
            Also classified <span className="text-slate-400">{note.relation}</span>{" "}
            against the anchor. That is a shared judgement about each of them, not
            a measured relationship between them — the sweep never compared these
            hosts to each other.
          </p>
          <div className="flex flex-wrap gap-2">
            {siblings.map((n) => (
              <TypeChip
                key={n.path}
                type={n.type}
                label={n.title}
                onClick={() => openNote(n.path)}
              />
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

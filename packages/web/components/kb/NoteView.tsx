"use client";

import { useEffect, useMemo, useState } from "react";
import type { NoteRef, NoteView as NoteData } from "@/lib/viewTypes";
import { FAMILY_TONE, RELATION_BLURB } from "@/lib/viewTypes";
import { SiteIcon } from "@/components/SiteIcon";
import { KindChip, RelevanceBadge, TypeChip } from "@/components/ui";

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
                    className="tnum inline-flex items-baseline gap-1.5 text-slate-400 hover:text-sky-300"
                    title={s.url}
                  >
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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* The KB view, held in the URL.
   ---------------------------------------------------------------------------
   Which tab you are on and which entity you are reading were `useState` and
   nothing else, which meant the three things a reader expects from a browser
   all failed at once: the Back button left the KB entirely instead of stepping
   back through the entities you had just clicked, a link to what was on screen
   was impossible to produce, and a reload dropped you back on Overview.

   So the view lives in the query string and the component reads it from there.
   Two rules keep it honest:

   · The URL is written with the plain History API, not the router. This page is
     `force-dynamic`: a `router.replace` would re-run the server component and
     re-read the run off disk for what is a purely client-side change of view.
     `pushState` moves the address bar and nothing else.

   · Only ENTITY changes push a history entry; the tab and everything else
     replace. Clicking through five related entities should cost five Back
     presses to unwind, but toggling to the graph and back should not bury the
     page you arrived from under a pile of tab flips.
*/

export type UrlView = { tab: string; note: string | null };

// Exported so the query-string encode/decode can be tested directly: the hook
// itself needs React's render lifecycle (useState/useEffect/useCallback), and
// this repo has no jsdom/RTL harness to drive that (see GraphCanvas.tsx's
// zero-entity guard, B4 in the former docs/overnight-backlog.md, for the same
// limitation). readUrl and writeUrl take and touch only `window`, so a stub
// object is enough — no renderer required.
export function readUrl(fallbackTab: string): UrlView {
  if (typeof window === "undefined") return { tab: fallbackTab, note: null };
  const q = new URLSearchParams(window.location.search);
  return { tab: q.get("tab") || fallbackTab, note: q.get("note") };
}

export function writeUrl(view: UrlView, mode: "push" | "replace") {
  const q = new URLSearchParams(window.location.search);
  // Defaults are absent, not spelled out: a link to the Overview of a KB should
  // be the bare KB URL, the same address the gallery card points at.
  if (view.tab && view.tab !== "overview") q.set("tab", view.tab);
  else q.delete("tab");
  if (view.note) q.set("note", view.note);
  else q.delete("note");
  const s = q.toString();
  const url = `${window.location.pathname}${s ? `?${s}` : ""}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
}

export function useUrlView(initial: UrlView): [UrlView, (next: Partial<UrlView>, mode?: "push" | "replace") => void] {
  const [view, setView] = useState<UrlView>(initial);
  /* `go` writes to history, and a state updater is not allowed to do that —
     React invokes updaters twice under Strict Mode, which would push the same
     entry twice and make one Back press look like it did nothing. The ref
     carries the current view so `go` can decide and write OUTSIDE the updater. */
  const ref = useRef(view);
  ref.current = view;

  /* The server rendered from `initial`; the client is the first thing that can
     read the full query string (a `tab` the server ignores, a note the server
     could not verify). Sync once on mount, then never again from this effect. */
  useEffect(() => {
    const fromUrl = readUrl(initial.tab);
    const v = ref.current;
    if (fromUrl.tab !== v.tab || fromUrl.note !== v.note) {
      ref.current = fromUrl;
      setView(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPop = () => {
      const v = readUrl("overview");
      ref.current = v;
      setView(v);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback(
    (next: Partial<UrlView>, mode: "push" | "replace" = "replace") => {
      const v = ref.current;
      const merged = { ...v, ...next };
      if (merged.tab === v.tab && merged.note === v.note) return;
      ref.current = merged;
      writeUrl(merged, mode);
      setView(merged);
    },
    [],
  );

  return [view, go];
}

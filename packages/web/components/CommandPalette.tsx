"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { NodeGlyph, type GlyphKind } from "@/components/icons";

/* ⌘K — one way to reach everything.
   ---------------------------------------------------------------------------
   Getting from an entity on one map to a tab on another cost a trip back
   through the gallery, and finding a named company on a large map meant
   scrolling a sidebar for it. Both are the same problem: the app had places but
   no way to SAY one.

   The palette is that way. It holds three kinds of command, always in this
   order, because it is the order of how specific the reader is being:

     Go to      the three routes, and the tabs of the KB currently open
     Knowledge  every mapped domain, fetched once when the palette first opens
     Entities   every entity on the open KB, published by KbBrowser

   Pages publish their own commands with `usePaletteCommands`. The list is a
   registry rather than a prop chain so a surface can offer its verbs without
   the chrome having to know that surface exists — and when the surface
   unmounts, its commands leave with it.

   Matching is subsequence, not substring: "brdt" finds "Bright Data", which is
   how anyone who has used a palette before expects to type. Ranking prefers a
   prefix hit, then an early hit, then a short title, so the exact thing you
   typed the start of is never buried under something that merely contains it.
*/

export type Command = {
  id: string;
  title: string;
  /** Trailing detail — a relation, a domain, a count. Searched too. */
  hint?: string;
  group: string;
  glyph?: GlyphKind;
  run: () => void;
};

type Registry = {
  register: (key: string, cmds: Command[]) => () => void;
  open: () => void;
};

const Ctx = createContext<Registry | null>(null);

/** Publish commands for as long as the calling component is mounted. */
export function usePaletteCommands(cmds: Command[]) {
  const ctx = useContext(Ctx);
  const key = useId();
  useEffect(() => {
    if (!ctx) return;
    return ctx.register(key, cmds);
  }, [ctx, key, cmds]);
}

/** Open the palette from a button (see PaletteButton). */
export function usePalette() {
  return useContext(Ctx);
}

/* ------------------------------------------------------------------ matching */

/** Subsequence score, or -1 for no match. Lower is better. Exported so it can
 *  be tested as the pure ranking rule it is — see CommandPalette.test.ts. */
export function score(needle: string, hay: string): number {
  if (!needle) return 0;
  const h = hay.toLowerCase();
  if (h.startsWith(needle)) return 0;
  let i = 0;
  let first = -1;
  let gaps = 0;
  let last = -1;
  for (let j = 0; j < h.length && i < needle.length; j++) {
    if (h[j] === needle[i]) {
      if (first < 0) first = j;
      if (last >= 0 && j > last + 1) gaps++;
      last = j;
      i++;
    }
  }
  if (i < needle.length) return -1;
  return 1 + first + gaps * 2 + hay.length * 0.01;
}

/* ------------------------------------------------------------------ provider */

type KbRow = { slug: string; manifest?: { brand?: string; root?: string; input?: string } | null };

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [extra, setExtra] = useState<Map<string, Command[]>>(new Map());
  const [kbs, setKbs] = useState<KbRow[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const register = useCallback((key: string, cmds: Command[]) => {
    setExtra((m) => new Map(m).set(key, cmds));
    return () =>
      setExtra((m) => {
        const next = new Map(m);
        next.delete(key);
        return next;
      });
  }, []);

  const api = useMemo<Registry>(
    () => ({ register, open: () => setOpen(true) }),
    [register],
  );

  /* ⌘K anywhere, and `/` when the reader is not already typing into something.
     Escape closes. The shortcut is deliberately not captured inside inputs:
     a search field that swallows ⌘K would make the palette unreachable from
     exactly the place someone is most likely to want it. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* The gallery, warmed while the browser is idle rather than at the moment
     ⌘K is pressed. Fetching on open was correct about cost and wrong about
     timing: the list took about a second cold, which is longer than it takes
     to press ⌘K and type a domain, so the palette's first answer was that the
     domain did not exist. `requestIdleCallback` keeps it off the critical path
     — it waits for the page to finish its own work — and by the time anyone
     reaches for the shortcut the answer is already here. */
  useEffect(() => {
    if (kbs) return;
    let dead = false;
    const idle: (cb: () => void) => number =
      typeof window.requestIdleCallback === "function"
        ? (cb) => window.requestIdleCallback(cb, { timeout: 3000 })
        : (cb) => window.setTimeout(cb, 1200);
    const handle = idle(() => {
      if (dead) return;
    fetch("/api/kb")
      .then((r) => (r.ok ? r.json() : { kbs: [] }))
      .then((d) => !dead && setKbs(Array.isArray(d.kbs) ? d.kbs : []))
      .catch(() => !dead && setKbs([]));
    });
    return () => {
      dead = true;
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [kbs]);

  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
      // Focus after paint — the input does not exist until this render commits.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const routes: Command[] = [
      { id: "route:/", title: "Map a domain", group: "Go to", glyph: "signal", run: () => router.push("/") },
      { id: "route:/kb", title: "Knowledge bases", group: "Go to", glyph: "company", run: () => router.push("/kb") },
      { id: "route:/runs", title: "Runs", group: "Go to", glyph: "docs", run: () => router.push("/runs") },
    ];
    const gallery: Command[] = (kbs ?? []).map((k) => ({
      id: `kb:${k.slug}`,
      title: k.manifest?.brand || k.manifest?.root || k.manifest?.input || k.slug,
      hint: k.slug.slice(0, 8),
      group: "Knowledge bases",
      glyph: "company" as GlyphKind,
      run: () => router.push(`/kb/${k.slug}`),
    }));
    // Page-published commands are spliced in by their own group name, so the
    // open KB's tabs join "Go to" rather than starting a fourth section.
    const published = Array.from(extra.values()).flat();
    return [...routes, ...gallery, ...published];
  }, [router, kbs, extra]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const scored = commands
      .map((c) => ({ c, s: score(needle, `${c.title} ${c.hint ?? ""}`.trim()) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => a.s - b.s);
    // Grouped for display, but flat for the cursor: arrow keys should walk the
    // whole list, not stop at a heading.
    const order: string[] = [];
    const byGroup = new Map<string, Command[]>();
    for (const { c } of scored) {
      if (!byGroup.has(c.group)) {
        byGroup.set(c.group, []);
        order.push(c.group);
      }
      byGroup.get(c.group)!.push(c);
    }
    const flat = order.flatMap((g) => byGroup.get(g)!);
    return { groups: order.map((g) => ({ name: g, items: byGroup.get(g)! })), flat };
  }, [commands, q]);

  useEffect(() => setCursor(0), [q]);

  const runAt = useCallback(
    (i: number) => {
      const cmd = results.flat[i];
      if (!cmd) return;
      setOpen(false);
      cmd.run();
    },
    [results],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setOpen(false);
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.flat.length - 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(cursor);
    }
  };

  // Keep the highlighted row on screen while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  let flatIndex = -1;

  return (
    <Ctx.Provider value={api}>
      {children}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
        >
          <button
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="palette-scrim absolute inset-0 cursor-default bg-slate-950/70 backdrop-blur-sm"
          />
          <div
            onKeyDown={onKeyDown}
            className="palette-panel relative w-full max-w-xl overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-[0_40px_100px_-30px_rgba(0,0,0,0.8)]"
          >
            <div className="flex items-center gap-2.5 border-b border-slate-800 px-4">
              <NodeGlyph kind="signal" size={14} className="shrink-0 text-[var(--accent)]" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Jump to a map, a tab, an entity…"
                aria-label="Search commands"
                /* No focus ring: the input is the only focusable thing in the
                   dialog and it is focused the moment the dialog opens, so a
                   ring here marks nothing and just boxes in the whole header. */
                className="w-full bg-transparent py-3.5 text-sm text-slate-100 outline-none focus-visible:outline-none placeholder:text-slate-500"
              />
              <kbd className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                esc
              </kbd>
            </div>

            <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
              {results.flat.length === 0 ? (
                /* "Nothing matches" is a claim about the whole app, and it is
                   false while the gallery is still in flight — the first thing
                   this said, when opened and typed into inside a second, was
                   that a map sitting on the page behind it did not exist. It
                   only says that once there is a full list to say it about. */
                kbs === null ? (
                  <div className="space-y-1.5 p-2" aria-busy="true">
                    <div className="skeleton h-8 w-full" />
                    <div className="skeleton h-8 w-11/12" />
                    <div className="skeleton h-8 w-4/5" />
                  </div>
                ) : (
                  <div className="px-3 py-8 text-center text-sm text-slate-500">
                    Nothing matches “{q}”. Try a domain, a tab, or an entity name.
                  </div>
                )
              ) : (
                results.groups.map((g) => (
                  <div key={g.name} className="mb-1">
                    <div className="px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                      {g.name}
                    </div>
                    {g.items.map((c) => {
                      flatIndex++;
                      const i = flatIndex;
                      const on = i === cursor;
                      return (
                        <button
                          key={c.id}
                          data-active={on}
                          onMouseMove={() => setCursor(i)}
                          onClick={() => runAt(i)}
                          className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-100 ${
                            on ? "bg-sky-500/12 text-slate-100" : "text-slate-300"
                          }`}
                        >
                          <NodeGlyph
                            kind={c.glyph ?? "docs"}
                            size={13}
                            className={`shrink-0 ${on ? "text-[var(--accent)]" : "text-slate-500"}`}
                          />
                          <span className="min-w-0 flex-1 truncate">{c.title}</span>
                          {c.hint && (
                            <span className="shrink-0 font-mono text-[10px] text-slate-500">
                              {c.hint}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-slate-800 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              <span>↑↓ move</span>
              <span>↵ open</span>
              <span className="ml-auto tnum">
                {results.flat.length} {results.flat.length === 1 ? "result" : "results"}
              </span>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

/** The header affordance. A shortcut nobody is told about does not exist. */
export function PaletteButton({ className = "" }: { className?: string }) {
  const ctx = usePalette();
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return (
    <button
      type="button"
      onClick={() => ctx?.open()}
      aria-label="Search and jump to anything"
      title="Search and jump to anything"
      className={`group hidden items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 py-1.5 pl-2.5 pr-2 text-xs text-slate-500 transition-colors hover:border-slate-700 hover:text-slate-300 sm:inline-flex ${className}`}
    >
      <NodeGlyph
        kind="signal"
        size={12}
        className="shrink-0 transition-colors group-hover:text-[var(--accent)]"
      />
      <span>Jump to…</span>
      <kbd className="rounded border border-slate-800 bg-slate-950/60 px-1 py-px font-mono text-[10px]">
        {mac ? "⌘" : "^"}K
      </kbd>
    </button>
  );
}

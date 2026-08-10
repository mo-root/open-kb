"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NodeGlyph, type GlyphKind } from "@/components/icons";

/* The KB tab bar.
   ---------------------------------------------------------------------------
   Two things it does that a row of buttons with a bottom border does not:

   1. ONE underbar, moved. The old bar gave every button its own `border-b-2`
      and toggled which one was coloured, so switching tabs made the accent
      teleport. A single absolutely-positioned bar that slides between the
      measured tab rects tells the reader where they came from and where they
      landed — the motion IS the information, so it is the one animated thing
      up here.

   2. Keyboard navigation the ARIA tablist pattern actually specifies. Arrows
      move between tabs (wrapping), Home/End jump to the ends, and only the
      selected tab is in the page's tab order — so Tab from the header lands on
      the bar once, not four times, and the arrows take it from there. */

export type TabDef<T extends string> = {
  id: T;
  label: string;
  glyph: GlyphKind;
  /** Optional count rendered after the label — how much is behind the tab. */
  count?: number;
};

export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  idPrefix = "kb",
}: {
  tabs: readonly TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Namespaces the aria-controls/id pair when more than one bar is on a page. */
  idPrefix?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef(new Map<T, HTMLButtonElement>());
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);

  /* The underbar is measured, not computed: tab widths depend on the loaded
     font and the counts, so any arithmetic here would be wrong for the first
     frame after a webfont swaps in. useLayoutEffect places it before paint so
     the bar never flashes at the wrong tab, and a ResizeObserver re-measures
     when the font lands, the counts change, or the window reflows. */
  const measure = useCallback(() => {
    const el = btnRefs.current.get(active);
    const list = listRef.current;
    if (!el || !list) return;
    setBar({
      left: el.offsetLeft - list.scrollLeft,
      width: el.offsetWidth,
    });
  }, [active]);

  useLayoutEffect(measure, [measure, tabs]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    for (const el of btnRefs.current.values()) ro.observe(el);
    window.addEventListener("resize", measure);
    list.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      list.removeEventListener("scroll", measure);
    };
  }, [measure]);

  /* An overflowing bar can hide the tab you just picked — via the palette, a
     deep link, or an arrow key. Pull it back into view whenever it changes. */
  useEffect(() => {
    btnRefs.current
      .get(active)
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === active);
    if (i < 0) return;
    const to =
      e.key === "ArrowRight" ? (i + 1) % tabs.length
      : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = tabs[to].id;
    onChange(next);
    // Focus follows selection: this is an automatic-activation tablist, so the
    // panel and the focus ring must not drift apart.
    requestAnimationFrame(() => btnRefs.current.get(next)?.focus());
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Knowledge base sections"
      onKeyDown={onKeyDown}
      className="relative flex gap-1 overflow-x-auto border-b border-slate-800"
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) btnRefs.current.set(t.id, el);
              else btnRefs.current.delete(t.id);
            }}
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`inline-flex shrink-0 items-center gap-1.5 px-3 py-2 font-mono text-xs uppercase tracking-[0.08em] transition-colors duration-150 ${
              on ? "text-slate-100" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {/* Active nav intent = --accent, matching HeaderNav's active glyph
                so header and tab bar can never drift to two different blues. */}
            <NodeGlyph
              kind={t.glyph}
              size={13}
              className={`shrink-0 transition-colors duration-150 ${
                on ? "text-[var(--accent)]" : "text-slate-500"
              }`}
            />
            {t.label}
            {t.count !== undefined && (
              <span
                className={`tnum rounded px-1 text-[10px] transition-colors duration-150 ${
                  on ? "bg-sky-500/15 text-sky-300" : "text-slate-500"
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
      {/* The travelling underbar. Hidden until the first measurement so it
          cannot start life at x=0 and slide in from the wrong place. */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-sky-400 transition-[transform,width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
        style={{
          width: bar?.width ?? 0,
          transform: `translateX(${bar?.left ?? 0}px)`,
          opacity: bar ? 1 : 0,
          left: 0,
        }}
      />
    </div>
  );
}

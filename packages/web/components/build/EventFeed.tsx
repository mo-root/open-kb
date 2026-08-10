"use client";

import { useEffect, useRef } from "react";
import type { FeedItem } from "./types";

/* The raw trail. Ported from public-kb's EventFeed unchanged in shape: a mono
   column that follows the run, because when something goes wrong the copyable
   line is what a bug report is made of. */

const TONE: Record<FeedItem["tone"], string> = {
  muted: "text-slate-500",
  accent: "text-sky-300",
  green: "text-emerald-300",
  amber: "text-amber-300",
  red: "text-rose-300",
};

export function EventFeed({ items, running }: { items: FeedItem[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-slate-800 bg-slate-900/30">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
          event stream
        </span>
        <span className="tnum text-[11px] text-slate-500">{items.length}</span>
      </div>
      <div
        ref={ref}
        className="h-[320px] overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {items.map((it) => (
          <div key={it.id} className={`whitespace-pre-wrap break-words ${TONE[it.tone]}`}>
            {it.text}
          </div>
        ))}
        {running && <div className="mt-1 animate-pulse text-slate-600">▍</div>}
        {items.length === 0 && !running && <div className="text-slate-500">waiting…</div>}
      </div>
    </div>
  );
}

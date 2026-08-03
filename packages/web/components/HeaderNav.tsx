"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NodeGlyph } from "@/components/icons";
import type { GlyphKind } from "@/components/icons";
import { ThemeToggle } from "@/components/ThemeToggle";

/* The header nav lives in a client island so it can light the active route.
   layout.tsx stays a server component (it owns metadata + fonts); this is the
   only interactive sliver of the chrome.

   PORT NOTE. This carried one item for a while — a nav item that 404s is worse
   than no nav item, and the KB-browsing pages had not landed. They have, so the
   other two are back. v1's spelling of the first was "Build"; a run here buys a
   market map rather than building a note store, so it is "Map". */
const ITEMS: {
  href: string;
  label: string;
  glyph: GlyphKind;
  active: (p: string) => boolean;
}[] = [
  { href: "/", label: "Map", glyph: "signal", active: (p) => p === "/" },
  {
    href: "/kb",
    label: "Knowledge bases",
    glyph: "company",
    active: (p) => p.startsWith("/kb"),
  },
  { href: "/runs", label: "Runs", glyph: "docs", active: (p) => p.startsWith("/runs") },
];

export function HeaderNav() {
  const pathname = usePathname() ?? "/";
  return (
    <>
      <nav className="flex h-14 items-stretch gap-6 font-mono text-[11px] uppercase tracking-[0.14em]">
        {ITEMS.map((item) => {
          const active = item.active(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`group relative flex items-center gap-1.5 transition-colors ${
                active ? "text-slate-100" : "text-slate-400 hover:text-sky-300"
              }`}
            >
              {/* Glyph leads the label: muted chrome when idle, accent blue on
                  the active route so it echoes the underbar. */}
              <NodeGlyph
                kind={item.glyph}
                size={13}
                className={
                  active
                    ? "text-[var(--accent)]"
                    : "text-slate-500 transition-colors group-hover:text-sky-300"
                }
              />
              <span>{item.label}</span>
              <span
                aria-hidden
                className={`pointer-events-none absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-sky-400 transition-opacity ${
                  active ? "opacity-100" : "opacity-0"
                }`}
              />
            </Link>
          );
        })}
      </nav>
      {/* right-aligned in the header row (layout.tsx owns the flex container) */}
      <ThemeToggle className="ml-auto" />
    </>
  );
}

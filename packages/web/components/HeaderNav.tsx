"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NodeGlyph } from "@/components/icons";
import type { GlyphKind } from "@/components/icons";
import { PaletteButton } from "@/components/CommandPalette";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DEMO_REPO } from "@/lib/demo";

/* The header nav lives in a client island so it can light the active route.
   layout.tsx stays a server component (it owns metadata + fonts); this is the
   only interactive sliver of the chrome.

   PORT NOTE. This carried one item for a while — a nav item that 404s is worse
   than no nav item, and the KB-browsing pages had not landed. They have, so the
   other two are back. v1's spelling of the first was "Build"; a run here buys a
   market map rather than building a note store, so it is "Map". */
/* `short` is the phone spelling. "Knowledge bases" wrapped onto two lines on a
   390px screen and shoved the whole nav out of the header's 56px row — the one
   place the chrome must not move. The full label returns at `sm`, where it
   fits, so nothing is permanently abbreviated for the sake of the small case. */
export const ITEMS: {
  href: string;
  label: string;
  short: string;
  glyph: GlyphKind;
  active: (p: string) => boolean;
}[] = [
  { href: "/", label: "Map", short: "Map", glyph: "signal", active: (p) => p === "/" },
  {
    href: "/kb",
    label: "Knowledge bases",
    short: "Bases",
    glyph: "company",
    active: (p) => p.startsWith("/kb"),
  },
  {
    href: "/runs",
    label: "Runs",
    short: "Runs",
    glyph: "docs",
    active: (p) => p.startsWith("/runs"),
  },
];

export function HeaderNav() {
  const pathname = usePathname() ?? "/";
  return (
    <>
      <nav className="flex h-14 items-stretch gap-4 font-mono text-[11px] uppercase tracking-[0.14em] sm:gap-6">
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
              <span className="whitespace-nowrap sm:hidden">{item.short}</span>
              <span className="hidden whitespace-nowrap sm:inline">{item.label}</span>
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
      {/* right-aligned in the header row (layout.tsx owns the flex container).
          The palette trigger sits beside the theme toggle: it is chrome, not a
          destination, so it stays out of the nav run and reads as a tool. */}
      <div className="ml-auto flex items-center gap-2">
        {/* The repo is the product's front door — a visitor convinced by the
            maps needs exactly one place to go, so it sits in the chrome on
            every route rather than only in the demo home's aside. */}
        <a
          href={DEMO_REPO}
          target="_blank"
          rel="noreferrer"
          aria-label="open-kb on GitHub"
          className="group flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400 transition-colors hover:text-sky-300"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
          </svg>
          <span className="hidden md:inline">GitHub</span>
        </a>
        <PaletteButton />
        <ThemeToggle />
      </div>
    </>
  );
}

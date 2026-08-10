"use client";

import { useEffect, useState } from "react";
import { readStoredTheme, themeFromStored, THEME_KEY, type Theme } from "@/lib/theme";

// The theme switch: flips document.documentElement.dataset.theme and persists
// the choice to localStorage 'kb-theme' (read pre-paint by the no-fouc script in
// layout.tsx). dark is the default, so the stored/attribute value is only ever
// "light" when the reader has opted in.
//
// Theme is a client-only fact (it lives on <html> before React mounts), so the
// icon is resolved in an effect. First render stays theme-agnostic to keep SSR
// and hydration identical; the sun/moon settles in immediately after mount.

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    // WRITE-IF-ABSENT, and the `if` is the whole safety argument. On a normal
    // load the parser has already run the no-fouc script before React exists,
    // so `dataset.theme` is set and this branch never fires — nothing here can
    // reintroduce a light→dark flash, and nothing runs during render, so
    // hydration still sees the markup the server sent. Drop the guard and make
    // this an unconditional write and you have moved theming into an effect,
    // which is exactly the flash the script in layout.tsx exists to prevent.
    //
    // WHEN IT DOES FIRE: an errored response. Next serves those from its own
    // <html id="__next_error__"> document — layout.tsx's <head> is never
    // parsed, it arrives as flight data, and React builds every <script> host
    // instance with `div.innerHTML = "<script></script>"` + removeChild, which
    // sets the HTML "already started" flag. Measured on /kb/<id> under
    // OPENKB_RUNS_DIR=/: the theme script IS in document.head and inert, and
    // data-theme is null (eval-ing that same node's own text stamps it fine,
    // so the script is not the problem — the document it landed in is). An
    // absent attribute is light in globals.css (`--c-slate-950: #ffffff` at
    // :root, #0a1730 only under :root[data-theme="dark"]), so a dark-mode
    // reader got a white boundary AND a white header; and because the
    // attribute stayed missing for the life of that document, every soft nav
    // afterwards was light too. This is the only reachable place to fix it:
    // the header is client JS, and client JS is all that runs on that page.
    // Residual: the write lands after hydration, so it races first paint on
    // the error page and can lose. Two independent measurements disagreed —
    // one saw the write at 45ms ahead of first contentful paint, the other saw
    // a single white frame carrying the fully rendered boundary and header in
    // 7 of 8 cold loads — so treat a light frame as possible, not certain.
    // Do NOT reach for useLayoutEffect to close it: this component is SSR'd on
    // every healthy page, so React warns there to buy a frame on a page nobody
    // should be looking at. Owning that document is the only clean removal.
    if (!root.dataset.theme) {
      root.dataset.theme = readStoredTheme();
    }
    // Through the shared rule, not a fourth hand-written ternary. The attribute
    // is "dark" or "light" by the time we read it — the script above set it, or
    // the line above did — so this changes no behaviour today. It matters for
    // the day it is something else: `themeFromStored` resolves the unknown to
    // DARK, and the ternary that used to live here resolved it to LIGHT, which
    // is the one disagreement `lib/theme.ts` exists to make impossible.
    setTheme(themeFromStored(root.dataset.theme));
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode / storage disabled, the toggle still works for the session */
    }
    setTheme(next);
  }

  const isDark = theme === "dark";
  const label =
    theme === null
      ? "Toggle color theme"
      : `Switch to ${isDark ? "light" : "dark"} mode`;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-800 text-slate-400 transition-colors hover:border-slate-700 hover:text-sky-300 focus-visible:text-sky-300 ${className}`}
    >
      {/* Sun while dark (tap → go light), moon while light (tap → go dark).
          Rendered client-side only so the glyph can't mismatch the DOM theme. */}
      {isDark ? <SunIcon /> : <MoonIcon />}
      <span className="sr-only">{label}</span>
    </button>
  );
}

// `storedTheme()` used to live here, a hand-copy of the no-fouc script's rule,
// with a comment saying the two copies had to move together. `app/global-error
// .tsx` needed the same rule and would have made three, so the rule moved to
// `lib/theme.ts` and both importable readers now share it. The script in
// layout.tsx still cannot import — it has to be a literal in the markup to run
// before paint — but it is no longer trusted to agree by hand: theme.test.ts
// evaluates the real script text out of layout.tsx against themeFromStored.

function SunIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

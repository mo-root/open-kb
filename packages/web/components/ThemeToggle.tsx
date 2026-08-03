"use client";

import { useEffect, useState } from "react";

// The theme switch: flips document.documentElement.dataset.theme and persists
// the choice to localStorage 'kb-theme' (read pre-paint by the no-FOUC script in
// layout.tsx). LIGHT is the product default — the paper-white dashboard — so the
// stored/attribute value is only ever "dark" when the user has opted in.
//
// Theme is a client-only fact (it lives on <html> before React mounts), so the
// icon is resolved in an effect. First render stays theme-agnostic to keep SSR
// and hydration identical; the sun/moon settles in immediately after mount.
type Theme = "light" | "dark";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const attr = document.documentElement.dataset.theme;
    setTheme(attr === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("kb-theme", next);
    } catch {
      /* private mode / storage disabled — the toggle still works for the session */
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

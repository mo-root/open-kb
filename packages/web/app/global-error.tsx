"use client";

import { readStoredTheme, type Theme } from "@/lib/theme";

/**
 * The boundary for the ROOT LAYOUT itself, and the last page in the app.
 *
 * WHAT IT REPLACES. `app/error.tsx` catches a page. Nothing caught the layout:
 * if `app/layout.tsx` throws, Next renders its own built-in global error — a
 * white card reading "This page couldn't load" over `ERROR 2315581360` — and
 * this app is not on the screen in any form. Not the header, so not
 * `ThemeToggle`, which is what 3g's fix depended on. Measured on a production
 * build (`next start`, root layout throwing, chunks blocked so the frame is
 * exactly what the server sent): status 500, `<html id="__next_error__">`,
 * `data-theme` absent, no stylesheet on the document at all, and the top-left
 * pixel `rgb(255,255,255)` — white under `prefers-color-scheme: light` AND
 * under `dark`, because nothing had declared a color scheme. A reader who had
 * chosen dark got white and kept it: with JS on and `kb-theme="dark"` the
 * settled page was still `data-theme: null`, body `rgb(255,255,255)`, and
 * identical to the `kb-theme="light"` and unset runs. The reader's choice had
 * no effect on this page whatsoever.
 *
 * WHY THERE IS NO INLINE PRE-PAINT SCRIPT HERE, which was the obvious idea and
 * is wrong. A `global-error.tsx` owns its own `<html>` and `<body>`, so it
 * looks like the one place in this app where the no-FOUC trick from
 * `layout.tsx` would work. It does not, and the reason is that this file is
 * never server-rendered. A probe build put `<script>` and `data-ge-ssr` in this
 * component and requested the errored route: zero occurrences of either in the
 * response body. What Next sends is still its own empty `<html
 * id="__next_error__">` document; this component arrives as a client reference
 * in the flight payload (`"G":["$b",[]]` with
 * `b:I[…,"static/chunks/app/global-error-….js","default"]`) and is rendered by
 * React on the client, after the chunk has been fetched. A `<script>` React
 * creates is inert anyway — that is 3g's finding — but here it would also be
 * far too late to matter. There is no pre-paint on this document that this file
 * can reach.
 *
 * SO THE FIRST FRAME IS NOT FIXED HERE. It is fixed by the `viewport` export in
 * `app/layout.tsx`, which is a MODULE-level export and therefore survives the
 * component throwing — `<title>open-kb</title>` was already proof of that,
 * sitting in the errored document from the `metadata` export next to it. It
 * declares `color-scheme: dark`, which is all a document with no stylesheet can
 * be told, and it turns the white canvas into the UA's dark one. This file owns
 * the frame after that: the app's real surface, in the reader's real theme.
 *
 * WITH SCRIPTING OFF, NOTHING BELOW RUNS. The reader gets the UA's dark canvas
 * (from layout.tsx's `viewport` export) and the title, and no text at all —
 * measured: `document.body.innerText` is empty, in every storage state. No
 * change in this repo can put a sentence there, because the document is Next's
 * and this component is only ever rendered on the client. It is still strictly
 * better than before, where the same empty document was white.
 *
 * IT MUST NOT THROW. Nothing is imported but `lib/theme.ts`, which imports
 * nothing and runs nothing at module scope. No header, no command palette, no
 * font loader, no store, no stylesheet — `globals.css` is not applied to this
 * document (measured: `document.styleSheets` empty, zero `<link rel=stylesheet>`),
 * so every colour below is a literal, taken from the two `:root` blocks in
 * `globals.css` rather than from a class that would resolve to nothing.
 */

// React's stand-in for a message it refuses to send, matched by text rather
// than by build mode for the reasons written out at length in `app/error.tsx`.
// The same guard, because the same thing is true here: a Server Component throw
// is redacted before any boundary sees it, and a client-side throw is not.
const REDACTED = "omitted in production builds";

/**
 * The two `:root` blocks of `globals.css`, inlined.
 *
 * A duplicate palette is a maintenance cost and normally the wrong answer. It
 * is the only answer here: this document has no stylesheet, so `text-rose-300`
 * is a string that resolves to nothing and `var(--bg)` is undefined. The values
 * are the tokens this app already paints with, so the page reads as this app
 * even though it is not wearing this app's stylesheet. If the palette moves,
 * this drifts, and the honest mitigation is that the whole point of this file
 * is to look like the app — a drift is visible the moment anyone opens it.
 */
const PALETTE: Record<Theme, Record<string, string>> = {
  // globals.css :root[data-theme="dark"]
  dark: {
    bg: "#0e1b34", // --bg
    card: "#0d2243", // --surface  (error.tsx's bg-slate-900/40, flattened)
    rule: "#1c3763", // --c-slate-800
    text: "#e8eef9", // --c-slate-200
    muted: "#6b84ad", // --c-slate-500
    alarm: "#ff8fa8", // --c-rose-300
    control: "#c6dbff", // --c-slate-300
    controlRule: "#274a82", // --c-slate-700
  },
  // globals.css :root  (light is the fallback, not the default — see lib/theme.ts)
  light: {
    bg: "#ffffff",
    card: "#f5f8ff",
    rule: "#e7eeff",
    text: "#0e1b34",
    muted: "#5f7ba6",
    alarm: "#ce2447",
    control: "#22406e",
    controlRule: "#c6dbff",
  },
};

// next/font is not on this document either, so the family is named and then
// fallen back through. A reader who happens to have Plex installed gets the
// house face; everyone else gets their system's, which is the correct failure.
const SANS = '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * `reset` is offered by Next and deliberately not taken, for the reason spelled
 * out in `app/error.tsx`: it re-renders the boundary's children from the client
 * tree, issues no request, and so cannot re-run a Server Component. It is even
 * more useless here than there — the thing that threw is the root layout, so
 * there is no client tree to re-render into. Next's own built-in global error
 * reached the same conclusion and wired its button to a form submit. A document
 * load is the only control on this page that does anything.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  // Read at render, not in an effect. This component only ever runs on the
  // client (see the header comment), so the value is available on the first
  // render and there is no second paint to flip. `readStoredTheme` cannot
  // throw; with no storage at all it answers "dark", which is this app's
  // default and the reader most likely to be hurt by getting it wrong.
  const theme = readStoredTheme();
  const c = PALETTE[theme];

  const message =
    typeof error?.message === "string" && !error.message.includes(REDACTED)
      ? error.message
      : null;
  const digest = typeof error?.digest === "string" ? error.digest : null;

  return (
    <html
      lang="en"
      data-theme={theme}
      // Nothing renders this on the server today, so nothing hydrates it. The
      // attribute is here for the same reason layout.tsx carries it: the theme
      // is a client-only fact, and if a future Next does SSR this file, one
      // attribute differing is expected rather than a bug.
      suppressHydrationWarning
      style={{ colorScheme: theme, background: c.bg }}
    >
      {/* React owns <head> as a singleton and clears what it does not render,
          so the <title> from layout.tsx's metadata — which DOES reach this
          document, it is how the color-scheme meta gets here — is gone by the
          time this paints. Next's own built-in global error renders a <head>
          for the same reason. One element, no imports, no way to fail. */}
      <head>
        <title>open-kb — this page could not render</title>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: c.bg,
          color: c.text,
          fontFamily: SANS,
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <div style={{ margin: "0 auto", maxWidth: "72rem", padding: "2.5rem 1.25rem" }}>
          <div
            style={{
              borderRadius: "0.5rem",
              border: `1px dashed ${c.rule}`,
              background: c.card,
              padding: "2rem 1rem",
              textAlign: "center",
              fontSize: "0.875rem",
              lineHeight: 1.5,
              color: c.alarm,
            }}
          >
            Could not render this page, or the app around it
            <div style={{ marginTop: "0.75rem", color: c.muted, fontSize: "0.8125rem" }}>
              The root layout threw. Everything this app draws sits inside it —
              the header, the navigation, the command palette — so none of it is
              on screen and this card is the whole page. Every route renders
              through that layout, so another URL will land back here.
            </div>
            {message && (
              <div style={{ marginTop: "0.25rem", fontFamily: MONO, fontSize: "0.75rem", color: c.muted, overflowWrap: "anywhere" }}>
                {message}
              </div>
            )}
            {digest ? (
              // Same wording as app/error.tsx, and for the same measured
              // reason: `grep <digest>` prints the digest line alone, and the
              // message is five lines above it in the entry.
              <div style={{ marginTop: "0.25rem", fontFamily: MONO, fontSize: "0.75rem", color: c.muted, overflowWrap: "anywhere" }}>
                digest {digest} — the server log entry carries the same value
                (grep -B6 {digest})
              </div>
            ) : (
              !message && (
                <div style={{ marginTop: "0.25rem", fontFamily: MONO, fontSize: "0.75rem", color: c.muted, overflowWrap: "anywhere" }}>
                  nothing about this error reached the browser; the server log
                  has it
                </div>
              )
            )}
            <div style={{ marginTop: "1rem" }}>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{
                  borderRadius: "0.375rem",
                  border: `1px solid ${c.controlRule}`,
                  background: "transparent",
                  padding: "0.375rem 0.625rem",
                  fontSize: "11px",
                  fontWeight: 500,
                  fontFamily: "inherit",
                  color: c.control,
                  cursor: "pointer",
                }}
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}

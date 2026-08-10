import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google";
import Link from "next/link";
import { CommandPaletteProvider } from "@/components/CommandPalette";
import { HeaderNav } from "@/components/HeaderNav";
import { SkipLink } from "@/components/SkipLink";
import "./globals.css";

// The bureau family: Plex Sans works, Plex Mono measures, Plex Serif speaks.
// Sans/mono keep the legacy variable names so every component inherits as-is.
const plexSans = IBM_Plex_Sans({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const plexSerif = IBM_Plex_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "open-kb",
  description: "One domain in, its whole market out.",
};

/**
 * The one thing that still reaches the reader when THIS FILE throws.
 *
 * If the component below throws, Next serves its own document — `<html
 * id="__next_error__">`, an empty `<head>` and `<body>`, no stylesheet, and the
 * app arriving afterwards as flight data for the client to render. Measured on
 * a production build with the chunks blocked, so the frame is exactly what the
 * server sent: the top-left pixel was `rgb(255,255,255)` under
 * `prefers-color-scheme: light` and under `dark` alike. White, for everyone,
 * on the worst page in the app.
 *
 * Nothing rendered can fix that frame. The `<head>` in the component below is
 * never parsed on that document, which is why 3g's fix had to go to
 * `ThemeToggle`; and `app/global-error.tsx` is not server-rendered at all, so
 * an inline pre-paint script there is not late — it is absent (the measurement
 * is written out in that file). What DOES survive is this export and the
 * `metadata` one above it: they are read off the module without invoking the
 * component, which is why `<title>open-kb</title>` was in that white document
 * all along. `colorScheme` is the only paint instruction the metadata channel
 * can carry, and it is enough to hold the UA's canvas at the app's own theme.
 *
 * A SINGLE VALUE, not `"dark light"`. The pair would follow the operating
 * system, and this app's theme is its own: a reader on a dark OS who chose
 * light here would get the wrong frame. One value matches the app's own
 * default, so the majority is served.
 *
 * `"light"`, because light is that default (see lib/theme.ts). It costs the
 * reader who opted into dark a brief pale frame before their card paints, and
 * a pale empty page for as long as the global-error chunk is missing. Measured
 * on the inverse of this setting: the flip lands in about 25ms. Two of the
 * three storage states are served correctly and the third gets that flip.
 *
 * IT IS INVISIBLE ON EVERY HEALTHY PAGE. `globals.css` declares `color-scheme`
 * on `:root` in both theme blocks, and a CSS declaration on the root element
 * beats this meta; the stylesheet is render-blocking, so there is no window
 * before it applies. Measured: a light reader's first paint on `/` is white
 * with this export in place, exactly as before it.
 *
 * One key only. `mergeViewport` in Next's metadata resolver walks the keys this
 * object actually has and leaves the rest of `createDefaultViewport()` alone,
 * so `width=device-width, initial-scale=1` still ships — restating them here
 * would be two more literals to drift, buying nothing.
 */
export const viewport: Viewport = {
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // The no-fouc script below stamps data-theme on <html> before paint, so
      // the server markup (no attribute) and the pre-hydration DOM differ by one
      // attribute, expected, and suppressed here.
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexMono.variable} ${plexSerif.variable} h-full antialiased`}
    >
      <head>
        {/* No-FOUC theme boot: read the saved choice and set data-theme before
            first paint, so there is never a flash between the two. Kept tiny and
            dependency-free; ThemeToggle owns the runtime flips thereafter.
            LIGHT is the default here. Most of what anyone does is read a
            finished map, share a link to one, or screenshot a graph, and all
            three want paper. Dark is one click and it sticks.
            This literal must agree with `themeFromStored` in lib/theme.ts, and
            theme.test.ts evaluates this exact string against it. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('kb-theme');document.documentElement.dataset.theme=t==='dark'?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();",
          }}
        />
      </head>
      {/* suppressHydrationWarning: extensions inject body attributes before
          React hydrates — attribute-only, children still checked */}
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        <CommandPaletteProvider>
          <SkipLink />
          <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
            {/* brand hairline — the blue action accent, edge to edge */}
            <div className="h-px bg-gradient-to-r from-transparent via-sky-400/60 to-transparent" />
            <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:gap-8 sm:px-5">
              <Link
                href="/"
                className="group inline-flex items-center gap-2 font-display text-[17px] font-semibold tracking-tight text-slate-100"
              >
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 transition-transform group-hover:scale-125"
                  style={{
                    boxShadow: "0 0 8px 1px color-mix(in srgb, var(--accent) 45%, transparent)",
                  }}
                />
                <span className="group-hover:text-sky-300">
                  open<span className="text-sky-400">·</span>kb
                </span>
              </Link>
              <HeaderNav />
            </div>
          </header>
          <main id="main" className="flex-1" tabIndex={-1}>
            {children}
          </main>
        </CommandPaletteProvider>
      </body>
    </html>
  );
}

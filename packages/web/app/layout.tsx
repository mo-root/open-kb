import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google";
import Link from "next/link";
import { HeaderNav } from "@/components/HeaderNav";
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
            first paint, so there is never a light→dark flash. Kept tiny and
            dependency-free; ThemeToggle owns the runtime flips thereafter.
            DARK is the default here — this is a live console, read while a run
            is going, not the paper dashboard v1 defaulted to. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('kb-theme');document.documentElement.dataset.theme=t==='light'?'light':'dark';}catch(e){document.documentElement.dataset.theme='dark';}})();",
          }}
        />
      </head>
      {/* suppressHydrationWarning: extensions inject body attributes before
          React hydrates — attribute-only, children still checked */}
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
          {/* brand hairline — the blue action accent, edge to edge */}
          <div className="h-px bg-gradient-to-r from-transparent via-sky-400/60 to-transparent" />
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-5">
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
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}

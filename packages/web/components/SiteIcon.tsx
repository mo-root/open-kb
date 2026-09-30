"use client";

import { useState } from "react";
import { NodeGlyph } from "@/components/icons";
import { normalizeDomain } from "@/lib/anchor";

/* SiteIcon, a competitor / player favicon chip.

   Renders the site's favicon from DuckDuckGo's icon proxy
   (`icons.duckduckgo.com/ip3/<domain>.ico`) — privacy-friendlier than Google's
   s2 beacon — inside a fixed, rounded box so it NEVER shifts layout. On an empty
   domain or a load error it falls back gracefully: a name monogram when we have
   a name, else the player glyph, tinted the rival pink. A row therefore always
   shows something branded, never a broken-image glyph.

   The favicon host is the only third-party request this view makes from the
   client, and it receives only the bare domain — already public in the note. */

const FAVICON_HOST = "https://icons.duckduckgo.com/ip3";

/** Strip scheme / www. / path from a domain-ish string -> bare host — and,
 *  since this now shares `lib/anchor.ts`'s validator rather than carrying its
 *  own copy of that strip, refuse a reserved or malformed host too. Neither
 *  this component nor `KbBrowser.tsx` (the other importer, for the manifest's
 *  root link) ever hands it one on a real run, so nothing observable changes
 *  here — the win is one implementation instead of two that happened to
 *  agree only by coincidence. */
export { normalizeDomain };

/** First alphanumeric of a name, uppercased, the monogram fallback glyph. */
function monogram(name?: string): string {
  const m = (name ?? "").match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : "";
}

export interface SiteIconProps {
  /** Bare domain ("firecrawl.dev"); scheme / www. / path are tolerated. */
  domain?: string | null;
  /** Box edge in px (width === height). Default 16. */
  size?: number;
  /** Competitor name, used for the alt text and the monogram fallback. */
  name?: string;
  className?: string;
}

export function SiteIcon({
  domain,
  size = 16,
  name,
  className = "",
}: SiteIconProps) {
  const host = normalizeDomain(domain);
  // Track the host that failed (not a bare boolean): when `domain` changes as a
  // list row is reused, `errored === host` is false again, so the new favicon
  // is retried without a manual reset effect.
  const [errored, setErrored] = useState<string | null>(null);
  const useFallback = !host || errored === host;

  const box: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(3, Math.round(size * 0.25)),
  };

  if (useFallback) {
    const mg = monogram(name);
    return (
      <span
        aria-hidden
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden bg-slate-800/70 ${className}`}
        style={{
          ...box,
          color: "var(--type-player, #EB368C)",
          boxShadow:
            "inset 0 0 0 1px color-mix(in srgb, var(--type-player, #EB368C) 30%, transparent)",
        }}
      >
        {mg ? (
          <span
            className="font-mono font-semibold leading-none"
            style={{ fontSize: Math.max(8, Math.round(size * 0.6)) }}
          >
            {mg}
          </span>
        ) : (
          <NodeGlyph kind="player" size={Math.round(size * 0.72)} />
        )}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${className}`}
      style={{
        ...box,
        backgroundColor: "rgba(255,255,255,0.92)",
        // Token hairline (--border): visible soft-blue edge on the white chip in
        // light mode; the old 25%-opacity slate line vanished on paper.
        boxShadow: "inset 0 0 0 1px var(--border)",
      }}
    >
      {/* Plain <img>, not next/image: the favicon host is not configured for the
          image optimizer, and a broken .ico must fall back — not 500. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${FAVICON_HOST}/${host}.ico`}
        alt={name ? `${name} favicon` : `${host} favicon`}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setErrored(host)}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
          display: "block",
        }}
      />
    </span>
  );
}

"use client";

/**
 * Favicons for the graph, fetched on demand.
 *
 * WHAT WAS WRONG. The canvas loaded an icon only for nodes of type `player`
 * (`n.type !== "player" || !n.domain` skipped everything else), and it loaded
 * all of them eagerly the moment the graph mounted. On a real map that is both
 * too little and too much at once: of 295 nodes, 289 carry a domain, but only
 * 129 were ever given an icon — so 139 communities with instantly recognisable
 * marks (serverfault, superuser, youtube, reddit) and 20 products rendered as
 * bare coloured dots, while the 129 that did qualify all fired their requests
 * in the same frame, most of them for nodes drawn too small to show anything.
 *
 * So: ANY node with a domain may have an icon, and an icon is fetched only when
 * something actually asks to draw one. The painter asks per frame; nodes below
 * the legibility threshold never ask, and a map viewed zoomed-out costs nothing.
 *
 * Two properties the canvas depends on:
 *
 *   · `get()` NEVER blocks and never throws. It returns the bitmap if it is
 *     ready and `null` otherwise, having quietly started the fetch. A painter
 *     cannot await, so this is the only shape that works.
 *
 *   · A domain is attempted ONCE. A miss is remembered as a miss — the icon
 *     host answers 404 for plenty of real hosts, and a painter that re-requests
 *     on every frame would issue thousands of requests for a site that has no
 *     favicon.
 */

const FAVICON_HOST = "https://icons.duckduckgo.com/ip3";

/** In flight at once. The browser caps per-host connections anyway; this keeps
 *  the queue from head-of-line blocking the tiles a reader is looking at. */
const MAX_INFLIGHT = 6;

type Entry =
  | { state: "loading" }
  | { state: "ready"; img: HTMLImageElement }
  | { state: "missing" };

export class IconCache {
  private entries = new Map<string, Entry>();
  private queue: string[] = [];
  private inflight = 0;
  private onReady: () => void;

  /** @param onReady called when a new icon lands, so the canvas can repaint. */
  constructor(onReady: () => void) {
    this.onReady = onReady;
  }

  /**
   * The bitmap for `domain`, or null.
   *
   * Safe to call from inside a render loop: it is a map lookup plus, at most,
   * one enqueue. Everything slow happens off the frame.
   */
  get(domain: string | undefined | null): HTMLImageElement | null {
    if (!domain) return null;
    const entry = this.entries.get(domain);
    if (entry) return entry.state === "ready" ? entry.img : null;
    this.request(domain);
    return null;
  }

  private request(domain: string): void {
    this.entries.set(domain, { state: "loading" });
    // Newest first: the painter asks for what is on screen NOW, and a reader
    // who pans away should not wait behind icons for a region they have left.
    this.queue.unshift(domain);
    this.pump();
  }

  private pump(): void {
    while (this.inflight < MAX_INFLIGHT && this.queue.length > 0) {
      const domain = this.queue.shift()!;
      this.inflight += 1;
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.decoding = "async";
      const settle = (ok: boolean) => {
        this.inflight -= 1;
        // A 1x1 tracking pixel is the icon host's way of saying "nothing here".
        // Treated as a miss so the node keeps its glyph instead of drawing a
        // smudge where a logo should be.
        const real = ok && img.naturalWidth > 1 && img.naturalHeight > 1;
        this.entries.set(domain, real ? { state: "ready", img } : { state: "missing" });
        if (real) this.onReady();
        this.pump();
      };
      img.onload = () => settle(true);
      img.onerror = () => settle(false);
      img.src = `${FAVICON_HOST}/${domain}.ico`;
    }
  }

  /** Drop everything in flight. Called when the graph unmounts so a pending
   *  icon cannot fire `onReady` into a component that is gone. */
  dispose(): void {
    this.queue.length = 0;
    this.onReady = () => {};
  }
}

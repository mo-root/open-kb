"use client";

import { useEffect, useRef } from "react";

/* The film's total runtime, from the rig itself (launch-rig.html: TOTAL). */
const TOTAL = 25.4;
/* How much scroll buys the whole film. ~45 viewports ≈ 0.56s of film per
   screen — heavy enough that even the ticker rip and the detonation move a
   few frames at a time under one scroll-wheel click. */
const TRACK_VH = 4500;

/**
 * The launch film, played by the reader's thumb.
 *
 * Not a <video> being scrubbed — seeking an mp4 lands on keyframes and
 * stutters. The film ships as its own render rig (public/launch-rig.html), a
 * deterministic function of time exposing `window.SEEK(t)`, so this component
 * embeds the rig same-origin and maps scroll progress straight onto the
 * film's clock. Every frame exists at every scroll position, pixel-perfect at
 * any viewport.
 *
 * Scroll state lives in refs and writes to the DOM imperatively: driving a
 * React render 60 times a second to move a hairline would be the exact cost
 * the graph canvas spent this codebase's whole life removing.
 */
export function ScrollFilm() {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const drive = () => {
      raf = 0;
      const track = trackRef.current;
      if (!track) return;
      const span = track.offsetHeight - window.innerHeight;
      const p =
        span > 0
          ? Math.min(1, Math.max(0, -track.getBoundingClientRect().top / span))
          : 0;
      const w = frameRef.current?.contentWindow as
        | (Window & { SEEK?: (t: number) => void })
        | null;
      w?.SEEK?.(p * TOTAL);
      if (barRef.current) barRef.current.style.width = `${(p * 100).toFixed(2)}%`;
      if (hintRef.current) hintRef.current.style.opacity = p < 0.02 ? "1" : "0";
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(drive);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    /* First paint: the rig loads at ?t=0 on its own; this only syncs a reader
       who arrived mid-page via a hash or a back-navigation. */
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={trackRef} className="relative" style={{ height: `${TRACK_VH}vh` }}>
      <div className="sticky top-0 h-screen overflow-hidden">
        {/* pointer-events-none: the iframe must never swallow the wheel — the
            scroll IS the play button. */}
        <iframe
          ref={frameRef}
          src="/launch-rig.html?t=0"
          title="The launch film: one domain in, knowledge base out — advanced by scrolling"
          className="pointer-events-none h-full w-full border-0"
        />
        <div
          ref={hintRef}
          className="pointer-events-none absolute inset-x-0 bottom-10 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500 transition-opacity duration-500"
        >
          scroll to play
        </div>
        {/* the film's clock, as a hairline */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-slate-200/60">
          <div ref={barRef} className="h-full bg-sky-500" style={{ width: "0%" }} />
        </div>
      </div>
    </div>
  );
}

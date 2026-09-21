/**
 * Point on a circle at `deg` degrees (SVG's y-down convention, 0° = +x axis).
 *
 * Byte-for-byte duplicated in `Gauge.tsx` and `Donut.tsx` — the two files in
 * this directory with real arc geometry in them — before this: both had the
 * identical five-line function, each computing the same start/end point for
 * its own arc path. Same shape of gap SELF-553/559/564 found and fixed
 * elsewhere (`isAbortError`, `scripts/hostOf`, `components/hostOf`): a widened
 * formula (a different angle convention, a precision change) landing in one
 * copy and not the other would silently bend one chart's arcs and leave the
 * other's correct. Both callers already have indirect test coverage of this
 * function's output, through the rendered `d="…"` path assertions in
 * `Gauge.test.tsx` and `Donut.test.tsx` — unlike the `hostOf` pair, there was
 * no coverage gap to wait on here.
 */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

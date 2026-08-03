import type { CSSProperties, ReactNode } from "react";

/* Donut, part-to-whole for a small set of categories (composition by node
   type). Segments are stroked ring arcs separated by a real angular gap so the
   card surface shows through (the 2px surface-gap spacer, not a drawn border).
   A legend is always present so identity never rests on colour alone; the ring
   is aria-hidden and the wrapper carries the summary. Pure render, no hooks.

   Colour follows the entity (each segment supplies its own token), never its
   rank — filtering the ring to non-zero slices never repaints the survivors. */

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const [sx, sy] = polar(cx, cy, r, startDeg);
  const [ex, ey] = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${sx.toFixed(2)} ${sy.toFixed(2)} A${r} ${r} 0 ${large} 1 ${ex.toFixed(
    2,
  )} ${ey.toFixed(2)}`;
}

export interface DonutSegment {
  key?: string;
  label: string;
  value: number;
  color: string;
  glyph?: ReactNode;
}

export interface DonutProps {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  /** Angular gap between segments, degrees. Default 3. */
  gapDeg?: number;
  /** Where the ring starts, SVG degrees (y-down). Default -90 = top. */
  startDeg?: number;
  centerValue?: ReactNode;
  centerLabel?: string;
  legend?: "right" | "bottom" | "none";
  className?: string;
  style?: CSSProperties;
}

const pct = (v: number, total: number) =>
  total > 0 ? Math.round((v / total) * 100) : 0;

export function Donut({
  segments,
  size = 168,
  thickness = 20,
  gapDeg = 3,
  startDeg = -90,
  centerValue,
  centerLabel,
  legend = "right",
  className,
  style,
}: DonutProps) {
  const total = segments.reduce((n, s) => n + Math.max(0, s.value), 0);
  const ring = segments.filter((s) => s.value > 0);
  const r = (size - thickness) / 2;
  const c = size / 2;
  const single = ring.length === 1;

  // Walk the ring, converting each slice's share into an arc inset by the gap.
  let cursor = startDeg;
  const arcs = ring.map((s) => {
    const sweep = (Math.max(0, s.value) / total) * 360;
    const a0 = cursor + gapDeg / 2;
    const a1 = cursor + sweep - gapDeg / 2;
    cursor += sweep;
    return { seg: s, a0, a1, draw: a1 > a0 };
  });

  const summary = segments
    .map((s) => `${s.label} ${s.value} (${pct(s.value, total)}%)`)
    .join(", ");

  const wheel = (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      className="block shrink-0"
    >
      {single ? (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={ring[0].color}
          strokeWidth={thickness}
        />
      ) : (
        arcs.map(
          (a, i) =>
            a.draw && (
              <path
                key={a.seg.key ?? a.seg.label ?? i}
                d={arc(c, c, r, a.a0, a.a1)}
                fill="none"
                stroke={a.seg.color}
                strokeWidth={thickness}
                strokeLinecap="butt"
              />
            ),
        )
      )}
    </svg>
  );

  const center = (centerValue !== undefined || centerLabel) && (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
      style={{ width: size, height: size }}
    >
      {centerValue !== undefined && (
        <span
          className="font-semibold leading-none text-slate-100"
          style={{ fontSize: Math.round(size * 0.19) }}
        >
          {centerValue}
        </span>
      )}
      {centerLabel && (
        <span className="mt-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">
          {centerLabel}
        </span>
      )}
    </div>
  );

  const legendRows = legend !== "none" && (
    <ul
      className={
        legend === "right"
          ? "grid min-w-0 flex-1 gap-1.5"
          : "grid grid-cols-2 gap-x-4 gap-y-1.5"
      }
    >
      {segments.map((s, i) => (
        <li
          key={s.key ?? s.label ?? i}
          className="flex items-center gap-2 text-[11px]"
        >
          {s.glyph ? (
            <span aria-hidden className="shrink-0 leading-none" style={{ color: s.color }}>
              {s.glyph}
            </span>
          ) : (
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: s.color }}
            />
          )}
          <span className="min-w-0 flex-1 truncate font-mono uppercase tracking-wide text-slate-400">
            {s.label}
          </span>
          <span
            className={`tnum shrink-0 ${s.value > 0 ? "text-slate-200" : "text-slate-600"}`}
          >
            {s.value}
          </span>
          <span className="tnum w-8 shrink-0 text-right text-slate-500">
            {pct(s.value, total)}%
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <div
      role="img"
      aria-label={`composition: ${summary}`}
      className={`flex ${
        legend === "right"
          ? "flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-5"
          : "flex-col items-center gap-4"
      } ${className ?? ""}`}
      style={style}
    >
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        {wheel}
        {center}
      </div>
      {legendRows}
    </div>
  );
}

export default Donut;

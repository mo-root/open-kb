import type { CSSProperties } from "react";

/* Sparkline, a hand-rolled SVG micro-line for a small series (a stat-tile
   trend or a distribution profile). 2px round-joined stroke, optional 10%
   area wash and an end marker carrying a 2px surface ring so it stays legible
   where it crosses gridlines or other marks (dataviz mark specs). Pure render,
   no hooks — safe in a server or client tree. Colour comes from a brand token
   so every spark in the app reads as one system. */

export interface SparklineProps {
  /** The series, left → right. Non-finite entries are dropped. */
  values: number[];
  width?: number;
  height?: number;
  /** Line + fill + end-dot colour. Default: the primary accent. */
  color?: string;
  /** Draw the ~10% area wash beneath the line. Default true. */
  fill?: boolean;
  /** Draw the filled end marker with a surface ring. Default true. */
  showEnd?: boolean;
  strokeWidth?: number;
  /** Surface colour for the end-dot ring, match the card behind the spark. */
  surface?: string;
  /** "none" + a `w-full` class lets the spark stretch fluidly to its
   *  container; the stroke stays crisp via non-scaling-stroke. Default "meet". */
  preserveAspectRatio?: string;
  /** Accessible name. Omit for an auto summary (points · min → max · last). */
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = "var(--accent, #3D7FFC)",
  fill = true,
  showEnd = true,
  strokeWidth = 2,
  surface = "var(--surface, #0D2243)",
  preserveAspectRatio = "xMidYMid meet",
  ariaLabel,
  className,
  style,
}: SparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        aria-hidden
        className={className}
        style={style}
      />
    );
  }

  const pad = strokeWidth + 1;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const n = clean.length;
  const x = (i: number) =>
    n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  const pts = clean.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${x(n - 1).toFixed(2)},${(height - pad).toFixed(
    2,
  )} L${x(0).toFixed(2)},${(height - pad).toFixed(2)} Z`;

  const last = clean[n - 1];
  const label =
    ariaLabel ?? `sparkline, ${n} points, ${min} to ${max}, ending ${last}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={preserveAspectRatio}
      role="img"
      aria-label={label}
      className={className}
      style={style}
    >
      {fill && <path d={area} fill={color} fillOpacity={0.1} stroke="none" />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {showEnd && (
        <circle
          cx={x(n - 1)}
          cy={y(last)}
          r={Math.max(2.5, strokeWidth)}
          fill={color}
          stroke={surface}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export default Sparkline;

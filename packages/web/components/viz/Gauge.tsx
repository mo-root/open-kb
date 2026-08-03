import type { CSSProperties, ReactNode } from "react";

/* Gauge — a single ratio against a limit, drawn as a 240° arc dial (dataviz:
   a meter, not a one-slice pie). The fill arc rides on a lighter same-ramp
   track so the state reads across the whole sweep; round caps, one hue. The
   centre carries the value as a proportional hero-style number (never tabular
   — tnum only belongs in aligned columns). Pure render, no hooks. */

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const [sx, sy] = polar(cx, cy, r, startDeg);
  const [ex, ey] = polar(cx, cy, r, endDeg);
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const sweep = endDeg >= startDeg ? 1 : 0;
  return `M${sx.toFixed(2)} ${sy.toFixed(2)} A${r} ${r} 0 ${large} ${sweep} ${ex.toFixed(
    2,
  )} ${ey.toFixed(2)}`;
}

export interface GaugeProps {
  value: number;
  min?: number;
  max?: number;
  size?: number;
  thickness?: number;
  /** Fill colour (severity or a brand token). Default: primary accent. */
  color?: string;
  /** Unfilled track — a lighter step of the same ramp. */
  trackColor?: string;
  /** Small label under the number. */
  label?: string;
  /** Override the centre number (e.g. "18%"); default rounds `value`. */
  valueText?: string;
  /** Arc geometry: start angle + sweep, SVG degrees (y-down). */
  startDeg?: number;
  sweepDeg?: number;
  /** Replace the centre content entirely. */
  center?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Gauge({
  value,
  min = 0,
  max = 100,
  size = 128,
  thickness = 10,
  color = "var(--accent, #3D7FFC)",
  trackColor = "var(--border, #1C3763)",
  label,
  valueText,
  startDeg = 150,
  sweepDeg = 240,
  center,
  className,
  style,
}: GaugeProps) {
  const frac = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const r = (size - thickness) / 2;
  const c = size / 2;
  const endDeg = startDeg + sweepDeg;
  const valEnd = startDeg + sweepDeg * frac;
  const shown = valueText ?? String(Math.round(value));
  const aria = `${label ?? "gauge"}: ${shown}${valueText ? "" : ` of ${max}`}`;

  return (
    <div
      role="img"
      aria-label={aria}
      className={`relative inline-flex items-center justify-center ${className ?? ""}`}
      style={{ width: size, height: size, ...style }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden
        className="block"
      >
        <path
          d={arcPath(c, c, r, startDeg, endDeg)}
          fill="none"
          stroke={trackColor}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {frac > 0 && (
          <path
            d={arcPath(c, c, r, startDeg, valEnd)}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
          />
        )}
      </svg>
      <div
        aria-hidden
        className="absolute inset-0 flex flex-col items-center justify-center"
      >
        {center ?? (
          <>
            <span
              className="font-semibold leading-none text-slate-100"
              style={{ fontSize: Math.round(size * 0.24) }}
            >
              {shown}
            </span>
            {label && (
              <span className="mt-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">
                {label}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default Gauge;

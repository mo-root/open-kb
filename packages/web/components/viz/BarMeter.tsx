import type { CSSProperties, ReactNode } from "react";

/* BarMeter, a labelled horizontal bar breakdown: magnitude across a few
   categories (players by kind, listening layers). Every bar is direct-labelled
   with its name and value, so colour is a reinforcing channel, never the sole
   identity — which keeps adjacent hues gate-safe (dataviz series ladder). Bars
   grow from one left baseline with a 4px rounded data-end on a lighter track.
   Text wears text tokens; only the fill wears the series colour. Pure render. */

export interface BarMeterRow {
  key?: string;
  label: string;
  value: number;
  /** Fill colour for this row's bar. Falls back to `accent`. */
  color?: string;
  /** Optional leading mark (a NodeGlyph), tinted to the row colour. */
  glyph?: ReactNode;
}

export interface BarMeterProps {
  rows: BarMeterRow[];
  /** Track maximum. Default: the largest row value (tallest bar fills). */
  max?: number;
  /** Default bar colour when a row omits one. */
  accent?: string;
  /** Bar thickness in px. Default 8 (thin). */
  barHeight?: number;
  /** Sort rows descending by value. Colour follows the row, not its rank. */
  sort?: boolean;
  /** Format the value shown at the tip. Default: locale integer. */
  valueFormat?: (n: number) => string;
  /** Accessible group name. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function BarMeter({
  rows,
  max,
  accent = "var(--accent, #3D7FFC)",
  barHeight = 8,
  sort = true,
  valueFormat = (n) => n.toLocaleString(),
  title,
  className,
  style,
}: BarMeterProps) {
  const ordered = sort ? [...rows].sort((a, b) => b.value - a.value) : rows;
  const ceiling = max ?? Math.max(1, ...ordered.map((r) => Math.max(0, r.value)));

  return (
    <div
      role="group"
      aria-label={title}
      className={`grid gap-2 ${className ?? ""}`}
      style={style}
    >
      {ordered.map((r, i) => {
        const w = Math.max(0, Math.min(100, (Math.max(0, r.value) / ceiling) * 100));
        const color = r.color ?? accent;
        return (
          <div key={r.key ?? r.label ?? i} className="flex items-center gap-2.5">
            {r.glyph && (
              <span aria-hidden className="shrink-0 leading-none" style={{ color }}>
                {r.glyph}
              </span>
            )}
            <span className="w-24 shrink-0 truncate font-mono text-[11px] uppercase tracking-wide text-slate-400">
              {r.label}
            </span>
            <span
              className="relative min-w-0 flex-1 overflow-hidden rounded-[3px] bg-slate-800/60"
              style={{ height: barHeight }}
            >
              <span
                className="absolute left-0 top-0 h-full rounded-r-[4px]"
                style={{
                  width: `${w}%`,
                  minWidth: r.value > 0 ? 3 : 0,
                  background: color,
                }}
              />
            </span>
            <span className="tnum w-8 shrink-0 text-right text-[11px] text-slate-300">
              {valueFormat(r.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default BarMeter;

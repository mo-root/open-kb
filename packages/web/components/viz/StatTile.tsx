import type { CSSProperties, ReactNode } from "react";
import { Sparkline } from "./Sparkline";

/* StatTile, one headline number in the KPI row: a glyph, a value, a label,
   and an optional hint or trend spark. The value uses proportional figures
   (never tabular — tnum is for aligned columns, and it makes a display number
   look loose), auto-compacted (1,284 / 12.9K / 4.2M). Text wears text tokens;
   the glyph carries the accent. Pure render, no hooks. */

function compact(v: number | string): string {
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(v % 1e3 === 0 ? 0 : 1)}K`;
  return v.toLocaleString();
}

export interface StatTileProps {
  label: string;
  value: number | string;
  glyph?: ReactNode;
  /** Small secondary line under the label (e.g. "38% of notes"). */
  hint?: string;
  /** Value colour class. Default: text-slate-100. */
  tone?: string;
  /** Optional trend series → a corner sparkline. */
  trend?: number[];
  trendColor?: string;
  className?: string;
  style?: CSSProperties;
}

export function StatTile({
  label,
  value,
  glyph,
  hint,
  tone = "text-slate-100",
  trend,
  trendColor,
  className,
  style,
}: StatTileProps) {
  return (
    <div
      className={`flex items-center gap-3 bg-slate-900 px-3.5 py-3 ${className ?? ""}`}
      style={style}
    >
      {glyph && (
        <span aria-hidden className="shrink-0 leading-none">
          {glyph}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className={`text-xl font-semibold leading-none ${tone}`}>
          {compact(value)}
        </div>
        <div className="mt-1.5 truncate font-mono text-[10px] uppercase tracking-wider text-slate-500">
          {label}
        </div>
        {hint && (
          <div className="mt-0.5 truncate text-[10px] text-slate-500">{hint}</div>
        )}
      </div>
      {trend && trend.length > 1 && (
        <Sparkline
          values={trend}
          width={52}
          height={22}
          color={trendColor ?? "var(--accent, #3D7FFC)"}
          className="shrink-0 self-end"
        />
      )}
    </div>
  );
}

export default StatTile;

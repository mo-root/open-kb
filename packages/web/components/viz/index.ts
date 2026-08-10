/* Reusable, hand-rolled SVG data-viz primitives (accessible, thin marks,
   brand-token colour, no chart libraries). Ported from v1 unchanged.

   `Gauge` draws one ratio against a limit. The engine still has no DOLLAR
   ceiling to draw against — the run's `cost.ceilingUsd` is explicitly null —
   but the KB dashboard has two other ratios that are real (mean placement out
   of 100, and how much of the host bag the classifier could place), so it
   landed with those panels. */

export { StatTile, type StatTileProps } from "./StatTile";
export { Donut, type DonutProps, type DonutSegment } from "./Donut";
export { BarMeter, type BarMeterProps, type BarMeterRow } from "./BarMeter";
export { Sparkline, type SparklineProps } from "./Sparkline";
export { Gauge, type GaugeProps } from "./Gauge";

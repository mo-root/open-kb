/* Reusable, hand-rolled SVG data-viz primitives (accessible, thin marks,
   brand-token colour, no chart libraries). Ported from v1 unchanged.

   v1's `Gauge` is not here: it draws one ratio against a limit, and this engine
   has no limit to draw against. */

export { StatTile, type StatTileProps } from "./StatTile";
export { Donut, type DonutProps, type DonutSegment } from "./Donut";
export { BarMeter, type BarMeterProps, type BarMeterRow } from "./BarMeter";
export { Sparkline, type SparklineProps } from "./Sparkline";

import React from "react";

/* The shared chip vocabulary, ported from v1's components/ui.tsx.
   Trimmed to what the map surface actually uses: `Chip` for a neutral tag and
   `KindChip` for a classified entity. v1's `TypeChip`, `SectionHead`,
   `MicroHead` and `RelevanceBadge` belonged to the KB-browsing pages, which are
   not part of this app — a component nothing renders is a component nobody
   maintains. */

// Entity-kind -> chip tone. The same kind wears the same hue everywhere:
// companies and products take the blue action ramp, communities the lavender,
// publishers and directories the muted slate. Cyan (emerald) is reserved for
// data-flow, rose for genuine alerts, so neither appears here.
const KIND_TONES: Record<string, string> = {
  company: "text-amber-300 border-amber-500/40 bg-amber-500/10",
  product: "text-sky-300 border-sky-500/40 bg-sky-500/10",
  community: "text-violet-300 border-violet-400/40 bg-violet-400/10",
  publisher: "text-slate-300 border-slate-600/50 bg-slate-700/30",
  directory: "text-slate-300 border-slate-600/50 bg-slate-700/30",
  noise: "text-slate-500 border-slate-700/50 bg-slate-800/30",
};

export function KindChip({ kind }: { kind: string }) {
  const tone =
    KIND_TONES[kind.toLowerCase().trim()] ?? "text-slate-300 border-slate-600/50 bg-slate-700/30";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {kind}
    </span>
  );
}

export function Chip({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "sky" | "amber" | "emerald" | "rose";
}) {
  const tones: Record<string, string> = {
    slate: "text-slate-300 border-slate-700 bg-slate-800/50",
    sky: "text-sky-300 border-sky-500/30 bg-sky-500/10",
    amber: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    emerald: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    rose: "text-rose-300 border-rose-500/30 bg-rose-500/10",
  };
  return (
    <span
      className={`tnum inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

"use client";

import { useState } from "react";
import { Chip } from "@/components/ui";
import {
  INTENT_BLURB,
  INTENT_LABEL,
  formatUsd,
  groupPlan,
  type Intent,
  type PlanView,
  type UnderstandingView,
} from "./types";

/* The two panels that make a run legible before the sweep spends anything:
   what it understood, and — the requirement this file exists for — every query
   it planned WITH THE REASON IT IS WORTH BUYING.

   Ported from v1's PlanCard chrome (the sky-bordered card, the uppercase badge,
   the numbered mono query list). Two changes: the understanding card is much
   smaller, because this engine reads a company in one model call rather than
   five; and the plan groups by INTENT rather than by anchor, because every
   query here is de-branded by construction and the anchor axis is flat. */

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={`mt-0.5 truncate text-slate-200 ${mono ? "font-mono text-xs" : "text-sm"}`}
        title={value}
      >
        {value || "—"}
      </div>
    </div>
  );
}

// ------------------------------------------------------- what it understood --

export function UnderstandingCard({ u }: { u: UnderstandingView }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-300">
          understood
        </span>
        <span className="text-sm text-slate-400">
          read off {u.domain || "the company"}&rsquo;s own pages, before a cent was spent on search
        </span>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            what it sells
          </div>
          <p className="text-[13px] leading-snug text-slate-200">{u.sells || "—"}</p>

          <div className="mb-1.5 mt-5 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            who buys it
          </div>
          <p className="text-[13px] leading-snug text-slate-200">{u.buyer || "—"}</p>
        </div>

        <div className="min-w-0">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            what they sell it as{" "}
            {u.products.length > 0 && <span className="tnum">{u.products.length}</span>}
          </div>
          {u.products.length ? (
            <ul className="max-h-44 space-y-2 overflow-y-auto pr-1">
              {u.products.map((p, i) => (
                <li key={`${p.name}-${i}`} className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-200">{p.name}</div>
                  {/* The product's job, stripped of the company's own naming.
                      This — not the product name — is what the catalog is
                      written from. */}
                  <div className="text-[12px] leading-snug text-slate-400">{p.sells}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">
              No product could be read off their own pages — an absence, not an omission.
            </p>
          )}
        </div>
      </div>

      {u.coinages.length > 0 && (
        <div className="mt-5 border-t border-slate-800 pt-3">
          {/* THE RULE THAT MAKES THE SWEEP WORK. A query containing one of these
              can only reach pages someone already wrote about this company, so
              the catalog is forbidden from using them — and showing the reader
              which words were struck is showing them why the map is not a list
              of things Google already associates with the anchor. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
              their own coinages — never searched
            </span>
            {u.coinages.slice(0, 14).map((c) => (
              <span
                key={c}
                className="rounded border border-slate-700 bg-slate-800/50 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 line-through"
              >
                {c}
              </span>
            ))}
            {u.coinages.length > 14 && (
              <span className="text-[10px] text-slate-500">+{u.coinages.length - 14}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- the plan --

/** Queries shown per group before the reader asks for the rest. Rendering all
 *  of a wide catalog by default buries every other panel. */
const PREVIEW = 6;

function QueryGroup({
  source,
  queries,
  offset,
}: {
  source: Intent;
  queries: { q: string; rationale: string; concept?: string }[];
  offset: number;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? queries : queries.slice(0, PREVIEW);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
          {INTENT_LABEL[source]}
        </span>
        <span className="tnum text-[11px] text-sky-400/80">{queries.length}</span>
      </div>
      <p className="mb-2 mt-0.5 text-[11px] leading-snug text-slate-500">{INTENT_BLURB[source]}</p>
      <ol className="space-y-1.5">
        {shown.map((q, i) => (
          <li key={`${q.q}-${i}`} className="flex min-w-0 gap-2">
            <span className="tnum shrink-0 font-mono text-[11px] leading-5 text-slate-600">
              {String(offset + i + 1).padStart(3, "0")}
            </span>
            <div className="min-w-0">
              <div className="break-words font-mono text-xs text-slate-200">{q.q}</div>
              <div className="flex flex-wrap items-baseline gap-1.5">
                {q.concept && q.concept !== "web" && (
                  <span className="font-mono text-[10px] text-slate-600">{q.concept}</span>
                )}
                {q.rationale ? (
                  <span className="text-[11px] leading-snug text-slate-500">{q.rationale}</span>
                ) : (
                  <span className="text-[11px] italic leading-snug text-slate-600">
                    no reason travelled with this query
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {queries.length > PREVIEW && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-sky-400/80 hover:text-sky-300"
        >
          {open ? "show fewer" : `show all ${queries.length}`}
        </button>
      )}
    </div>
  );
}

export function PlanCard({ plan }: { plan: PlanView }) {
  const groups = groupPlan(plan.queries);
  // Running start index per group, so the numbering reads 001…N across the whole
  // plan rather than restarting inside every group. Precomputed rather than
  // accumulated during render, a variable mutated inside .map() is exactly the
  // pattern the React compiler refuses.
  const offsets = groups.reduce<number[]>(
    (acc, g, i) => [...acc, (acc[i] ?? 0) + g.queries.length],
    [0],
  );
  /* THE CHIP THAT COULD ONLY EVER SAY YES.
     This used to re-test the delivered queries for the anchor's name and report
     "no query names the company" — a green pass on a test that cannot fail. The
     engine splices leaking queries OUT before the frame is emitted, and it
     splices on the anchor label AND every coinage (sweep.ts), so this check was
     both a tautology and strictly weaker than the one that already ran.

     The `planned` frame has carried the real numbers all along: `requested` is
     what the depth asked for, `written` is what the catalog produced. The gap
     between `written` and what arrived is the filter's actual yield, and unlike
     the old chip it is a number that can come back bad. */
  const delivered = plan.queries.length || plan.count;
  const dropped =
    plan.written !== undefined && plan.written > delivered ? plan.written - delivered : 0;

  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/[0.04] p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-sky-300">
          plan
        </span>
        <span className="text-sm text-slate-400">
          every query, and the reason it is worth buying
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Field label="Anchor" value={plan.domain} mono />
        <Field label="Queries" value={String(plan.count)} />
        <Field label="Intents" value={String(groups.length)} />
        <Field label="Estimated search" value={formatUsd(plan.estimatedUsd)} />
      </div>

      {/* The catalog is written before any company name is known, so a query
          that names the anchor is a LEAK, not a feature — it bounds the sweep to
          pages someone already wrote about them. Counted here rather than
          silently dropped, because the number is the measure of the prompt. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {plan.requested !== undefined && (
          <Chip tone="slate">
            asked for {plan.requested}
          </Chip>
        )}
        {plan.written !== undefined && (
          <Chip tone="slate">catalog wrote {plan.written}</Chip>
        )}
        {dropped > 0 ? (
          <Chip tone="amber">
            {dropped} dropped before buying — named the company or its coinages
          </Chip>
        ) : (
          <Chip tone="emerald">every written query survived the name filter</Chip>
        )}
      </div>

      {plan.queries.length === 0 ? (
        <p className="mt-4 text-xs text-slate-500">
          {plan.count > 0
            ? `${plan.count} queries planned. This run reported only the count — the per-query reasons were not carried on the stream.`
            : "No queries planned."}
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {groups.map((g, i) => (
            <QueryGroup key={g.source} source={g.source} queries={g.queries} offset={offsets[i] ?? 0} />
          ))}
        </div>
      )}
    </div>
  );
}

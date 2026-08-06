import { registrableHost } from "@open-kb/core"
import type { EntityEdgeRow, EntityRow } from "./map.js"
import type { SwarmRun } from "./orchestrator.js"

/**
 * A finished swarm run, written in the SAME run-JSON shape the sweep writes —
 * entities/edges/stats/report — so `packages/web/lib/kb-from-run.ts` and the
 * whole frontend render it with zero web changes. The swarm's own record (the
 * ending, the residue, the lead's finish, the landings) rides inside `report`,
 * where the reader treats unknown keys as data rather than schema.
 */

/**
 * THE RECORDED SEAM: the web reader's KIND_GROUP knows company / product /
 * community / publisher / directory / unknown — it has NO capability or buyer
 * entry, so an unfolded capability or buyer row would fall out of the render
 * as noise. Folded at serialization time only (the map itself keeps the
 * skill's vocabulary):
 *
 *   capability -> product    the anchor's product side is where a capability
 *                            hangs on today's canvas
 *   buyer      -> community  the audience group is the nearest colour a buyer
 *                            has
 *
 * Morning decides the real vocabulary; this mapping is the seam to revisit.
 */
const KIND_FOLD: Record<string, string> = {
  capability: "product",
  buyer: "community",
}

export interface SerializedSwarmRun {
  anchor: string
  /** The sweep's decomposition slot, shape-compatible and honestly empty: a
   *  swarm run's orientation lives on the map as nodes, not in a pre-pass. */
  decomposition: {
    sells: string
    buyer: string
    brand: string
    products: unknown[]
    capabilities: unknown[]
    coinages: string[]
  }
  queries: unknown[]
  entities: EntityRow[]
  edges: EntityEdgeRow[]
  stats: {
    queries: number
    results: number
    hosts: number
    kept: number
    tokIn: number
    tokOut: number
    tokReasoning: number
    serpCalls: number
    unlockerCalls: number
    usd: number
    seconds: number
  }
  report: Record<string, unknown>
}

const tally = (xs: string[]): Record<string, number> =>
  xs.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})

export function serializeSwarmRun(
  run: SwarmRun,
  opts: { aggregatorThreshold?: number | null } = {},
): SerializedSwarmRun {
  const entities = run.map.entities().map((e) => ({ ...e, kind: KIND_FOLD[e.kind] ?? e.kind }))
  const edges = run.map.entityEdges()

  // Recall is computed ONCE, at the run's ending (orchestrator endRun), over
  // the same anchor-excluded probe pool the in-run scorecard read — so the
  // report's recall is the number the lead saw. `report.recall` stays at its
  // own key for web compat; the scorecard block references the same object.
  const recall = run.scorecard.recall

  // The gate record, whole. A run whose finishes never met a scorecard thunk
  // serializes the zero record rather than a hole.
  const gate = run.control.gate ?? { refusals: 0, objections: [], carried: [], refusedFinish: null }

  // The reader-facing finish cannot claim ignorance: the lead's strings ship
  // byte-identical and FIRST, then every still-standing objection the lead
  // omitted, each prefixed so the instrument's words and the lead's stay
  // distinguishable. `run.finish` itself keeps the raw array untouched.
  const finish =
    run.finish === null
      ? null
      : { ...run.finish, unresolved: [...run.finish.unresolved, ...gate.carried.map((c) => `[scorecard] ${c}`)] }

  const hosts = new Set<string>()
  for (const url of run.seen) {
    try {
      hosts.add(registrableHost(new URL(url).hostname))
    } catch {
      /* a canonical entry that is not a URL counts nothing */
    }
  }

  const usd = run.ledger.spentUsd()
  const downgraded = entities.filter((e) => e.because).length

  return {
    anchor: run.map.anchor,
    decomposition: { sells: "", buyer: "", brand: "", products: [], capabilities: [], coinages: [] },
    queries: [],
    entities,
    edges,
    stats: {
      queries: run.searches.length,
      results: run.searches.reduce((n, s) => n + s.urls.length, 0),
      hosts: hosts.size,
      kept: entities.length,
      tokIn: run.tally.tokIn,
      tokOut: run.tally.tokOut,
      tokReasoning: 0,
      serpCalls: run.tally.serpCalls,
      unlockerCalls: run.tally.unlockerCalls,
      usd,
      seconds: run.seconds,
    },
    report: {
      domain: run.map.anchor,
      usd,
      seconds: run.seconds,
      entities: entities.length,
      kept: entities.length,
      kinds: tally(entities.map((e) => e.kind)),
      relations: tally(entities.map((e) => e.relation)),
      // Kernel-style accounting: what the write gate did, computed from the
      // map rather than asserted by anyone.
      kernel: {
        downgraded,
        retractions: run.map.retractions.length,
        tiers: tally(run.map.entities().map((e) => e.tier)),
        aggregatorThreshold: opts.aggregatorThreshold ?? null,
      },
      recall,
      residue: run.ending.residue,
      ending: run.ending,
      finish,
      // Amendment 2: a refused finish never evaporates. On ANY ending that is
      // not the lead's own finish, the conclusion the run would have shipped
      // survives at its own key, where a reader of the ending will find it.
      ...(run.finish === null && gate.refusedFinish !== null ? { refusedFinish: gate.refusedFinish } : {}),
      // Kernel-style harvest accounting, beside the scorecard: what the judge
      // did across every harvest call — fetched, settled-free vs model-judged,
      // the unreadable split by reason code. Zeros when nothing harvested; a
      // clean run and a missing block must not look alike in a stored report.
      harvest: run.harvest,
      // T6: the full instrument reading at the ending — every fraction with
      // its num/den beside the value (auditable like recall's probe list),
      // the gate's record, and the thresholds the gate ran with.
      scorecard: {
        ...run.scorecard,
        gate: {
          refusals: gate.refusals,
          objections: gate.objections,
          carriedObjections: gate.carried,
          refusedFinish: gate.refusedFinish,
        },
        config: run.scorecardConfig,
      },
      missions: run.landings.map((l) => ({
        dedupeKey: l.mission.dedupeKey,
        lens: l.mission.lens,
        tier: l.mission.tier,
        status: l.digest.status,
        added: l.digest.added,
        usd: l.actualUsd,
        atSec: l.atSec,
      })),
      searches: run.searches,
      cost: {
        usd,
        elapsedMs: Math.round(run.seconds * 1000),
        tokens: run.tally.tokIn + run.tally.tokOut,
        ceilingUsd: run.ledger.ceilingUsd,
        calls: run.tally.modelCalls + run.tally.serpCalls + run.tally.fetchCalls,
      },
    },
  }
}

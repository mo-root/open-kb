import type { NoteRef } from "./viewTypes"

/**
 * The entities list's organization logic, pure and DOM-free.
 *
 * NotesTab and ProductsTab both need the same three answers about a pile of
 * NoteRefs — which relations are in it and how many of each, which rows match
 * what the reader typed or clicked, and what order tells the truth best — and
 * an 844-row sidebar is exactly the place where that logic drifting between
 * surfaces would go unnoticed. So it lives here, tested, and the components
 * only render it.
 *
 * Client-safe on purpose (no lib/runs.ts import), same constraint that put
 * RELATION_BLURB in lib/viewTypes.ts and the Coverage card's arithmetic in
 * lib/scorecard-view.ts.
 */

/* ---------------------------------------------------------------- ordering */

/** The provenance ladder as a sort rank: strongest evidence first. A tier this
 *  reader has never heard of still ranks above "no tier at all" — the run
 *  asserted SOMETHING — and a run recorded before tiers existed (every sweep
 *  run) ranks every row the same, so this is a no-op there by construction. */
const TIER_RANK: Record<string, number> = {
  "own-page": 0,
  page: 1,
  snippet: 2,
}

export function tierRank(tier: string | undefined): number {
  if (typeof tier !== "string" || !tier.trim()) return 4
  return TIER_RANK[tier.toLowerCase().trim()] ?? 3
}

/**
 * The reading order for a group of entities: placement first (competitors
 * before substitutes before the channel — the weight derives from the
 * relation), evidence tier inside equal placement (a competitor judged from
 * its own page above one seen only in a snippet), title as the stable tie.
 *
 * Returns a sorted copy; the input is never reordered in place, because the
 * caller's array is React state.
 */
export function orderNotes(notes: readonly NoteRef[]): NoteRef[] {
  return [...notes].sort(
    (a, b) =>
      b.relevance - a.relevance ||
      tierRank(a.tier) - tierRank(b.tier) ||
      a.title.localeCompare(b.title),
  )
}

/* ------------------------------------------------------------------ facets */

export interface RelationFacet {
  relation: string
  count: number
}

/**
 * Every relation present in the list, counted, strongest placement first.
 *
 * The order comes off the rows' own `relevance` rather than a second copy of
 * kb-from-run's RELATION_WEIGHT: the weight already derives from the relation,
 * so the max relevance seen under a relation IS its weight, and one source of
 * truth cannot disagree with itself. Ties (unheard-of relations all landing on
 * the floor weight) break by count, then name, so the row is stable.
 */
export function relationFacets(notes: readonly NoteRef[]): RelationFacet[] {
  const counts = new Map<string, { count: number; weight: number }>()
  for (const n of notes) {
    const prev = counts.get(n.relation)
    if (prev) {
      prev.count += 1
      prev.weight = Math.max(prev.weight, n.relevance)
    } else {
      counts.set(n.relation, { count: 1, weight: n.relevance })
    }
  }
  return [...counts.entries()]
    .map(([relation, v]) => ({ relation, count: v.count, weight: v.weight }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count || a.relation.localeCompare(b.relation))
    .map(({ relation, count }) => ({ relation, count }))
}

/* --------------------------------------------------------------- filtering */

/** The text a typed filter matches against: name, domain, relation — and the
 *  names a swarm merge folded into this node, so a product absorbed by its
 *  host company is still findable by the name it lost. */
export function noteHaystack(n: NoteRef): string {
  const absorbed = (n.also ?? [])
    .map((a) => a.name ?? "")
    .filter(Boolean)
    .join(" ")
  return `${n.title} ${n.domain} ${n.relation} ${absorbed}`.toLowerCase()
}

/**
 * The two filters a reader has, combined: the typed query (substring over the
 * haystack) and the clicked relation facet (exact). Either may be empty; both
 * empty returns the input list unchanged.
 */
export function filterNotes(
  notes: readonly NoteRef[],
  by: { query?: string; relation?: string | null },
): NoteRef[] {
  const q = (by.query ?? "").trim().toLowerCase()
  const rel = by.relation ?? null
  if (!q && rel === null) return [...notes]
  return notes.filter((n) => (rel === null || n.relation === rel) && (!q || noteHaystack(n).includes(q)))
}

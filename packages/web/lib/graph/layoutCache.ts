/**
 * The settled layout, remembered.
 *
 * The single largest cost in opening a map is not fetching it — it is the
 * force simulation re-deriving, tick by animated tick, the same equilibrium it
 * reached the last time the same reader opened the same map. The recipe is
 * deterministic on purpose (seeded starts, hashed angles), so the settle is
 * pure re-computation: nothing about it depends on the visit.
 *
 * So the canvas stores where every node ended up, and the next mount starts
 * there. Starting AT the answer, the engine still runs — collide and the lobe
 * forces get a short budget to absorb any drift — but the map is readable in
 * the first second instead of organising itself for seven.
 *
 * WHAT INVALIDATES IT, all folded into the key:
 *   · the map (`slug`),
 *   · the node count — a re-exported map with different membership must not
 *     inherit positions wholesale,
 *   · whether the unplaced are on the map, because hiding them re-clusters it,
 *   · `VERSION`, bumped by hand when the recipe in layout.ts changes shape.
 * A cache row that survives all four gates and still misses nodes (a rename,
 * say) is applied only if it covers nearly everyone — a map seeded 60% from
 * memory and 40% from the ring would tear itself apart on the first tick.
 *
 * Failure is always silence: no localStorage, a full quota, a corrupt row —
 * every path degrades to "lay it out the long way", which is what the graph
 * did for its whole life before this file existed.
 */

const PREFIX = "okb:layout:"
const VERSION = 1

/** Applied only when memory covers at least this share of the map's nodes. */
export const MIN_COVERAGE = 0.9

export function layoutKey(slug: string, nodeCount: number, showUnplaced: boolean): string {
  return `${PREFIX}v${VERSION}:${slug}:${nodeCount}:${showUnplaced ? "u1" : "u0"}`
}

interface StoredLayout {
  /** id -> [x, y], rounded to a tenth of a graph unit. */
  n: Record<string, [number, number]>
}

export function loadLayout(key: string): Map<string, { x: number; y: number }> | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredLayout
    if (!parsed || typeof parsed.n !== "object" || parsed.n === null) return null
    const out = new Map<string, { x: number; y: number }>()
    for (const [id, p] of Object.entries(parsed.n)) {
      if (!Array.isArray(p) || p.length !== 2) return null
      const x = Number(p[0])
      const y = Number(p[1])
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      out.set(id, { x, y })
    }
    return out.size > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * Write a BAKED layout (fetched from /layouts/<slug>.json) into the same row
 * the cache reads, so the next mount — and every one after — opens on it
 * without the fetch. The shape is validated by `loadLayout` on the way back
 * out; this only has to store it.
 */
export function importLayout(key: string, n: Record<string, [number, number]>): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, JSON.stringify({ n }))
  } catch {
    // Full or unavailable — the fetched seed still applied this session.
  }
}

export function saveLayout(
  key: string,
  nodes: ReadonlyArray<{ id: string; x?: number; y?: number }>,
): void {
  if (typeof window === "undefined") return
  const n: Record<string, [number, number]> = {}
  for (const node of nodes) {
    if (typeof node.x !== "number" || typeof node.y !== "number") continue
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue
    n[node.id] = [Math.round(node.x * 10) / 10, Math.round(node.y * 10) / 10]
  }
  if (Object.keys(n).length === 0) return
  const row = JSON.stringify({ n } satisfies StoredLayout)
  try {
    window.localStorage.setItem(key, row)
  } catch {
    /* Quota, most likely. Other maps' layouts are the cheapest thing to give
       up — each one is a convenience this same code will happily rebuild. */
    try {
      const doomed: string[] = []
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i)
        if (k && k.startsWith(PREFIX) && k !== key) doomed.push(k)
      }
      for (const k of doomed) window.localStorage.removeItem(k)
      window.localStorage.setItem(key, row)
    } catch {
      // Storage is simply unavailable. The settle stays the slow path.
    }
  }
}

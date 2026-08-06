import { banned, openingHand, type Mission } from "@open-kb/core"
import type { MapState } from "./map.js"

/**
 * The family floor — the approved design amendment "families survive as a code
 * floor", built for the swarm.
 *
 * The sweep's 844-entity breadth comes precisely from code-guaranteed query
 * families (core/families.ts): the boring questions fire deterministically,
 * whatever a model chooses on a clever day. The swarm seeds exactly one
 * mission — the orient dig — and everything after it depended on the lead
 * choosing to spawn; run 3's board went dry and the run produced 12 nodes with
 * 3 of 6 lanes ever used. This module restores the floor property: when the
 * seed landing arrives, the orchestrator templates 3-5 lead-band missions from
 * the family shapes and pushes them through the normal spawn economics. They
 * are ordinary board items in the lead's band — the lead can re-rank or kill
 * them — the floor guarantees they EXIST, not that they run.
 *
 * Everything here is mechanical: no model call anywhere. The profile is read
 * off whatever text the orient landing reliably left on the map, and the
 * questions are string templates over it. That makes them COARSE BY DESIGN —
 * "who sells <category>" written by code will never match a bespoke mission
 * the lead writes with the whole map in view. The lead refines; the floor
 * only guarantees the market's boring questions get asked at all.
 */

// ── the profile ──────────────────────────────────────────────────────────────

export interface FamilyProfile {
  /** The de-branded category phrase every template hangs on, cleaned and lowercased. */
  category: string
  /** Which node kind supplied it — the reader's hint about how good it can be. */
  source: "capability" | "product" | "company"
  /** The demand side's name, when orientation recorded a buyer node. */
  buyer?: string
}

/** Longest category the templates will carry; longer texts cut at a word boundary. */
const CATEGORY_MAX = 60

/**
 * Mechanical cleanup of a candidate phrase: whitespace collapsed, terminal
 * punctuation dropped, cut at the last word boundary under CATEGORY_MAX with
 * dangling connectives stripped, lowercased for query duty. Truncating a
 * model's long `what` mid-sentence produces a blunt phrase, not a polished
 * one — accepted: the floor is coarse by design and a blunt category is still
 * a searchable one.
 */
function cleanCategory(raw: string): string {
  let t = raw.trim().replace(/\s+/g, " ").replace(/[.!?。]+$/, "")
  if (t.length > CATEGORY_MAX) {
    const cut = t.lastIndexOf(" ", CATEGORY_MAX)
    t = cut > 20 ? t.slice(0, cut) : t.slice(0, CATEGORY_MAX)
    t = t.replace(/[,;:\s]+$/, "").replace(/\s+(?:and|or|with|for|to|of|the|a|an|in|on|by)$/i, "")
  }
  return t.toLowerCase()
}

/**
 * Read the profile off the map at the moment the seed lands.
 *
 * Only nodes stamped by the given writers count — the seed mission's own
 * remembers and the lead's — because the floor de-brands from the ORIENT
 * answer, and because reading other lanes' concurrent writes would make the
 * floor's contents a race. The ladder, honest about what a landing reliably
 * leaves (the anchor company itself is refused by the mint, so there is no
 * anchor node to read):
 *
 *   1. a capability node — the de-branded job in the market's own words
 *   2. a product node's `what` — what the thing sold does
 *   3. a company node's `what` — a rival's description names the same market
 *
 * Every candidate is cleaned first and dropped if it names the anchor or a
 * coinage (core's `banned`, the same check the sweep runs on queries) — a
 * rival's `what` that says "competes with <anchor>" must not become a query.
 * Nothing usable means null: the caller narrates the empty floor rather than
 * templating garbage.
 */
export function familyProfileFrom(
  map: MapState,
  opts: { writers: string[]; coinages: string[] },
): FamilyProfile | null {
  const writers = new Set(opts.writers)
  const live = [...map.nodes.values()].filter(
    (n) => !n.retracted && n.contributions.some((c) => writers.has(c.writer)),
  )

  const candidates: Array<{ text: string; source: FamilyProfile["source"] }> = []
  for (const n of live) {
    if (n.kind !== "capability") continue
    candidates.push({ text: n.name, source: "capability" }, { text: n.what, source: "capability" })
  }
  for (const n of live) if (n.kind === "product") candidates.push({ text: n.what, source: "product" })
  for (const n of live) if (n.kind === "company") candidates.push({ text: n.what, source: "company" })

  const usable = (text: string): string | null => {
    const c = cleanCategory(text)
    return c.length >= 3 && !banned(c, "plain", map.anchor, opts.coinages) ? c : null
  }

  for (const cand of candidates) {
    const category = usable(cand.text)
    if (category === null) continue
    const buyerNode = live.find((n) => n.kind === "buyer")
    const buyer = buyerNode ? usable(buyerNode.name) : null
    return { category, source: cand.source, ...(buyer ? { buyer } : {}) }
  }
  return null
}

// ── the missions ─────────────────────────────────────────────────────────────

/** How many family missions the floor seeds when the caller does not say. */
export const DEFAULT_FAMILY_FLOOR = 4

/** The template deck's size; a larger requested count clamps here. */
export const FAMILY_FLOOR_MAX = 5

/**
 * Template the floor's missions from the profile, highest priority first.
 *
 * The query shapes are core/families.ts's own — `openingHand` deals them, so
 * the vocabulary that bought the sweep its breadth ("best X", "X alternatives",
 * "X vs", "top X companies", "open source X") is reused verbatim rather than
 * re-invented here. Dedupe keys are `family:<slug>` and deliberately do NOT
 * embed the category: the slug names the QUESTION, so the floor stays
 * one-copy-per-run whatever text the profile happened to yield.
 *
 * Band 61-70, read tier: below every mission the lead ranks urgent (71-100),
 * above every unreviewed proposal — the lead's bespoke plan outranks the
 * floor, and the floor outranks the unranked.
 */
export function seedFamilyMissions(profile: FamilyProfile, opts?: { count?: number }): Mission[] {
  const count = Math.max(0, Math.min(FAMILY_FLOOR_MAX, Math.floor(opts?.count ?? DEFAULT_FAMILY_FLOOR)))
  const c = profile.category

  // Core's own hand for this category; branded is skipped — the floor never
  // names the anchor, and the category is not a brand.
  const { open, reserve } = openingHand(c, [c], { branded: false })
  const q = (find: (x: { q: string }) => boolean, fallback: string): string =>
    [...open, ...reserve].find(find)?.q ?? fallback
  const bare = q((x) => x.q === c, c)
  const alternatives = q((x) => x.q.endsWith(" alternatives"), `${c} alternatives`)
  const best = q((x) => x.q.startsWith("best "), `best ${c}`)
  const vs = q((x) => x.q.endsWith(" vs"), `${c} vs`)
  const top = q((x) => x.q.startsWith("top "), `top ${c} companies`)
  const openSource = q((x) => x.q.startsWith("open source "), `open source ${c}`)

  const floorWhy = (family: string) => `the code floor's ${family} — it exists whatever the lead chooses to spawn`

  const deck: Mission[] = [
    {
      lens: "market",
      brief:
        `Search the market's own words — "${bare}", "${best}", "${top}" — and record who competes ` +
        `head-to-head, each vendor proven from its own pages.`,
      why: floorWhy("bare-term family: the single highest-yield query a market has"),
      priority: 70,
      tier: "read",
      dedupeKey: "family:market",
    },
    {
      lens: "competitors",
      brief:
        `Search the comparison field as buyers phrase it — "${alternatives}", "${vs}" — and record ` +
        `who reviewers weigh against whom, vendors unnamed until the pages name them.`,
      why: floorWhy("comparison family: how switchers phrase the shortlist"),
      priority: 68,
      tier: "read",
      dedupeKey: "family:competitors",
    },
    {
      lens: "substitutes",
      brief:
        `Find what replaces ${c} entirely — "${openSource}", the DIY route, the adjacent approach — ` +
        `and record substitutes: what a buyer uses instead, and who outgrows it.`,
      why: floorWhy("substitute family: what makes the anchor unnecessary"),
      priority: 66,
      tier: "read",
      dedupeKey: "family:substitutes",
    },
    {
      lens: "buyers",
      brief:
        `Find who buys ${c} and where they argue — the forums, communities and channels the demand ` +
        `side lives in${profile.buyer ? ` (orientation named "${profile.buyer}")` : ""} — and record them by name.`,
      why: floorWhy("demand-side family: the map is the ecosystem, not the shortlist"),
      priority: 64,
      tier: "read",
      dedupeKey: "family:buyers",
    },
    {
      lens: "stack",
      brief:
        `Find what appears alongside ${c} in a working stack — integrations, dependencies, the tools ` +
        `bought together — and record the adjacent layer.`,
      why: floorWhy("adjacency family: what a working setup buys together"),
      priority: 62,
      tier: "read",
      dedupeKey: "family:stack",
    },
  ]

  return deck.slice(0, count)
}

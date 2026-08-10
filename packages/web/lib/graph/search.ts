import type { NodeType } from "../nodeTypes"

/* Ranking a search over the map's nodes.
   Pure and rendererless on purpose: this is the part with rules in it, so it
   lives where it can be tested without mounting a canvas or a React tree. */

export interface SearchItem {
  id: string;
  title: string;
  domain?: string;
  type: NodeType;
  deg: number;
}

/** Ranked matches, best first. */
export function rankMatches(
  items: readonly SearchItem[],
  query: string,
  limit = 8,
): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    const domain = (item.domain ?? "").toLowerCase();
    // Lower is better. The bands are wide apart so a weak hit in a short title
    // can never outrank a prefix hit in a long one.
    let score = Infinity;
    if (title.startsWith(q)) score = 0;
    else if (domain.startsWith(q)) score = 1;
    else if (title.includes(q)) score = 10 + title.indexOf(q);
    else if (domain.includes(q)) score = 20 + domain.indexOf(q);
    if (score === Infinity) continue;
    // Degree breaks ties: on a tie between two equally-named nodes the one
    // wired into more of the map is the one someone is more likely to mean.
    scored.push({ item, score: score - Math.min(item.deg, 40) / 100 });
  }
  scored.sort((a, b) => a.score - b.score || a.item.title.localeCompare(b.item.title));
  return scored.slice(0, limit).map((s) => s.item);
}


import { escapeRe } from "./coverage.js"

/**
 * Small on purpose. This is not a linguist's stopword list — it is the
 * function words plus the light verbs a one-line company description leans on
 * ("offers", "provides", "sells"). What survives the strip is noun-ish by
 * exclusion, which is as much part-of-speech tagging as a $0 meter earns.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
  "for", "from", "had", "has", "have", "how", "if", "in", "into", "is", "it",
  "its", "like", "may", "more", "most", "no", "not", "of", "on", "or", "our",
  "out", "over", "per", "so", "such", "than", "that", "the", "their", "then",
  "these", "they", "this", "those", "to", "up", "us", "use", "used", "using",
  "via", "was", "we", "were", "what", "which", "who", "will", "with", "would",
  "you", "your", "also",
  // the light verbs descriptions are written with
  "offers", "provides", "sells", "helps", "makes", "gives", "lets",
])

export interface Grounding {
  /** Fraction of the description's content terms found in the page text. */
  score: number
  /** The terms the page never said, longest first, capped at 8. */
  ungrounded: string[]
}

/** The words of a text, lowercased. Hyphens and apostrophes stay inside a
 *  token ("anti-bot" is one claim), everything else splits. */
function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? []
}

/** Does the term appear in the haystack as words of its own? Same boundary
 *  discipline as namesHost in coverage.ts: substring matching over-collects
 *  ("api" sits inside "rapid"), so a match must be walled by non-alphanumerics
 *  or the text's edge. A multi-word term crosses any run of non-alphanumerics
 *  — "dataset\n delivery" grounds "dataset delivery", "dataset-based
 *  delivery" does not. */
function appears(hay: string, term: string): boolean {
  const body = term.split(" ").map(escapeRe).join("[^a-z0-9]+")
  return new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`).test(hay)
}

/**
 * How much of a description the page it was written from actually says.
 *
 * The kernel's live audit found its residual error class is embellished
 * descriptions inside correctly-placed entities: a real competitor whose
 * `what` invented "custom dataset delivery" its site nowhere offers. The page
 * text is already in hand when the description is written, so groundedness is
 * measurable for $0: extract the description's content terms (1-grams that
 * survive the stopword strip, plus every 2-gram of consecutive content
 * words), test each against the page with word boundaries, and report the
 * fraction found. The missing terms ride along, longest first, capped at 8,
 * because a number without the terms behind it cannot be argued with.
 *
 * Degenerate inputs, decided rather than left to arithmetic: a description
 * with no content terms claims nothing, so nothing can be ungrounded and the
 * score is 1. A blank page under a non-empty description grounds none of it,
 * so the score is 0 — but the ungrounded list stays empty, because no term
 * was individually refuted; the page refused wholesale, and naming terms
 * would dress that up as term-level findings. In the sweep this branch never
 * fires: the kernel already settles unreadable pages as unknown before any
 * description exists to measure.
 *
 * MEASUREMENT ONLY. Nothing gates on this score — the aggregator rule's
 * lesson stands: measure first, never guess a threshold.
 */
export function descriptionGrounding(desc: string, pageText: string): Grounding {
  // null marks a stopword so 2-grams cannot form across one: "api for
  // developers" claims "api" and "developers", never "api developers".
  const content = tokens(desc).map((t) => (STOPWORDS.has(t) || t.length < 2 ? null : t))
  const terms = new Set<string>()
  for (let i = 0; i < content.length; i++) {
    const a = content[i]
    if (!a) continue
    terms.add(a)
    const b = content[i + 1]
    if (b) terms.add(`${a} ${b}`)
  }
  if (terms.size === 0) return { score: 1, ungrounded: [] }
  if (!pageText.trim()) return { score: 0, ungrounded: [] }

  const hay = pageText.toLowerCase()
  const missing: string[] = []
  let found = 0
  for (const t of terms) {
    if (appears(hay, t)) found += 1
    else missing.push(t)
  }
  missing.sort((a, b) => b.length - a.length || a.localeCompare(b))
  return { score: found / terms.size, ungrounded: missing.slice(0, 8) }
}

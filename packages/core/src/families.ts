/**
 * The three query families, and the templates that guarantee two of them.
 *
 * A catalog prompt instructed on five clever shapes still skipped the single
 * highest-yield query a market has: the bare category term. One manual search
 * of "web scraper" returned the head-to-head field that forty model-written
 * queries missed. So the boring families are code: deterministic, free, and
 * immune to a model having a clever day. Only the debranded family — where
 * judgement actually pays — is written by a model.
 */
export type QueryFamily = "plain" | "debranded" | "branded"

export interface FamilyQuery {
  q: string
  family: QueryFamily
  /** The product this query hunts alternatives for. */
  product: string
  /** The stripped term it expanded from; "" for branded. */
  term: string
  /** One line: what this shape buys that the others do not. */
  why: string
}

/**
 * Deal one product's hand: a small opening across the families, and a reserve
 * of the remaining templates for the widening loop to draw from. The opening
 * is an opening, not a cap — a run widens on yield, and nothing here seals it.
 */
export function openingHand(
  product: string,
  terms: string[],
  opts?: { branded?: boolean },
): { open: FamilyQuery[]; reserve: FamilyQuery[] } {
  const [t0, ...rest] = terms.map((t) => t.trim()).filter(Boolean)
  const p = product.trim()

  const open: FamilyQuery[] = []
  const reserve: FamilyQuery[] = []

  if (t0) {
    open.push(
      plain(p, t0, t0, "the bare term — the center of the market, who competes head-to-head"),
      plain(p, `${t0} alternatives`, t0, "the comparison field, as buyers phrase it"),
    )
    reserve.push(
      plain(p, `best ${t0}`, t0, "ranked lists and roundups"),
      plain(p, `${t0} vs`, t0, "head-to-head comparison pages, vendors unnamed"),
      plain(p, `top ${t0} companies`, t0, "the vendor field by name"),
      plain(p, `open source ${t0}`, t0, "the DIY route and who outgrows it"),
    )
    for (const t of rest) reserve.push(plain(p, t, t, "the next strip term — a different door into the same market"))
  }

  // A generic-named product skips branded (owner decision, 2026-08-04):
  // `Datasets alternatives` buys noise about the concept, not the product. The
  // company-level hand covers the comparison ecosystem those products lose.
  if (opts?.branded !== false) {
    open.push(branded(p, `${p} alternatives`, "the ecosystem that forms around the name: migration threads, comparison posts"))
    reserve.push(branded(p, `${p} vs`, "who reviewers weigh this product against"))
  }

  return dedupe(open, reserve)
}

/** The company-level branded set, fired once per run. The densest comparison
 *  pages a map has — and the queries the anchor-naming filter must exempt,
 *  because naming the anchor is their entire point. */
export function companyHand(company: string): FamilyQuery[] {
  const c = company.trim()
  return [
    branded("", `${c} alternatives`, "whole-company rivals, as switchers search them"),
    branded("", `${c} vs`, "the head-to-head pages reviewers write about the company"),
    branded("", `${c} competitors`, "the analyst and roundup view of the company's field"),
  ].map((q) => ({ ...q, product: "" }))
}

const plain = (product: string, q: string, term: string, why: string): FamilyQuery => ({
  q, family: "plain", product, term, why,
})
const branded = (product: string, q: string, why: string): FamilyQuery => ({
  q, family: "branded", product, term: "", why,
})

/** A product named exactly its category term makes branded and plain collide;
 *  the first spelling wins and the duplicate is never bought. */
function dedupe(open: FamilyQuery[], reserve: FamilyQuery[]): { open: FamilyQuery[]; reserve: FamilyQuery[] } {
  const seen = new Set<string>()
  const take = (qs: FamilyQuery[]) =>
    qs.filter((x) => {
      const k = x.q.trim().toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  return { open: take(open), reserve: take(reserve) }
}

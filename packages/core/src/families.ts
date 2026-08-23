/**
 * The four query families, and the templates that guarantee three of them.
 *
 * A catalog prompt instructed on five clever shapes still skipped the single
 * highest-yield query a market has: the bare category term. One manual search
 * of "web scraper" returned the head-to-head field that forty model-written
 * queries missed. So the boring families are code: deterministic, free, and
 * immune to a model having a clever day. Only the debranded family — where
 * judgement actually pays — is written by a model.
 *
 * `plain` and `branded` are templates over a product; `rival` is a template
 * over a name the anchor published about someone else (`rivalHand`, and
 * `rivalsFromSitemap` in catalog.ts for where the names come from).
 */
export type QueryFamily = "plain" | "debranded" | "branded" | "rival"

export interface FamilyQuery {
  q: string
  family: QueryFamily
  /** The product this query hunts alternatives for; "" for the company-level
   *  and rival-grounded hands, which are about no single product. */
  product: string
  /** The stripped term it expanded from; "" for branded, and the rival's name
   *  for the rival family, so a record says which name grounded the query. */
  term: string
  /** One line: what this shape buys that the others do not. */
  why: string
}

/**
 * Deal one product's hand: an opening across the families, and a reserve for
 * the widening loop to draw from. The opening is an opening, not a cap — a
 * run widens on yield, and nothing here seals it.
 *
 * What is in each has moved. Every STRIP TERM now opens, because a term left
 * in the reserve was a term nobody searched (47 of 1,455 plain queries across
 * `runs/` came from a draw). What stays in the reserve is the four roundup
 * SHAPES over the first term and `<product> vs` — templates, not doors, and
 * measured at one known rival per 96 clean queries against 18.4 for a bare
 * term.
 */
export function openingHand(
  product: string,
  terms: string[],
  opts?: { branded?: boolean; core?: boolean },
): { open: FamilyQuery[]; reserve: FamilyQuery[] } {
  const [t0, t1, ...rest] = terms.map((t) => t.trim()).filter(Boolean)
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
    // A CORE product's second door gets its COMPARISON FIELD as well, which
    // is the only thing left of a split that used to be about the door
    // itself: every bare term now opens with the hand (see below), so the
    // question here is no longer whether `t1` is searched but whether
    // `t1 alternatives` is bought beside it.
    //
    // MEASURED, and still the reason the second term is not left to chance:
    // cursor.com stripped to [AI coding agent | AI code editor | AI pair
    // programmer], the second term sat in reserve, no widening round drew
    // it, and the map of the company that makes an AI code editor never
    // fired "ai code editor" — windsurf, its head-on rival, ranked for
    // exactly that term and never surfaced.
    if (t1 && opts?.core) {
      open.push(
        plain(p, t1, t1, "the second strip term — the core market's other front door"),
        plain(p, `${t1} alternatives`, t1, "the comparison field behind that door"),
      )
    } else if (t1) {
      open.push(plain(p, t1, t1, "the next strip term — a different door into the same market"))
    }
    /**
     * THE REMAINING DOORS OPEN WITH THE HAND, at the back of it.
     *
     * These used to go to `reserve`, which a widening round draws from only
     * when `assess` asks — and it almost never asks: 47 of 1,455 plain
     * queries across `runs/` came from a reserve draw, and the fourth strip
     * term this file learned to write was searched on NONE of one run's fifty
     * products. A door in the reserve is a door nobody opens.
     *
     * They are worth opening. Measured over clean queries against a
     * hand-written field of known rivals, a bare strip term finds one every
     * 18.4 queries where `<term> alternatives` finds one every 6.2 — three
     * times the rate — and there is no decay between the first two slots
     * (18.7 and 17.6 per 100 on 257 and 216 queries). Two terms return the
     * same host only 11% of the time, so each is close to a whole extra
     * search rather than a rephrasing.
     *
     * `<term> alternatives` STAYS, and is not displaced by them, because it
     * feeds something these do not: 60% of the rows it returns are
     * roundup-shaped against 14% for a bare term, and roundup rows are what
     * the listicle harvest reads to name vendors no query surfaced.
     *
     * Placed last so the ordering is safe under a cut. The opening hand is
     * dealt round-robin across products (sweep.ts), so what a ceiling
     * truncates is the last PASS rather than the last products — every
     * product gets its first door before any product gets its fourth.
     */
    for (const t of rest) open.push(plain(p, t, t, "the next strip term — a different door into the same market"))
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
  ]
}

/**
 * The hand grounded in someone else's name.
 *
 * WHY THIS IS NOT A BREACH OF THE THESIS. The rule is that a non-branded query
 * never rides the ANCHOR's own name: it must find the market by describing the
 * job, not by looking the company up. Naming a rival is a different act. A
 * buyer comparing vendors types other people's brands constantly — measured on
 * the hand-written market corpus, 42.8% of its queries (211 of 493) name a
 * third-party proper noun, against 0.85% of open-kb's non-branded queries
 * (7 of 826). That ~50x gap is not the thesis working, it is a shape the
 * engine simply never had.
 *
 * TWO SHAPES, AND WHAT EACH BUYS:
 *
 *   `<rival> alternatives` — the shortlist page the anchor SITS ON rather than
 *   the one it wrote about itself. One such roundup names ten companies
 *   including the anchor, and it is the only shape that reaches a vendor
 *   nobody wrote an anchor-comparison about.
 *
 *   `<rivalA> vs <rivalB>` — two rivals, neither of them the anchor. The
 *   existing `<company> vs` template leaves the right-hand side empty and lets
 *   the search engine guess who to fill it with; naming both sides asks for a
 *   page that exists.
 *
 * The split is two thirds to `alternatives`, remainder to pairs. The
 * alternatives shape is the one with a measured reach; the pair shape is an
 * argument. A channel spends more on the evidence than on the argument.
 *
 * Pairs are drawn from consecutive names in the caller's order, which is
 * most-named-first, so no name is bought twice in this shape — a pair that
 * repeats a name buys a second look at the same shortlist.
 *
 * `budget` is a hard cap on the whole hand, and the caller derives it from
 * something real (see the sweep). Zero names or zero budget returns nothing,
 * which is the normal outcome for an anchor that publishes no comparison pages.
 */
export function rivalHand(rivals: readonly string[], budget: number): FamilyQuery[] {
  const names = rivals.map((r) => r.trim()).filter(Boolean)
  const cap = Math.max(0, Math.floor(budget))
  if (!names.length || !cap) return []

  const out: FamilyQuery[] = []
  const seen = new Set<string>()
  const push = (q: string, term: string, why: string) => {
    const k = q.trim().toLowerCase()
    if (out.length >= cap || seen.has(k)) return
    seen.add(k)
    out.push({ q, family: "rival", product: "", term, why })
  }

  for (const n of names.slice(0, Math.ceil((cap * 2) / 3)))
    push(`${n} alternatives`, n, "the shortlist a rival sits on — where this market names ten vendors at once")
  for (let i = 0; i + 1 < names.length; i += 2)
    push(
      `${names[i]} vs ${names[i + 1]}`,
      `${names[i]}, ${names[i + 1]}`,
      "two rivals head to head, neither of them the anchor",
    )
  return out
}

/**
 * Does this query accidentally name the anchor?
 *
 * Branded is exempt: naming the anchor is that family's entire point — its
 * queries are `{anchor} alternatives` / `{anchor} vs`, written by
 * `companyHand` and `openingHand`, never by the model. Everything else that
 * names the anchor's own name or one of its coinages got there by accident
 * and is bought for nothing.
 *
 * RIVAL IS NOT EXEMPT, and that is a decision rather than an oversight. Its
 * queries name a third party, which this check has never tested for and which
 * the thesis has never forbidden — a rival's name is not the anchor's name.
 * But the names it is built from come out of the anchor's own url slugs, and a
 * slug can hand back the anchor under a spelling the strip did not catch: an
 * acquired brand, an enterprise tier, a coinage. `rivalHand` runs before
 * `understand` has returned, so it cannot know the coinages; this check runs
 * after, so it can. A rival-grounded query that also names the anchor is
 * therefore dropped exactly like a plain one — the recall it would have bought
 * is worth less than the rule it would have broken.
 *
 * Pulled out of the sweep's opening-batch filter so the widening loop can run
 * the identical check on reserve-released and freshly-invented queries —
 * before, only the opening batch was filtered, so a strip term or coinage
 * that got a query dropped at the open still fired unfiltered once the
 * reserve template holding it was released later in the run.
 */
export function banned(q: string, family: QueryFamily, anchorName: string, coinages: string[]): boolean {
  if (family === "branded") return false
  const forbidden = [anchorName, ...coinages].filter(Boolean)
  if (!forbidden.length) return false
  // Lookarounds, not \b: a word boundary cannot assert between two non-word
  // characters, so a coinage edged with punctuation — "C++", ".NET",
  // "Copilot+" — was silently unenforceable while every letter-edged name in
  // the same alternation still matched. Real runs list such coinages (a
  // measured corpus held 10 punctuation-edged of 400 distinct), and this
  // predicate is the ban's one implementation, so a miss here is a miss
  // everywhere.
  const alts = forbidden.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  return new RegExp(`(?<![a-z0-9])(${alts})(?![a-z0-9])`, "i").test(q)
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

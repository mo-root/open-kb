/**
 * Of the rivals a reader already expects, how many did the map find — and
 * where did it put them?
 *
 * Every quality measurement this repo had made until now was PRECISION: take
 * the rows the map called `competitor` and ask how many deserved it. That
 * catches inflation and is blind to the opposite failure, which is a real
 * rival the map never mentions. A gate that fixes precision by demoting
 * everything would score perfectly on the old measure and be worthless.
 *
 * So this asks the other question, against a hand-written ground truth of
 * companies whose rivalry with each anchor is uncontroversial, and splits the
 * answer in two because the two failures have different cures:
 *
 *   found     — on the map at all. A miss here is a SEARCH failure: no query
 *               ever surfaced the host, so no classifier could have helped.
 *   as rival  — found AND placed `competitor` or `substitute`. A miss here is
 *               a CLASSIFY failure: the host was bought, fetched and judged,
 *               and the judgement put it somewhere else.
 *
 * WHAT IT SAID THE FIRST TIME (2026-08-23, the freshest run per anchor):
 *
 *   anchor            map   truth    found   as rival
 *   stripe.com       1123      15      93%        87%
 *   figma.com         919      12      92%        83%
 *   vercel.com       1107       8      88%        88%
 *   sentry.io         892       8      88%        88%
 *   cursor.com        775      12      83%        67%
 *   cloudflare.com   1122      10      80%        80%
 *   shopify.com      1226      14      71%        71%
 *   supabase.com      899       8      63%        50%
 *   openai.com       1194      11      55%        45%
 *
 * The gap between the two columns is small everywhere — 0 to 16 points. Where
 * a rival is found it is usually placed correctly, so PLACEMENT is not the
 * binding constraint: DISCOVERY is. Between a fifth and a third of the field
 * is never surfaced at all on four of six anchors, and on openai.com two
 * thirds is missing.
 *
 * That reorders the work. The competitor gate added on 2026-08-23 was aimed at
 * precision, and this says it cost no recall worth speaking of — but it also
 * says the remaining inflated rows are the smaller prize. The bigger one is
 * the shopify map with no magento, prestashop, saleor or vtex in it.
 *
 * openai.com is where that shows most, and it also demonstrates the trap in
 * reading this table without checking run size: it first scored 36% found on a
 * run that stopped at 651 entities, and 55% on a re-run that reached 1,194.
 * The classifier had not changed. Check the map column before believing a row.
 *
 * HOW MANY RUNS AN A/B NEEDS, which is not one. Recall moves between runs of
 * the same anchor, and how much depends entirely on the anchor:
 *
 *   stripe.com     3 runs    93%  93%  93%                        0 pts
 *   figma.com      2 runs    92%  92%                             0 pts
 *   shopify.com    3 runs    71%  86%  79%                       15 pts
 *   openai.com     2 runs    36%  55%                            19 pts
 *   cursor.com     9 runs    50 42 42 75 50 67 92 83 83          50 pts
 *
 * Where the map reliably finds the field it finds exactly the same field every
 * time; where it half-finds it, the marginal names are coin flips and the
 * number wanders. So the anchors with headroom to improve are precisely the
 * ones whose measurement is noisiest, and a single run cannot judge a change
 * on them.
 *
 * BUT THAT IS NOT WHY THE STRIP-TERM FIX SHOWED NOTHING, and the first version
 * of this paragraph said it was. 05caea9 took shopify from three terms to four
 * on all fifty products and put `headless commerce` in the core product's
 * strip exactly as intended, so the mechanism was checked and it passed. The
 * WIRE was not checked. `openingHand` opens t0 — and t1 as well for a core
 * product — and sends everything after that to a reserve the widening loop
 * draws from only when it asks for it. Counted on that run: fifty products
 * carried a fourth term and NOT ONE was ever fired as a query. Corpus-wide the
 * reserve's own "next strip term" queries are 47 of 1,455 plain queries.
 *
 * So the fix writes fifty doors and opens none, and reading 79% against 86%
 * measured nothing about it either way. The lesson is narrower than "recall is
 * noisy": a term in `report.strips` and a term on the wire are different
 * things, and only the second one buys anything. Check `searched[]` rather
 * than the decomposition before believing a query-side change landed.
 *
 * cursor.com's nine runs are the one place a trend outruns the noise: 50, 42,
 * 42 early in the day against 92, 83, 83 after the engine work, which is a
 * real move rather than a wander.
 *
 * GROUND TRUTH IS HAND-WRITTEN and deliberately conservative — only names
 * whose rivalry a practitioner would not argue about. It is a floor on the
 * real field, never a census of it, so `found` is an optimistic bound: the
 * map may also be missing rivals this file has never heard of.
 *
 *   npx tsx scripts/recall.ts
 *   npx tsx scripts/recall.ts stripe.com     # one anchor, listing every miss
 *   npx tsx scripts/recall.ts --by family    # which queries find the field
 *
 * WHICH QUERIES FIND THE FIELD (21 runs across 9 anchors, 2026-08-23), where
 * a query scores when it is the FIRST in its run to surface a ground-truth
 * rival:
 *
 *   family       queries  rivals  per 100 q   $/rival
 *   branded          115      13       11.3    $0.045
 *   plain            889      96       10.8    $0.043
 *   debranded       1037      59        5.7    $0.083
 *   rival            286      11        3.8    $0.107
 *
 * The templates find the known field about twice as often as the model's own
 * queries and for half the price — the same ordering `scripts/query-yield.ts`
 * found for market share, arrived at from the opposite direction. `debranded`
 * is the LARGEST family and the second worst at this.
 *
 * The `rival` family being last is worth sitting with: it is a template over a
 * name the anchor itself published, so it searches `<someone else> alternatives`
 * and lands on that someone's neighbours rather than the anchor's.
 *
 * TWO HYPOTHESES WERE TESTED HERE AND BOTH FAILED. Recorded so they are not
 * proposed again:
 *
 *   1. "The four reserve templates — best X, X vs, top X companies, open
 *      source X — are roundup-shaped, so promoting them to the opening hand
 *      would find more of the field." They surfaced ZERO ground-truth rivals
 *      across 32 queries, and buy market entities at 41-43% against the two
 *      open templates' 55%. Promoting them would cost yield and buy nothing.
 *
 *   2. "`branded` finds rivals 2.7x better than `plain`, so fire more of it."
 *      That was 18 queries on 6 anchors. Widened to 115 queries on 9, the gap
 *      is 11.3 against 10.8 — noise.
 *
 *   3. "The field is on page 3 and 4; the run only buys two pages, and
 *      `deepenedProducts` is empty on 21 of 25 runs, so depth is the lever."
 *      Bought directly: `ecommerce platform` returns 17 hosts at two pages and
 *      34 at four, and NONE of shopify's four missing rivals at either depth.
 *      `LLM API` likewise, 15 against 31 hosts and none of openai's five.
 *      Depth doubles the rows and does not reach the field.
 *
 * WHAT DID REACH IT, bought the same way: a different FRAMING of the market,
 * not more of the same one.
 *
 *   ecommerce platform               none of the four
 *   best ecommerce platform          none
 *   open source ecommerce platform   none
 *   headless commerce platform       commercetools.com
 *   self hosted ecommerce platform   saleor.io
 *
 * So recall is bounded by the STRIP TERMS, which is where a market's framings
 * come from — `catalog` returns one to three per product and the code keeps
 * three. Shopify's core product stripped to `ecommerce platform`, `online
 * store builder`, `point of sale`; none of the three ranks magento,
 * prestashop or vtex, and no template over them ever will. The framing that
 * would have was `headless commerce` — which this run DID hold, under a
 * different product, and which duly found commercetools.
 *
 * That is the shape of the next change, and it is not "buy more" — it is
 * "strip wider". Left unmade here because it needs an A/B run rather than an
 * argument: `--by family` is how it should be judged.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const TRUTH: Record<string, string[]> = {
  "stripe.com": ["adyen.com", "checkout.com", "braintreepayments.com", "paypal.com", "squareup.com", "mollie.com", "razorpay.com", "paddle.com", "worldpay.com", "fiserv.com", "authorize.net", "gocardless.com", "2checkout.com", "bluesnap.com", "nuvei.com"],
  "figma.com": ["sketch.com", "adobe.com", "penpot.app", "framer.com", "canva.com", "invisionapp.com", "zeplin.io", "axure.com", "balsamiq.com", "marvelapp.com", "protopie.io", "uizard.io"],
  "shopify.com": ["bigcommerce.com", "woocommerce.com", "magento.com", "wix.com", "squarespace.com", "squareup.com", "prestashop.com", "ecwid.com", "lightspeedhq.com", "commercetools.com", "saleor.io", "medusajs.com", "vtex.com", "swell.is"],
  "openai.com": ["anthropic.com", "mistral.ai", "cohere.com", "ai21.com", "huggingface.co", "together.ai", "perplexity.ai", "x.ai", "stability.ai", "replicate.com", "deepmind.com"],
  "cloudflare.com": ["akamai.com", "fastly.com", "bunny.net", "keycdn.com", "imperva.com", "sucuri.net", "vercel.com", "netlify.com", "digitalocean.com", "stackpath.com"],
  "cursor.com": ["windsurf.com", "zed.dev", "codeium.com", "tabnine.com", "replit.com", "aider.chat", "continue.dev", "cline.bot", "sourcegraph.com", "jetbrains.com", "warp.dev", "devin.ai"],
  // These three have no fresh run, but they have older ones, and `--by family`
  // reads every run an anchor has rather than only the newest.
  "vercel.com": ["netlify.com", "render.com", "fly.io", "railway.app", "heroku.com", "deno.com", "cloudflare.com", "digitalocean.com"],
  "supabase.com": ["firebase.google.com", "planetscale.com", "neon.tech", "cockroachlabs.com", "appwrite.io", "nhost.io", "pocketbase.io", "xata.io"],
  "sentry.io": ["datadoghq.com", "newrelic.com", "rollbar.com", "bugsnag.com", "honeybadger.io", "raygun.com", "airbrake.io", "logrocket.com"],
}

/** The two relations that mean "a buyer would pick one of these, not both". */
const RIVAL = new Set(["competitor", "substitute"])

const runsDir = join(process.cwd(), "runs")
const byFamily = process.argv.includes("--by") && process.argv[process.argv.indexOf("--by") + 1] === "family"
const only = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined

const hostOf = (u: string): string => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, "") } catch { return "" }
}

/** The newest run for an anchor — filenames carry a sortable stamp. */
const newestRun = (anchor: string): string | undefined =>
  readdirSync(runsDir)
    .filter((f) => f.startsWith(`sweep-${anchor.replace(/\./g, "-")}-`) && f.endsWith(".json"))
    .sort()
    .pop()

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`

console.log("\nRecall against a hand-written field — found = discovery, as rival = placement\n")
console.log("  " + "anchor".padEnd(16) + "map".padStart(6) + "truth".padStart(7) + "found".padStart(10) + "as rival".padStart(11) + "  misplaced")

for (const [anchor, rivals] of Object.entries(TRUTH)) {
  if (only && anchor !== only) continue
  const file = newestRun(anchor)
  if (!file) {
    console.log("  " + anchor.padEnd(16) + "  (no run in runs/)")
    continue
  }
  const r = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as { entities: any[] }
  // `noise` is the one kind that leaves the map, so it does not count as found.
  const placed = new Map<string, string>(r.entities.filter((e) => e.kind !== "noise").map((e) => [e.domain, e.relation]))
  const kept = r.entities.filter((e) => e.kind !== "noise" && e.relation !== "none").length

  const missed: string[] = []
  const misplaced: string[] = []
  let asRival = 0
  for (const d of rivals) {
    const v = placed.get(d)
    if (v === undefined) missed.push(d)
    else if (RIVAL.has(v)) asRival++
    else misplaced.push(`${d}=${v}`)
  }
  const found = rivals.length - missed.length
  console.log(
    "  " + anchor.padEnd(16) + String(kept).padStart(6) + String(rivals.length).padStart(7) +
    `${found} ${pct(found, rivals.length)}`.padStart(10) + `${asRival} ${pct(asRival, rivals.length)}`.padStart(11) +
    "  " + (misplaced.join(" ") || "—"),
  )
  if (only) {
    console.log("\n  never surfaced by any query:")
    for (const d of missed) console.log("    " + d)
  }
}
console.log("\n  ground truth is hand-written and conservative — a floor on the real field, not a census\n")

/**
 * The same ground truth, asked of the SEARCHES rather than the map: which kind
 * of query was the first to surface each rival. A miss in the main table is a
 * discovery failure; this says which family would have had to find it.
 */
if (byFamily) {
  const fam: Record<string, { q: number; rivals: number; usd: number }> = {}
  let runs = 0
  for (const [anchor, rivals] of Object.entries(TRUTH)) {
    const field = new Set(rivals)
    for (const f of readdirSync(runsDir).filter((f) => f.startsWith(`sweep-${anchor.replace(/\./g, "-")}-`) && f.endsWith(".json"))) {
      let r: { searched?: any[] }
      try { r = JSON.parse(readFileSync(join(runsDir, f), "utf8")) } catch { continue }
      if (!Array.isArray(r.searched)) continue
      runs++
      const seen = new Set<string>()
      for (const s of r.searched) {
        const hosts = [...new Set((s.hits ?? []).map((h: any) => hostOf(h.url)).filter(Boolean))] as string[]
        // FIRST to surface it: a rival already seen this run is not this
        // query's find, however many times it comes back afterwards.
        const found = hosts.filter((h) => !seen.has(h) && field.has(h)).length
        hosts.forEach((h) => seen.add(h))
        const c = (fam[s.family ?? "?"] ??= { q: 0, rivals: 0, usd: 0 })
        c.q++
        c.rivals += found
        c.usd += s.usd ?? 0
      }
    }
  }
  console.log(`\nWhich family first surfaced a rival — ${runs} runs\n`)
  console.log("  " + "family".padEnd(12) + "queries".padStart(8) + "rivals".padStart(8) + "per 100 q".padStart(11) + "$/rival".padStart(10))
  for (const [k, c] of Object.entries(fam).sort((a, b) => b[1].rivals / b[1].q - a[1].rivals / a[1].q)) {
    console.log("  " + k.padEnd(12) + String(c.q).padStart(8) + String(c.rivals).padStart(8) +
      (100 * c.rivals / c.q).toFixed(1).padStart(11) + `$${(c.usd / (c.rivals || 1)).toFixed(3)}`.padStart(10))
  }
  console.log("")
}

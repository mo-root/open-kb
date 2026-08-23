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
 *   cursor.com        775      12      83%        67%
 *   cloudflare.com   1122      10      80%        80%
 *   shopify.com      1226      14      71%        71%
 *   openai.com        651      11      36%        27%
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
 * The openai.com row is a caveat, not a finding: that run stopped at 651
 * entities where its siblings reached 900-1,200, so it measures a thin run
 * rather than a bad classifier. Re-run before drawing anything from it.
 *
 * GROUND TRUTH IS HAND-WRITTEN and deliberately conservative — only names
 * whose rivalry a practitioner would not argue about. It is a floor on the
 * real field, never a census of it, so `found` is an optimistic bound: the
 * map may also be missing rivals this file has never heard of.
 *
 *   npx tsx scripts/recall.ts
 *   npx tsx scripts/recall.ts stripe.com     # one anchor, listing every miss
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
}

/** The two relations that mean "a buyer would pick one of these, not both". */
const RIVAL = new Set(["competitor", "substitute"])

const runsDir = join(process.cwd(), "runs")
const only = process.argv[2]

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

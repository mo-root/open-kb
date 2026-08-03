---
date: 2026-08-02
status: proposed design (not yet approved)
subject: open-kb orchestration layer
method: 10 agents - 4 designs, 5 judges, 1 synthesis
---

# open-kb — the orchestration design

**One lead agent. One board. Six lanes. Nothing blocks.**

---

## The design in one paragraph

The orchestrator is a `while` loop of about 140 lines wrapped around **one model conversation** — the *lead* — which holds the skill, sees the target domain and a dollar ceiling, and is told GO. The lead reads pages, decides what the company actually sells and how to say that without the company's own words, and writes **missions** onto a shared board: a priority-ordered list of investigations, each one a lens, a brief, a priority, a cost tier, and a sentence saying why it is worth buying. Writing a mission does not block the lead — `spawn` returns in about a millisecond. Six investigator lanes drain the board continuously and greedily: whenever a lane frees, the harness pops the highest-priority mission whose cost tier still fits inside what the run can afford, and starts it within a millisecond. Investigators hold the same skill and a smaller tool set; they write nodes and edges into the map *as they find them*, so a killed or crashed investigator still leaves everything it proved. The lead does not sit at a barrier waiting for a round to finish — it declares its own re-entry condition (`next({after: 6 landings or 25 seconds})`), and any investigator that finds something that changes the picture can pull the lead forward immediately. The harness owns four things and nothing else: money (reserved before work, per mission, settled at actuals), evidence (a quote must be a literal substring of bytes this run actually fetched), transport truth (a 200 with an empty body is a failure no matter what the status line says), and the clock. It never chooses a query, a URL, a lens, a node type, or a priority. The run ends when the lead says the remaining gaps will not close with more searching — or, if it does not say so first, when the money or the clock runs out, and the screen says which.

**Two agents. Eight tools, three of them free. One skill file. No framework.**

---

## The run, step by step

`stripe.com`, ceiling **$1.50**, six lanes, wall clock 300s.

Numbers marked **[M]** trace to a measured fact from the author's own testing. Numbers marked **[A]** are assumed model latency (first token 0.8–1.5s, sustained ~140 tok/s) and are the softest thing in this document. Everything else is arithmetic over those two.

---

**t=0.00** — `POST /run {domain:"stripe.com"}`. Four NDJSON streams open. The ledger carves a **$0.15 finish reserve** before any work exists; the work pool is $1.35. The board is seeded with exactly one item, templated from the domain by the harness:

```
p100  dig   orient   "Establish what stripe.com sells, in the words a buyer
                      would use, not the words the company uses."
```

That item is not a special agent. It is handed to the lead as its opening instruction. There is no probe role, no orientation stage, no phase.

**t=0.12 — FIRST PIXEL.** The harness writes `progress {round:0, agent:"harness", message:"opening a map of stripe.com"}` and `cost {usd:0, ceiling:1.50, pool:1.35, finishReserve:0.15}` synchronously, before any network call. The stage rail, the empty budget bar, the empty map and the empty board render. **Zero model calls, zero provider calls.**

**t=0.20** — The lead's first model call opens. Its prompt is the skill (3,180 tokens) plus one line: `You are the LEAD. Target: stripe.com. Ceiling $1.50. GO.` Before the call, the harness reserves the turn's estimated cost — 3.5k in × $0.50/M + 1.5k out × $3.00/M ≈ **$0.006** — against the pool. The lead is metered like everything else.

**t=2.6 — First trace rows, with reasoning attached.** The lead's first tool call finishes streaming and the harness fires it the instant its arguments close [A]:

> `fetch(["https://stripe.com/", "https://stripe.com/llms.txt", "https://docs.stripe.com/llms.txt"], mode:"direct", why:"the apex page tells me who they sell to in their own words; some companies also publish a machine-readable summary, and finding out costs a fraction of a cent")`

Three trace rows appear carrying that `why` next to the URL. **This is the first genuinely interesting thing on screen, and it is the reasoning, not the result.**

**t=3.3** — `stripe.com/llms.txt` → 200, **65,412 bytes** [M], `text/plain`, $0.00. The harness stores the whole body in the evidence store and returns to the lead an **8KB slice** plus `{bytes:65412, truncated:true, handle:"ev2", links:[…]}`. The lead's context grows by ~2.2k tokens, not 17k. That 8KB slice already contains the summary blockquote and the first fifteen H2 headings.

**t=3.4** — `docs.stripe.com/llms.txt` → 200, 41KB, handle `ev3`.

**t=3.6** — `stripe.com/` → 200 with under 500 characters of extractable text (an app shell). The sniffer calls it: `ok:false, reason:"thin-render", hint:"200 but almost no text — this page is assembled in the browser; a heavier transport may work but costs 13–16s"`. The trace row goes amber. Nothing branches; the lead is simply told.

**t=5.8 — FIRST NODES ON THE MAP.** Lead turn 2 emits two calls, dispatched concurrently:

> `read(handle:"ev2", project:"headings", why:"65KB is too much to read; the headings are the catalogue")` — **FREE, 40ms, no provider call**
> `remember(…)` — 1 company node, 11 capability nodes, 1 buyer node, 13 edges, built from the 8KB slice it already holds

The free read returns **684 bytes** — the summary blockquote plus 23 markdown headings, every product name among them: 1.1% of the file, ~100% of the signal [M]. The lead applies a judgement the skill armed it for: *23 headings out of 65KB is dense, so the projection is trustworthy; 5 headings out of 615KB would be a marketing sitemap dump and the projection would be destroying the signal, in which case go to the docs subdomain* — the Adyen counter-example, written out in the skill as a paragraph, not as a branch in `fetch` [M].

The de-branding happens in the `reason` field of each node, and the harness stamps every one of them tier **`own-material`** because the handle's origin is the company's own domain:

- `Radar` → **"card-fraud scoring on the authorization path"** — *"they describe it as blocking fraud before the charge completes, which is a decision made inside the auth call, not a batch review"*
- `Issuing` → **"programmatic card issuing and BIN sponsorship"**
- `Connect` → **"multiparty split settlement for marketplaces"**
- `Terminal` → **"card-present acceptance with an SDK"**
- `Treasury` → **"embedded banking accounts as an API"**
- buyer → *"an engineering lead at a company that just started taking money online and is losing checkouts to declines it cannot explain"*

**Thirteen nodes on the map at 5.8 seconds. Spend: $0.011.** They render solid, because `own-material` is the strongest tier the run can produce.

**t=8.8–14.2 — Lead turn 3, and the moment the design pays for itself.** The lead streams a `spawn` with nine missions in priority order. The harness runs an incremental JSON parser over the streaming arguments: **when a complete mission object closes inside the array, it is reserved and pushed to the board immediately** — it does not wait for the whole turn. Mission 1 hits a lane at t=8.8; mission 9 at t=14.2. Lanes light up progressively over 5.4 seconds instead of all at once at 14.2. This is the one clever thing in the codebase, it is about 40 lines, and if it breaks the run is five seconds slower and nothing else changes.

Reservation, in the lead's order, against a spendable pool of $1.339:

```
p94 read  fraud-scoring    $0.10 ✓      p78 read  in-person-accept   $0.10 ✓
p92 read  card-issuing     $0.10 ✓      p74 dig   comparison-harvest $0.25 ✓
p90 read  marketplace-split$0.10 ✓      p70 peek  docs-vocabulary    $0.03 ✓
p88 read  embedded-banking $0.10 ✓      p61 read  open-source-subst  $0.10 ✓
p82 read  multi-cur-acquire$0.10 ✓
```

All nine funded, $0.98 reserved, $0.359 spendable left. The same turn also issues:

> `fetch(["https://stripe.com/"], mode:"unlock", why:"the apex names the buyer in their own words and the direct tier only got a shell; worth one paid attempt")`

This call exceeds three seconds, so at **t=11.9** the harness answers it with `{status:"pending", handle:"ev9"}` and the lead moves on. **Nothing the lead does blocks the lead.** Slow bytes land in the evidence store and are read later, for free, with a handle.

The lead closes turn 3 with `next({after:{landings:6, seconds:25}, why:"six of nine back is enough to see which lenses are paying"})`.

**t=10.6–15.4 — THE MONEY SHOT.** Nine SERP calls land, ~1.5–2.5s each [M], ~28KB of parsed `organic[]` each [M], `argsDigest` showing the literal query bought:

```
seq 18  lane-0/fraud-scoring     search  "card fraud scoring authorization path vendors"
seq 19  lane-1/card-issuing      search  "programmatic card issuing platform BIN sponsorship"
seq 20  lane-2/marketplace-split search  "marketplace split settlement payouts provider"
seq 21  lane-3/embedded-banking  search  "embedded banking as a service accounts API"
seq 22  lane-4/multi-cur-acquire search  "multi currency acquiring local payment methods"
seq 23  lane-5/in-person-accept  search  "card present terminal SDK smart reader"
```

**Not one contains the word Stripe.** Each row carries the mission's `why`. This is the thesis on screen as a scrolling list of things being bought, and it happens at eleven seconds.

**t=33.9 — the measured Stripe trap, and what it costs.** The paired unlock fetch of `stripe.com` returns **HTTP 200 with a zero-byte body**, capped at 25s. The real failure is measured at 33–60s on two different zones [M]; the cap costs us 25s once. The sniffer classifies it: `ok:false, reason:"empty-200", hint:"this host answers the unlock tier with an empty page; its own published summary already gave you the catalogue"`. The harness records **strike 1 of 2** against `{stripe.com, unlock}` in a run-local breaker table that shipped empty and dies with the run. Progress feed: *"stripe.com returns an empty 200 on the unlock tier — the 65KB summary already gave us the catalogue."*

**Count the damage honestly:** 25 seconds of one outstanding fetch, during which six investigators worked continuously. **Zero wall-clock seconds cost to the run.** In a design with a round barrier this call would have set that round's floor at 25 seconds while five finished workers sat idle. That comparison is the reason there is no barrier here.

**t=16–90 — steady state.** Landings arrive every 1.5–3 seconds. Each one is its own small event: a board row dissolves, a lane resets, two or three nodes appear on the map with their reason text, the budget bar ticks. Nothing ever completes together, so the screen never goes quiet.

- **t=27.4** — `fraud-scoring` reads a vendor's own product page (direct, free, 0.6s) and asserts Sift, Forter, Sardine — tier `page`, solid nodes.
- **t=31.0** — `card-issuing` lands Marqeta, Lithic, Highnote. **Highnote and Lithic are the payoff: neither is reachable from any query containing the word "Stripe."**
- **t=38.2** — `multi-cur-acquire` hits `adyen.com/llms.txt`, gets 615KB, projects headings for free, gets **5 headings that are all marketing events** [M]. Per the skill's warning it does not trust that projection; it fetches `docs.adyen.com/llms.txt` (29 headings [M]) and reads that instead. One free re-projection, one free fetch, no code path knew any of this.
- **t=44.7** — `comparison-harvest` (a `dig`) fetches a listicle: direct returns 403, it escalates to `unlock`, 14.6s, 880KB [M]. The harness returns 8KB plus a handle; the investigator does three **free** `read(handle, grep:"fraud")` calls totalling ~4k characters and asserts 11 companies, 6 of them new, each with the article's own sentence as its quote. **An 880KB page entered the evidence store once and entered a prompt never.**
- **t=46.1** — `comparison-harvest` sets `wake:true` on a `propose`: *"this page names three vendors nobody else surfaced and I do not have allowance to open them."*

**t=46.3 — Lead turn 4** (woken early; its `next` condition was 6 landings or 25s, and the wake overrode both). Three free `recall` calls: `find(kind:"company")` shows 19 companies, `gaps` shows 7 single-sourced, `board` shows the unreviewed proposals sitting in the worker band. It promotes two proposals from p52 to p86, kills one at p0 with a reason (*"same question as the fraud lens already running"*), and spawns five verification `peek` missions. **The board visibly re-orders while six lanes keep working.** No barrier was crossed; no lane paused.

**t=48 — USABLE MAP.** 24 companies, 18 capability nodes, 1 buyer, 89 typed edges, every edge carrying a type, a URL and a reason. Spend $0.51. Solid-vs-dashed on the canvas shows at a glance that 27 of 43 nodes have been read rather than merely surfaced.

**t=62–115** — Verification peeks (flash-lite, ~$0.008 each) open candidates' own sites. Two nodes are **retracted**: a payments-news blog that a snippet made look like a vendor, and a company whose own page describes KYC rather than fraud scoring on the auth path. The node greys, drifts out of its cluster, and the feed prints the reason. **This is the frame that proves the thing is thinking rather than executing**, and it flows through the same mint function as every other write.

**t=118 — Lead turn 8.** `recall({op:"gaps"})` — free — returns 9 single-sourced nodes and 3 edges with thin reasons. The pool is at $0.19, above the finish reserve. It spawns three corroboration `peek` missions.

**t=141 — the budget degrades instead of snapping.** Spendable falls to $0.07. The board's top item is a p84 `dig` at $0.25 — it does not fit. The run does **not** stop. `popAffordable` scans down and pops a p66 `peek` at $0.03. The progress feed says so, in words: *"the pool no longer funds a dig; running peek-tier work only. Your p84 'regional acquirers in LATAM' has been skipped 3 times for affordability."* The lead is told the same sentence in-band on its next turn and can re-tier the mission or drop it. **This is the one place the harness departs from the lead's ordering, and it is stated every single time it happens.**

**t=152 — Lead turn 11.**

> `finish(reason:"coverage and budget", summary:"…", unresolved:["no read on Highnote's actual issuing volume","Adyen's own fraud product never got its own mission","LATAM regional acquiring was priced out three times"])`

**t=152.4** — `{kind:"terminated", reason:"lead-finished", humanReason:"…"}` then `{kind:"complete"}`. Residue — the unreached board items with the lead's own priorities and reasons — ships with the result, so the ending reads as *"here is exactly what I would do next, ranked"* rather than *"we ran out."*

---

**Totals — stripe.com: 152 seconds, $1.34 of $1.50, 20 missions, 63 nodes (44 companies, 18 capabilities, 1 buyer), 154 typed edges, 38 of 63 nodes at tier `page` or better, 1 host learned to be hostile at runtime, 0 hardcoded facts about Stripe anywhere in the code.**

Cost breakdown, arithmetic shown: lead 11 turns, ~160k cumulative input × $0.50/M + 7.7k output × $3.00/M = **$0.10**; 12 `read` missions on gemini-3.5-flash at ~29.5k cumulative in / 2.5k out = $0.070 each = **$0.84**; 2 `dig` missions at ~75k in / 5k out = $0.161 each = **$0.32**; 9 `peek` missions on gemini-3.1-flash-lite ≈ $0.008 each = **$0.07**; SERP and unlock calls are inside those figures.

---

## The same run, on a company with none of that

`crossroads-logistics.com` — illustrative: a ~120-person regional freight brokerage in Memphis. No llms.txt. No docs site. No API. Seven marketing pages. Its market has no comparison blogs at all; its vocabulary lives in a federal licensing database, a trade association's member list, and job ads.

**Same engine. Same skill file. Same six tools. The code is byte-identical and nothing in it knows this is a different kind of company.**

**t=0.00–0.12** — Identical. Same first pixel, same seeded orient item, same reserve carve.

**t=2.5 — Lead turn 1.** The same opening move, because it is the skill's opening move and not a Stripe-shaped one:

> `fetch(["https://crossroads-logistics.com/", "https://crossroads-logistics.com/llms.txt", "https://docs.crossroads-logistics.com/llms.txt"], mode:"direct", why:"apex first; a machine-readable summary is a long shot for a broker but finding out costs nothing")`

**t=3.0** — `/llms.txt` → **404**, 0.4s, $0.00. `docs.` → DNS NXDOMAIN, 0.2s. One line in the feed: *"no machine-readable summary — reading the site like a person."* Nothing branches. **The entire llms.txt path costs half a second and no money when it is absent, which is exactly why it is a sentence in the skill and not a ladder in the code.**

**t=3.1 — the inversion.** `crossroads-logistics.com/` → **200, 62KB of server-rendered HTML, 0.5s, $0.00.** Small companies do not block scrapers. On Stripe the direct tier gave a shell and the paid tier gave nothing; here the free tier gives everything and the paid tier is never touched. Same `fetch`, same `mode` parameter, opposite outcome, zero code aware of either.

Critically, `fetch` returns **same-host links with their anchor text** as a first-class field:

```
links: [ {"/services","Services"}, {"/modes","Modes We Move"},
         {"/industries","Industries Served"}, {"/carrier-setup","Carrier Setup"},
         {"/authority","Our Authority & Insurance"}, {"/track","Track a Load"} ]
```

**A site's own navigation is the universal machine-readable summary.** "Practice Areas / Attorneys / Results" for a law firm; "Capabilities / Equipment / Certifications" for a manufacturer; "Modes / Lanes / Authority" for a broker. `/llms.txt` is a lucky shortcut on the same road, not a different road with a fallback.

**t=6.9 — Lead turn 2.** It reads the nav and fetches four more pages in one turn — four free direct GETs, in parallel, 0.9s total:

> `fetch(["/services","/modes","/authority","/industries"], mode:"direct", why:"a broker's market lives in its operating authority, its modes and its lanes, not in product names")`

That sentence is a paragraph in the skill about licensed and industrial markets. It is knowledge, and it is one edit away from being replaced by whoever owns the skill.

**t=14.2 — FIRST NODES.** No product catalogue exists, so **the de-branding runs in the opposite direction and the skill covers both without a branch**: there is nothing to strip, there are capability nouns to *lift out of sales prose*.

- **"temperature-controlled LTL brokerage with continuous reefer telemetry"** — *"their 'Cold Chain program' page is describing reefer LTL with live temperature reporting, which is what a food shipper searches for"* (this is where the brand term dies)
- **"drayage from the BNSF Memphis intermodal ramp"** — *"they lead with ramp proximity, which is a geographic capability, not a service name"*
- **"FMCSA broker authority, MC-######, $75,000 surety bond"** — *"a legal precondition that eliminates most of the world's supply, so it is itself a market"*
- **"TIA member"**, **"SmartWay partner"**, **"non-asset 3PL"**, **"expedited/hot-shot"**
- Buyer: *"a shipping manager at a food manufacturer whose asset carrier just refused a lane two days before pickup"* — quoted from a customer story on `/industries`

**Fifteen nodes at 14.2 seconds**, all tier `own-material`, all solid. That is **8.4 seconds later than Stripe**, and the gap is entirely the missing 684-byte shortcut: four extra page fetches and one extra read turn. **That is the whole honest cost of generality.**

**t=16.8–21.9 — Lead turn 3, spawn of nine.** The lenses are invented for this market. Every one is a free string the skill taught as a *shape*; none of them exists in any enum:

```
p95 dig   registry-cohort     "the FMCSA licensing database lists every entity holding
                               active broker authority — pull the ones operating the
                               same states and modes. This market's comparison page is
                               a government database."
p92 dig   member-directory    "TIA member list — the association IS the peer set"
p88 read  substitute-route    "what a shipping manager does INSTEAD: contract direct
                               with an asset carrier, use a digital freight marketplace,
                               or put a TMS in-house and broker their own freight"
p85 read  hiring-tell         "job ads for carrier sales reps name the TMS the shop runs
                               (McLeod, MercuryGate, Turvo) — the TMS is the capability"
p82 read  trade-press-ranking "FreightWaves / JOC annual broker rankings — the only
                               comparison articles this market has"
p78 read  lane-overlap        "brokers advertising the same Memphis-origin lanes"
p74 read  reefer-specialists  "temperature-controlled brokerage, food and pharma"
p70 read  drayage-cohort      "drayage at the same and adjacent intermodal ramps"
p63 peek  load-board-presence "which load boards they post to; the poster list is a market"
```

The `substitute-route` lens is the de-branding thesis in a market with no blogs: **a venture-funded digital freight marketplace and a 120-person Memphis brokerage compete for the identical buyer and have never appeared in the same sentence.** No branded query reaches it. Only the job — *"get 22 reefer loads out of Memphis next week when my carrier bailed"* — reaches it.

**t=19.4** — First de-branded SERP queries on the wire: `"freight broker active authority Tennessee reefer"`, `"digital freight marketplace instant tender shipper"`, `"carrier sales representative McLeod TMS job"`. **Not one names the company.**

**t=24–96 — the wave that isn't a wave.** Lanes drain the board continuously; nothing waits.

- **t=31.6** — `registry-cohort` finds the federal licensing search. Direct fetch works, 0.7s, free. It asserts **22 brokers** with active authority in the same states, edge type `"holds-same-authority-class"`, reason *"appears in the same regulator's active-authority list for the same operating states, which is the market's own definition of who is allowed to do this work."* **One free page, twenty-two companies.** There is no equivalent move in software, and the highest-yield artifact of the entire run costs $0.00.
- **t=38.9** — `member-directory` hits the association member list behind a soft-403. Direct fails in 0.5s; the investigator judges the page high-yield and escalates to `unlock` — 13.8s, 810KB [M]. **Here the expensive path is the one that works, the exact inverse of Stripe, from the same code and a different agent judgement.** Fourteen members, six overlapping the registry (merged commutatively on key), eight new.
- **t=44.1** — `trade-press-ranking` finds the ranking as a 1.8MB PDF. `fetch` caps its return at 8KB and hands back a handle; the investigator walks it in four **free** `read(handle, range:[…])` calls. Six ranked brokers with revenue bands — the only revenue data in the run.
- **t=52.3** — `hiring-tell` finds 11 brokerages within 300 miles hiring carrier sales reps and naming their TMS, several of which appear in **no** directory and **no** registry filter. A channel the market's own literature does not have.
- **t=57.0** — `load-board-presence` finds every poster list behind auth. It spends **$0.011**, writes one node, and reports honestly: `{status:"ok", findings:["poster lists are behind login; this lens is closed"]}`. **A cheap, clean dead end reported in one line is a good outcome**, and the lead never funds that lens again.
- **t=61.4** — An aggregator serves **HTTP 200 with 400KB of HTML where a `.txt` was requested**. The sniffer catches the content-type/path mismatch: `ok:false, reason:"content-mismatch"`. **Same code path that caught Stripe's empty-200 at t=33.9 in the run above.** Neither is a site-specific rule; both are HTTP being HTTP [M — vercel.com/llms-full.txt, 200 with 487KB of HTML].

**t=62 — USABLE MAP.** 31 companies, 7 capabilities, 6 authority/certification nodes, 74 edges. Fourteen seconds later than Stripe, on a target with a tenth of the public surface.

**t=88 — Lead turn 5, and the moment this design has that none of the alternatives do.** `recall({op:"barren"})` — free — surfaces a de-branded term with **zero verified companies after two searches**: the lead had written **"final mile"** as a capability at t=14.2, and both searches on it returned only aggregators.

The skill's default reading is that a barren term means the **term** is wrong, not that the market is empty. The lead retracts it and rewrites it:

> `remember({retract:"cap:final-mile", why:"two searches on this returned only directories; 'final mile' is the industry's internal word and a shipper does not type it"}, {nodes:[{key:"cap:residential-oversize", label:"residential appointment delivery of oversized freight", …}]})`

Two searches on the replacement return **six brokers** by t=112. **The de-branding was wrong and the run repaired it, on screen, with the reason printed.** The term node visibly changes its label.

**t=128 — Lead turn 8.** `recall({op:"gaps"})` shows 17 single-sourced nodes, nearly all of them from the registry — because a licensing row proves a company *is licensed*, not that it *does this work*. The lead spends the finish reserve on four verification peeks against those companies' own sites. Nine confirm; three are demoted from `broker` to `asset-carrier-with-brokerage-arm` (a real distinction in this market and a `kind` the code has never heard of); one is retracted.

**t=166 — `finish`.**

> `reason:"the remaining gaps need a phone call, not a search"`
> `unresolved:["revenue bands exist for 6 of 42 firms and nowhere else","the load-board lens is behind auth and stayed closed","22 registry companies are licensed but unverified as active in these lanes"]`

---

**Totals — crossroads-logistics.com: 166 seconds, $1.19 of $1.50, 19 missions, 56 nodes (42 companies, 7 capabilities, 6 authorities, 1 buyer), 118 typed edges, 24 of 56 nodes at tier `page` or better.**

**Where the map comes out thinner, honestly:**

1. **Seven capability nodes against Stripe's eighteen.** A company with no product catalogue gives you less vocabulary to work with, full stop.
2. **More of the map is registry co-listing**, which is a weaker relation than "their own page says what they do." Twenty-two of forty-two companies are on the map because a regulator lists them, and the canvas shows that: they render dashed until a verification peek opens their own site, and only nine of twenty-two got that far inside the ceiling.
3. **No revenue, no headcount, no market share** for 36 of 42 firms. It is not on the open web.
4. **The substitute set is real but small** — four companies. Digital freight marketplaces, one asset carrier's brokerage arm, and "in-house TMS" as a capability node with a `displaces` edge. That is the highest-value part of the map and it is four nodes wide, because there are only about that many.

**It stopped $0.31 short of the ceiling and said why.** The Stripe run ended near its ceiling; this one ended on convergence with money left. Same loop, same numbers, different territory — which is what a map should do.

**What differed between the two runs, and where it lived:** the opening probe was identical; the transport that worked inverted (Stripe needed direct because unlock was dead, the broker needed direct because unlock was unnecessary); the vocabulary source moved from a product catalogue to a federal licence register; the lens names were entirely different strings; the highest-yield artifact moved from a 65KB llms.txt to a free government database. **Every one of those is a sentence in the skill or a judgement the model made at runtime.**

---

## Where the knowledge lives

Default is SKILL. Everything in the CODE column is justified individually, and the test applied to each is: *is this statement true of a law firm, a contract manufacturer, a regional bank and a logistics broker alike?* If not, it is not allowed in code.

### SKILL — swap this file, the engine is untouched

| Fact | Why it cannot be code |
|---|---|
| `/llms.txt` is a convention worth one cheap probe; `docs.<domain>/llms.txt` is a second rung | True of developer-tools SaaS and of almost nothing else [M: 10/14 apex, 12/14 with the docs rung]. As a code branch it fires on 10 of 14 software domains and 0 law firms. As a sentence, its absence cost the broker run **0.4 seconds and $0.00**. |
| llms.txt triage: 23 headings in 65KB → trust the projection; 5 headings in 615KB → it is a marketing sitemap, go to the docs subdomain | A hardcoded heading parser is a 99% win on Stripe and total signal destruction on Adyen [M]. The measured fact is that the shape varies, so the response must be judgement. The Adyen counter-example is written out in full. |
| `llms-full.txt` is often a trap (6.4MB; sometimes HTML under a markdown name) [M] | Web-publishing folklore. It rots. |
| Escalation policy: direct first; escalate only when the page looks worth paying for | Stripe defeats the paid tier and serves 65KB to curl; the association directory 403s the free tier and yields 810KB to the paid one. **Both runs are in this document. A code ladder gets exactly one of them right.** |
| Query shapes, the de-branding test ("would a buyer who had never heard of this company type this?"), the no-coinages rule | v1's 936 lines of query templates × cap, whose own comments admit the fix was asking fewer questions. **There are zero query templates anywhere in this design.** `search` buys the literal string the model wrote. |
| Lens vocabulary (`fraud-scoring`, `registry-cohort`, `hiring-tell`, `substitute-route`) | The single most important type decision here: in code, `lens: string`. `registry-cohort` is not a lens anyone would have put in a payments-shaped enum. |
| Node `kind` and edge `type` vocabulary | `"holds-same-authority-class"` and `"displaces"` were invented mid-run. Free-form strings with a commutative merge on `key`. |
| Priority semantics — what a 90 means versus a 60 | Code performs `argmax` and an affordability filter. It contains no rubric, no weights, no aging term, no decay. |
| Cost-tier choice — when a question is a `peek`, a `read`, or a `dig` | The model sizes the work; the harness owns the dollar number attached to each size. |
| "In markets that do not write comparison posts, the comparison page is a directory, a registry, an association member list, an exhibitor list, an approved-supplier list, a licence register, or a job board" | The single most transferable sentence in the skill, and the reason the broker run works. It names shapes, never hosts. |
| "A page that enumerates many vendors is a DOCUMENT, not a company: open it, harvest it, do not make it a node" | **This replaces a denylist entirely — see below.** |
| "In licensed and industrial markets, certifications, operating authorities, equipment and software-in-use are the non-branded anchors" | Domain knowledge, and exactly what a new skill author replaces. |
| A barren term (zero verified companies after two searches) means the *term* is wrong more often than the market is empty | The most common failure mode off-vertical, and the skill is where the repair instruction belongs. |
| When to retract; when to stop | The two most editorial judgements in the product. |

### CODE — and why each one is allowed there

| Fact | Justification |
|---|---|
| Empty-200 (`bytes===0` or `<512` on a 200), content-mismatch (`.txt`/`.md` path or `text/*` declared, body starts `<html`/`<!doctype`), thin-render (200 with under 500 chars of extractable text) | **Transport truth, not web knowledge.** "Status codes lie" is a property of HTTP, not of Stripe. The same three lines caught Stripe's zero-byte 200 and the broker run's 400KB-of-HTML-for-a-txt. Each is correct for a law firm and a registrar. The tool **reports**; it never decides what to do next. |
| Timeouts: direct 8s, unlock 25s, browser 40s; per-mission 45s/90s/150s by tier | Resource policy, content-blind. The 25s unlock cap exists specifically to bound the measured 33–60s silent failure [M]. |
| Byte caps: store up to 4MB, return 8KB + a handle | Resource management. Applies identically to a PDF, a sitemap and a 6.4MB llms-full.txt [M]. |
| Circuit breaker: 2 strikes per `{host, mode}`, run-local | **Ships with zero entries.** Nothing is asserted about any site until this run watches it fail twice. Keying on `{host, mode}` rather than `{host}` is what reproduces the measured Stripe asymmetry — unlock refused, free GET still serving 65KB. |
| Per-host in-flight cap of 2; semaphores (unlock 4, browser 1, SERP 8, model 8) | One pathological host can never pin more than a third of the lanes. Provider rate limits are per account, not per agent. |
| Evidence mint: the URL must be in this run's store; the quote must be a literal substring of the stored bytes | A rule about the ledger, not about the world. It is what makes a hallucinated citation structurally impossible to commit. |
| Provenance tier stamped from handle origin: `snippet` / `page` / `own-material` | Derived from *where the bytes came from*, which the harness knows and the model could lie about. It drives the canvas's dashed-vs-solid rendering. |
| Dedupe/visited set; URL canonicalization (strip `www`, lowercase, public suffix); commutative merge on `key` | URL facts and ledger facts. |
| Budget: envelopes, tier allowances in dollars, reserve/settle/refund, `popAffordable` | The harness owns limits. The dollar numbers are config with the measurement that produced them written above each. |
| Bright Data `&brd_json=1`, `organic[]` parsing; Unlocker and Browser zone selection | Vendor API details, behind an interface. The core never names a vendor. |
| Model ids and prices | Not a fact about the web at all. |
| Streaming tool-call dispatch; NDJSON frame shapes | Plumbing. |

### The one thing deliberately absent from both columns

**There is no denylist, of aggregators or of anything else.** Not in code, not in the skill. One of the four candidate designs kept v1's named aggregator set (G2, Capterra, Thomasnet…) and argued it was correct because a "big domain / high SERP frequency" heuristic would nuke real vendors — which is true, and is also why the list has no degraded mode. That list must be maintained *per vertical*: Chambers and Martindale for law, Bankrate for banking, DAT and Kompass for freight, GlobalSpec for chemicals. On an unlisted vertical, the market's dominant directory becomes a top-degree company node in the middle of the map — and directory pages are the highest-inbound-link objects in exactly the markets that have no comparison blogs, so the false node lands in the most visible position on the graph.

The replacement is one sentence in the skill: *a page that enumerates many vendors is a document, not a company.* The model reads a Thomasnet category page and a G2 grid as the same object, opens it, and harvests it. There is no list to maintain and no vertical to add.

---

## The orchestrator

It is a `while` loop. Here is the whole thing:

```ts
const board  = new Board();       // priority queue + visited + breakers + map counters
const ledger = new Ledger(ceiling);// finish reserve carved at t=0
const lanes  = new Lanes(6);
const lead   = new Agent(SKILL, LEAD_TOOLS, `You are the LEAD. Target: ${domain}. Ceiling $${ceiling}. GO.`);

board.push(seedMission(domain));

while (!stopping || inflight.size) {
  // FILL — greedily, never waits
  while (!stopping && lanes.free() && ledger.spendable() > 0) {
    const m = board.popAffordable(ledger.spendable());   // argmax(priority) s.t. ALLOWANCE[tier] fits
    if (!m) break;
    inflight.set(lanes.take(), runInvestigator(m, ledger.reserve(ALLOWANCE[m.tier]), board));
  }
  // THINK — only when the lead's own condition is met
  if (!stopping && lead.idle && lead.due(board, clock)) {
    if (!ledger.affordTurn(lead.transcriptTokens())) { lead.closingTurn(); stopping = true; }
    else inflight.set("lead", lead.turn());              // streaming tool dispatch inside
  }
  // WAKE — on the FIRST landing of anything
  const done = await Promise.race([...inflight.values()]);
  inflight.delete(done.id); lanes.release(done.id); ledger.settle(done.claim, done.actualUsd);
}
```

**What it sees:** the board (priority, tier, dedupeKey, brief, why, claimed/unclaimed), which lanes are free, the ledger (spent, outstanding claims, spendable, finish reserve), the evidence-store index, the visited set, the breaker table, node/edge counters by kind and tier, the wall clock, and the lead's transcript token count. **It never sees page text and it never sees model output content.**

**What it decides:**
1. Which lane is free.
2. Which board item is the highest-priority one whose tier allowance still fits inside `spendable()`.
3. Whether an item's `dedupeKey` is already claimed (exact string match; no fuzzy similarity, because a similarity threshold silently deletes the model's ideas).
4. Whether a `{host, mode}` breaker has tripped.
5. Whether the lead's next turn is affordable, and whether the lead's stated re-entry condition is satisfied.
6. When to stop popping.

That is six decisions and every one of them is arithmetic or set membership.

**What it NEVER decides:** what the company sells. How to de-brand anything. What to search. Which URL is worth reading. Whether a result is a rival, a supplier, a substitute or noise. What a node kind or an edge type should be called. **What a priority is** — it performs `argmax` and nothing else: no aging, no decay, no recency bonus, no feature weights, no "boost items from the same host". Whether a reason is *good* (only that one exists and that its URL was really fetched). Whether the market is covered.

**The one line, precisely.** There is exactly one place where the harness's output departs from the lead's stated ordering: `popAffordable` skips an unaffordable expensive item to run a cheaper, lower-priority one. Three properties make that honest rather than a silent re-rank:

- It is **stated on screen every time it happens**, naming the item that was skipped and why.
- It is **reported in-band to the lead** on its next turn: *"your p84 dig was skipped 3 times for affordability; the pool no longer funds dig."* The lead can re-tier it to a `read`, or drop it.
- It **never reorders within a tier** and never promotes anything. It only ever scans downward.

The alternative — refusing everything below the cut, as a wave-shaped design must — throws away affordable cheap work that is sitting right there. That is v1's `exceeded() ? [] : missions` boolean wearing a nicer coat.

**The two priority bands.** The lead writes priorities **61–100**. Investigators, via `propose`, write **1–60**, and their items are marked `unreviewed`. This is deliberate and it fixes a real problem: six investigators scoring their own discoveries with no shared view produce numbers that are not comparable to each other, and if they land in the same band as the lead's the queue order becomes noise. Keeping worker proposals in a strictly lower band means everything above 60 was ranked by one context that had seen the whole map, and worker proposals get worked only when nothing better exists — or when the lead promotes them, which it did at t=46.3 in the Stripe run. An investigator that finds something genuinely picture-changing does not wait for the lead's schedule: it sets `wake:true` and the lead is thinking about it within a second.

---

## The agents

**Two agent types. One skill file with a shared doctrine section and two short role sections. The harness prefixes one line.** Swapping that file re-points the whole engine at a different domain — that is the "open" property, and it is one file, not a package.

There is deliberately **no separate probe, planner, cartographer, or reporter agent.** Orientation is the lead's first two turns. Planning is every lead turn. The closing narrative is `finish`, written by the context that watched the whole run. The three candidate designs that shipped a reporter were spending a reserved envelope on prose that the lead can already write for free — that reserve buys corroboration missions here instead, which is worth more.

### LEAD — exactly one per run

- **Given:** the skill (3,180 tokens), the target domain, the ceiling. Nothing else.
- **Tools:** `search`, `fetch`, `read`, `recall`, `remember`, `spawn`, `next`, `finish`.
- **Model:** `gemini-3-flash-preview` (0.50/3.00). Its transcript is re-sent every turn and is the only context that grows, so the input price is what matters. Measured against the Stripe run: 11 turns, ~160k cumulative input, **$0.10**.
- **Metered:** the harness reserves each turn's estimated cost from the transcript's exact token count *before* making the call. If the turn is unaffordable, the lead gets one free closing turn with free tools only. **The one agent whose spend is a fifth of the run is not exempt from the ledger.**
- **Returns:** nothing. The graph is the artifact. `finish(reason, summary, unresolved)` supplies the prose printed above the map.

### INVESTIGATOR — 0..6 in flight, continuously

- **Given:** the skill, one mission `{lens, brief, why, tier, seeds?}`, a hard dollar allowance, a wall deadline (45s `peek` / 90s `read` / 150s `dig`), a read-only slice of the map near its target, and the target's coinage list so it cannot re-search the brand.
- **Tools:** `search`, `fetch`, `read`, `recall`, `remember`, `propose`. **No `spawn`, no `next`, no `finish`.**
- **Model:** selected by the tier the lead chose — `gemini-3.1-flash-lite` for `peek`, `gemini-3.5-flash` for `read` and `dig`. **Model choice is exposed to the lead only as a cost word, never as a model id.**
- **Returns:** a digest of ≤120 tokens — `{status, added:{nodes,edges}, findings:string[3], spentUsd}` — which the lead sees on its next turn as one line on the board.
- **The load-bearing property:** an investigator's real output is the map, not its return value. It calls `remember` incrementally as it goes. A killed, timed-out or crashed investigator has already contributed everything it proved, the frontend has already drawn those nodes, and the digest degrades to `{status:"timeout", added:{…}}`. **Nothing is transactional and nothing is ever lost.**

**Depth is 1.** Investigators cannot spawn. They `propose`, into the lower priority band, and the lead decides. Unbounded recursion is exactly where "the model sizes its own work" becomes an unmeterable bill.

---

## The tools

Eight. Three are free and make no provider call. Every one returns failures as **data with a reason and a hint written as a sentence to a reader** — a tool never throws at a model, because a model told *"this host answers the unlock tier with an empty page"* adapts, and a model handed a stack trace retries.

| Tool | Signature | Who | On failure |
|---|---|---|---|
| `search` | `{queries[1..8], why, tier?}` → `{results:[{query, items:[{url,title,snippet,seen}], }], newUrls, spentUsd, poolLeftUsd}` | both | Per-query `{query, reason}` rows alongside the successes. Never throws. Never rewrites a query string. |
| `fetch` | `{urls[1..6], mode:"direct"\|"unlock"\|"browser", why}` → `{docs:[{url, ok, status, bytes, returnedBytes, truncated, kind, text(8KB), handle, links:[{href,text}], reason?, hint?}], spentUsd, poolLeftUsd}` | both | `ok:false` + `reason` (`empty-200`, `content-mismatch`, `thin-render`, `blocked`, `timeout`, `breaker-open`) + a plain-English `hint`. Calls exceeding 3s return `{status:"pending", handle}` so the caller is never stuck; the bytes land in the store and are read later for free. |
| `read` | `{handle, project?:"text"\|"headings"\|"links"\|"raw", grep?, range?}` → `{text, totalChars, matches?}` | both | **FREE, ~40ms, no provider call.** `{ok:false, reason:"no such handle in this run"}`. This is what turns 65KB into 684 bytes at zero cost and keeps an 880KB page out of every prompt. |
| `recall` | `{op:"find"\|"neighbors"\|"stats"\|"gaps"\|"barren"\|"unread"\|"board", …}` → compact rows | both | **FREE.** Empty rows, never an error. `gaps` = single-sourced nodes and thin reasons. `barren` = de-branded terms with zero verified companies after two searches. `unread` = harvestable pages nobody has opened. |
| `remember` | `{nodes?, edges?, retract?, why}` → `{added, merged, rejected:[{item, reason}]}` | both | **FREE.** The only writer. Rejects any item whose URL is not in this run's evidence store or whose quote is not a literal substring of the stored bytes, **and returns the rejection in-band with a sentence the model can act on.** Harness stamps the provenance tier. Merge is commutative on `key`, so concurrent writers are safe. `retract` is a claim like any other. |
| `spawn` | `{missions:[{lens, brief, why, priority:61-100, tier, dedupeKey, seeds?}], why}` → `{queued:[{i, allowanceUsd}], refused:[{i, reason}], poolLeftUsd}` | lead | **NON-BLOCKING — returns in ~1ms.** Missions are reserved in the lead's stated order as their JSON closes in the stream; a refusal names the item and the reason. |
| `propose` | `{missions:[{…, priority:1-60}], wake?}` → `{queued, deduped:[{dedupeKey, reason}]}` | investigator | Deduped by exact key against claimed items, reported back. `wake:true` clears the lead's `next` condition. |
| `next` / `finish` | `next({after:{landings?, seconds?}, why})` / `finish({reason, summary, unresolved[]})` | lead | `next` sets the lead's own re-entry condition; the harness also wakes it if the board runs dry or the budget floor is hit. `finish` ends the run. |

Every call carries a mandatory **`why: string`**. The harness renders it into the `progress` feed and stores it on the `trace` row next to `argsDigest`. **That is why there is always something readable on screen without the lead ever spending a turn on narration.**

The four NDJSON streams are unchanged from v1's frontend contract, with one substantive decision: the `round` field is populated with the **lead turn index** — a number a viewer can attach meaning to ("the lead has thought five times") — rather than an invisible internal counter or a fictional round number.

---

## Budget and termination

**One pool. Reserved before work. Sized per item. Reported on every return.**

At t=0 the ceiling splits: **finish reserve** = `max($0.12, 10%)`, **work pool** = the rest. Default $1.50 → $0.15 / $1.35. The finish reserve buys corroboration missions when the pool hits its floor — never prose — so a run cannot end with a map full of single-sourced nodes and no money to check them.

**Tier allowances (config; the measurement that produced each is written above it in the source):**

| Tier | Allowance | Typical actual | What it buys |
|---|---|---|---|
| `peek` | $0.03 | $0.008 | flash-lite, ~2 turns, one SERP or two free fetches. Verification and demotion. |
| `read` | $0.10 | $0.070 | gemini-3.5-flash, ~4 turns, ~29.5k cumulative in / 2.5k out, one SERP, two fetches. |
| `dig` | $0.25 | $0.161 | gemini-3.5-flash, ~7 turns, an unlock page ranged over with free reads. |

Allowances are **caps, not estimates**. Reserving generously and settling fast is strictly better than reserving tightly: an over-reservation costs milliseconds, an under-reservation costs a killed mission.

**Reservation, the whole algorithm:**

```
onSpawn(missions[]):                        // in the LEAD's order, streamed
  for m in missions:
    a = ALLOWANCE[m.tier]
    if a <= spendable():  queue(m, a); reserve(a)
    else: refuse(m, "the pool no longer funds a " + m.tier + "; re-tier it or drop it")

spendable() = pool - spent - outstandingClaims - finishReserve

onLaneFree():
  m = board.argmax(priority) where ALLOWANCE[m.tier] <= spendable()   // scan down, never up
  if skipped anything: emit a progress frame naming what was skipped and why
```

**Three properties that matter.**

1. **It is N-of-it, and it degrades rather than snapping.** As money runs out the run stops affording `dig`, then `read`, and keeps doing `peek` — with the transition stated on screen. v1's boolean could choose all the work or none.
2. **The lead's ordering is load-bearing and its tiering is too.** The lead never states a dollar figure. It states a priority order and a size per item, both things models are good at. The harness converts those into money.
3. **Every return carries `poolLeftUsd`** — including the free tools. The lead is told the price of its own verbosity on every turn.

**Inside a mission:** the allowance is a hard sub-ledger. At 80% the harness injects an in-band hint (*"$0.019 left — write down what you have"*); at 100% paid tools return `{ok:false, reason:"allowance spent"}` and the investigator degrades into *finishing* rather than dying. Overrun past 1.5× the claim aborts at the next tool boundary; everything already written stands. Unspent allowance returns to the pool on landing, within milliseconds, which is what lets an early-finishing mission fund the next one.

**The lead is metered like everything else.** Before each turn the harness computes the exact input cost from the transcript's token count and reserves it. This is the single biggest correction to the shape this design inherits: an orchestrator that is a model conversation, with a 24-turn cap and a quadratic transcript, can otherwise spend a whole ceiling on itself without ever calling a paid tool. Here it cannot: an unaffordable turn is refused and the lead gets one free closing turn instead. The turn cap of 24 is then honestly what it claims to be — **a loop detector, not a budget.**

### Every way a run ends

Each emits `{kind:"terminated", reason, humanReason, atSec, spentUsd, nodes, edges, residue[]}`, and the UI prints `humanReason` as one sentence above the map. **All seven produce a complete, renderable artifact**, because `remember` writes to the store immediately and the frontend has already drawn every node. There is no terminal graph blob.

1. **`lead-finished`** — the intended ending, and both walkthroughs above. The lead's own `summary` and `unresolved[]` print verbatim. *"The lead stopped: the remaining gaps need a phone call, not a search."*
2. **`budget-floor`** — `spendable() < ALLOWANCE.peek`. Popping halts, lanes drain, the lead gets one free turn to close and to say what it would have done next. *"Out of budget at $1.50. The map below is what $1.50 bought, and here are the eleven questions it did not reach."*
3. **`wall-clock`** — 300s default. At 255s an in-band note: *"45 seconds left; call finish."* At 300s popping halts and in-flight missions drain with a 30s grace. At 330s hard cancel; partial writes stand and the frame says how many were cut off.
4. **`turn-cap`** — the lead exceeded 24 turns. Fires rarely; when it does it is a skill bug and should be loud.
5. **`lead-fault`** — the lead crashed, or returned malformed tool arguments twice in a row, or the model API failed twice. The blast radius is **one turn of planning**; every landed mission stands.
6. **`stillborn`** — inside the first 30 seconds, no page on the seed host is readable at any mode *and* the identification SERP returned nothing. Costs under $0.03. *"Nothing at this domain could be read; there is no map to build from here."* Far better than a $1.50 run that produces four nodes.
7. **`client-disconnect`** — the reader closed the tab. AbortSignal propagates into every in-flight fetch and mission; the terminal frame is written to the run log.

**Residue** — every unreached board item with the lead's own priority and reason — ships on every ending. It converts a truncated run from *"we ran out"* into *"here is precisely what we would have done next, ranked."*

**Deliberately not shipped: an enforced convergence floor.** A yield threshold (`newNodes / missions < floor`) is the only stop condition that reflects the territory rather than the wallet, and it is also a tuned number that fires early on a sparse market and never on a dense one. The harness **measures** it and shows the lead the curve — *"the last six landings produced 2 new companies; the six before that produced 14"* — and lets the lead draw the conclusion. One of the four candidate designs let the harness override the model's `done:false` on a 15% yield floor. That is the harness deciding whether a market is mapped, which is the single most editorial judgement in the product and one the author decided belongs to the model. Shipping it as an enforced condition later costs one config flag rather than a redesign.

---

## Speed

**Measured inputs [M]:** plain GET of llms.txt 0.3–0.9s, $0; Bright Data SERP with `&brd_json=1` ~1.5–2.5s for ~28KB; Unlocker 13–16s for 800–900KB; Stripe's silent unlock failure 33–60s (capped at 25s). **Assumed [A]:** flash-tier first token 0.8–1.5s, sustained ~140 tok/s. Model latency is the softest number in this document and I will not pretend otherwise.

| Milestone | stripe.com | logistics broker | Where the number comes from |
|---|---|---|---|
| **First pixel** | **0.12s** | **0.12s** | Harness-emitted `progress` + `cost` frames written synchronously on request acceptance. Zero model calls, zero provider calls. Bounded by HTTP response start. |
| **First trace row with reasoning on it** | **2.6s** | **2.5s** | One lead turn: 3.2k skill in, ~200 tokens of tool call out, dispatched the instant the arguments close [A]. |
| **First bytes bought** | **3.3s** | **3.0s** | Direct GET, 8s cap, typically sub-second [M]. |
| **First nodes on the map** | **5.8s** | **14.2s** | A: the 8KB slice already carries the summary and fifteen headings, so `remember` rides in the same turn as the free heading projection. B: no shortcut — four more free page fetches (0.9s) plus one extra read turn (~7s [A]). **The 8.4s gap is the entire cost of generality.** |
| **First de-branded query on the wire** | **10.6s** | **19.4s** | Streaming mission dispatch: mission 1 hits a lane while mission 9 is still being written. Without it, both numbers are ~5s later. |
| **USABLE MAP** | **48s** | **62s** | 24 companies / 89 edges and 31 companies / 74 edges respectively. Six lanes draining continuously at ~1.5–3s between landings. |
| **DONE** | **152s** | **166s** | 20 and 19 missions, both ending on `lead-finished`. |
| **Hard wall clock** | **300s** | **300s** | Config. Warning injected at 255s, hard cancel at 330s. |

**Three things buy the speed, and one thing gives it back.**

1. **Stripe's 25-second unlock failure costs zero wall-clock seconds**, because it is one outstanding fetch while six lanes work through it. In a design with a round barrier it sets that round's floor at 25 seconds for every idle worker in it. Over a run with three or four such calls that is 45–80 seconds on a 150-second run.
2. **Re-reading and re-projecting fetched bytes is free and instant.** The 65KB → 684 byte projection at t=5.8s is a store read: 40ms, no provider call, no dollars. A design without an evidence store pays 13–16s and a fresh Unlocker call to look at the same page a second way.
3. **Failures are capped below their natural duration**, and learned once. 25s instead of a measured 33–60s, and the `{host, mode}` breaker means it never costs that again in this run.
4. **Given back honestly:** at a $1.50 ceiling the run is **money-bound, not lane-bound.** Twenty missions averaging 22 seconds is ~440 lane-seconds against 152s × 6 lanes = 912 available. Utilization is about 48%. **Six lanes exist so that a 25-second unlock call never stalls anything, not because six are needed continuously.** Raising the ceiling raises utilization before it raises wall clock. Any design claiming both a no-barrier throughput number *and* a $1.50 ceiling is claiming to buy more investigation than its budget allows.

---

## What can go wrong and what happens

**The governing rule: a tool never throws at a model.** Every failure returns as data with a `reason` and a `hint` written as a sentence.

**Silent 200s.** `fetch` sniffs the body, not the status. `bytes === 0` or `< 512` on a 200 → `{ok:false, reason:"empty-200", hint:"this host answers this transport with an empty page; its own published summary or SERP snippets may be the only route in"}`. Two strikes on `{host, mode}` and that pair is refused for the rest of the run in ~0ms, in words, **while other modes on the same host keep working** — which is exactly the measured Stripe asymmetry [M]. The breaker table ships empty and dies with the run.

**Soft-404s.** A body requested at a `.txt`/`.md`/`.json` path, or declaring `text/plain`, whose first 200 bytes contain `<html` or `<!doctype` → `{ok:false, reason:"content-mismatch"}`. Caught vercel's 487KB-of-HTML case [M] and the broker run's aggregator. One code path, no site names. Refusing to implement this — as one candidate design did, on generality grounds — means a soft-404's boilerplate can be quoted into a `tier:"page"` edge that passes the mint function, because the mint checks the quote and not the page.

**Thin renders.** 200 with under 500 characters of extractable text → `{ok:false, reason:"thin-render"}`. The model may escalate; the code never escalates on its own, because auto-escalation on Stripe means 25 wasted seconds on every fetch.

**Oversized bodies.** Stored up to 4MB, returned as 8KB plus `{bytes, truncated:true, handle}`. The model asks for more by `range`, `grep` or `project`, **and those follow-up reads are free and instant.** Heading extraction is never automatic: the Adyen measurement (615KB → 5 useless headings [M]) proves an automatic parser destroys signal, so it is an option the model elects with the counter-example in front of it.

**Blocked, gated, paywalled.** Direct fails → the model may elect `unlock` → one escalation to `browser`. If all fail, the investigator gets the hint and pivots to SERP snippets, third-party writeups, or the vendor's own careers page. The broker run's load-board lens found everything behind auth, spent $0.011, and reported *"the poster lists are behind login; this lens is closed."* **A cheap, honest dead end reported in one line is a good outcome**, and the lead never funds that lens again.

**A dead investigator.** Every mission is wrapped. A model 5xx, a malformed tool call, a JSON parse failure, an OOM — all become `{ok:false, error}`. The lane releases, the claim settles at actuals, the failure is pushed onto the board as a **fact the lead reads on its next turn**, and the difference between *"found nothing"* and *"never ran"* is preserved. (v1 had five registered prompts that never executed and nobody noticed; here a mission that did not run is a visible line item.) One dead investigator out of six is a slightly smaller minute, not a broken run. A watchdog force-releases any lane more than 2× past its deadline.

**Budget exhaustion mid-run.** There is no wave to be exhausted in the middle of. Tiers degrade: `dig` becomes unaffordable, then `read`, then `peek`, each transition named on screen. At `spendable() < ALLOWANCE.peek` popping halts, lanes drain, and the finish reserve funds corroboration. If that too is spent, the lead gets one free turn with free tools to call `finish`; if it does not, the harness terminates with `budget-floor` and emits the map.

**Rejected evidence.** `remember` returns `rejected:[{item, reason:"the quote is not a substring of anything fetched from that URL"}]` and the model fixes it next turn. This is a *frequent* soft failure, not an exceptional one — the literal-substring requirement will bounce legitimate findings that are stated across two sentences or split by an HTML tag the extractor collapsed differently. It is a known tax, chosen over the known lie of synthesized citations.

**A wrong de-branding.** The correlated failure this shape is most exposed to: one lead frames the market at t≈6s and twenty missions inherit it. Two partial defences, both real. `recall({op:"barren"})` surfaces terms that produced nothing after two searches, and the skill's default reading is that the *term* is wrong — the broker run repaired "final mile" into "residential appointment delivery of oversized freight" and six companies appeared. And `remember({retract})` means a wrong conclusion can be deleted rather than only diluted. Neither is a full fix; see the open questions.

**Nothing is resumable.** Fresh map per request is a decided constraint. A reload replays the event log and the map rebuilds, because nodes and edges were emitted as deltas rather than as one terminal blob. In-flight missions are not checkpointed. Shipping no resume is better than shipping a positional one that silently skips work.

---

## Why this and not the others

The four judges did not agree, and the disagreement is the most useful information in the pile. Speed ranked **Sprint & Ink** first and **Volley** last. Agency ranked **The Board** first and **Volley** last. Legibility ranked **Lead + Spawn** first and **The Board** last. Generality ranked **Volley** first and **Sprint & Ink** last. Only one design is top-two on three criteria and never below 7: **Lead + Spawn**. That is the shape here — and every judge's fatal-flaw finding against it has been fixed rather than argued with.

**Design 1 — Lead + Spawn.** Better at: one voice, one story, a mandatory `why` on every tool call next to `argsDigest`, and the most literal match to *"give Claude a skill and just be like GO."* Its `lens: string` type decision and its zero-denylist runtime-learned host flags are both correct and both taken here wholesale. It lost as written on two specifics. `spawn` blocked until every funded mission returned, which froze the only strategic context for 60–75 seconds at a stretch and left the lead deciding during 5% of the run — the agency judge called that number the indictment rather than the achievement. And its lead's own inference was never reserved before work: at its stated 22-turn cost of $0.25 and a 40-turn cap, quadratic transcript growth lets the orchestrator alone consume the entire default ceiling with zero investigators funded. **Both are fixed here: `spawn` returns in a millisecond, the lead sets its own re-entry condition, and every lead turn is reserved from the same pool as everything else.** Also grafted: `remember`'s mint function, the free `recall(gaps)`, the runtime host flags, and the seven-way named termination set.

**Design 2 — Volley.** Better at: the cleanest statement of why non-software markets work — *"the comparison page is a directory, a registry, a member list, an exhibitor list, an approved-supplier list, or a job board"* — and the sharpest framing of the thesis, that de-branding is only the *technique* and finding the buyer's words is the *goal*, so a company with zero coinages is not a broken case. It also deleted v1's `angle` enum and said why. All of that knowledge is in the skill here. It lost on shape: a counted loop with `wave++` and `MAX_WAVES = 6` is v1's round literals parameterized rather than removed, its planner was a slot-filler with no write tool and no ability to check a hunch, and — decisively — `harness.saturated()` could override the model's `done:false` on a tuned 15% yield floor, which is the harness deciding whether a market is mapped. Its per-investigator cost arithmetic was the only one of the four that survived checking, and **this design's cost model is built on it**: $0.070 for a `read` mission, not the $0.02 three of the four claimed.

**Design 3 — The Board.** Better at: the strongest structural anti-hardcoding argument anywhere — with no stages, there is no place in the harness to write "first llms.txt, then docs" — plus continuous greedy scheduling, per-`{host, mode}` circuit breaking, per-host in-flight caps, `popAffordable` degrading instead of snapping, and residue as the ending artifact. **All six of those are in this design.** It lost on legibility and on arithmetic. Eight independent lanes with no lead multiplex the trace stream into eight unrelated stories, and its headline visual — a queue sorted by priority — is sorted by a number the design itself concedes is incommensurable across the workers who wrote it. **That is fixed here by the two priority bands: everything above 60 was written by one context that saw the whole map.** And its throughput was priced at roughly a quarter of true cost: 130 items at a $1.50 ceiling is $4+ of work, so its map would have been a third the claimed size. **This design states its utilization honestly instead — at the default ceiling it is money-bound, and the lanes are sized for tail latency.**

**Design 4 — Sprint & Ink.** Better at: the fastest honest path to a readable map, and three ideas taken here outright. **`probe`/`fetch` returning same-host links with their anchor text as a first-class field** — a site's own navigation is the universal machine-readable summary and llms.txt is a shortcut on the same road, which is the single best generality mechanism in any of the four. **Harness-stamped provenance tiers rendered as a visual property**, so the map itself shows how much of what you are looking at has actually been read. **`remember({retract})` flowing through the same mint as every other write**, the only mechanism in any of the four that lets a run delete its own upstream conclusion — plus `recall({barren})` as the trigger for the specific error that hurts most off-vertical. And **the streaming-plan idea**, generalized here into streaming tool-call dispatch. It lost on shape and on one item. Its Phase 1 is a fixed four-beat pipeline whose 50 seconds set the entire epistemic frame — the exact thing the author said they disliked, even at 4% of budget — and its Cartographer could only speak in six line-kinds the router's switch knew, which is an enum one level up from the one it deleted. And its per-vertical aggregator denylist has no degraded mode: **there is no denylist anywhere in this design, and the sentence that replaces it is in the skill.**

---

## What this is NOT

**Not a stage list.** There is no `orient` stage, no `expand` stage, no `verify` stage, and there are no `round: 2` literals anywhere. The `round` field in the NDJSON frames is the lead's turn index, which is a number a viewer can attach meaning to. The sequence of a run is whatever the lead decides next, and the two walkthroughs above took genuinely different paths through byte-identical code.

**Not a prompt blowup.** v1's documented 41k → 447k token growth came from pushing the whole candidate table and the docs corpus into the prompt every turn. The rule here is: **nothing enters a context that the agent did not ask for by name.** `fetch` returns 8KB plus a handle. `read` and `recall` are free and pull exactly the slice requested. `spawn` returns funding decisions, not results. Mission digests are capped at 120 tokens. The lead's transcript peaks at ~22k tokens on a 63-node map — 2% of a 1M window — and it scales with *turns*, not with map size.

**Not an all-or-nothing budget gate.** `exceeded() ? [] : missions` is replaced by two mechanisms: reservation in the lead's own order at spawn time, and `popAffordable` scanning down at lane-fill time. A run degrades `dig → read → peek` and says so on screen. It never chooses between all the work and none of it.

**Not a free-for-all.** Investigators cannot spawn. Depth is 1 and the model does not vote on it. Every mission has a dollar allowance and a wall deadline, and the lead itself is metered per turn.

**Not a denylist, a query template library, or a per-vertical maintained list of anything.** Zero query templates in the codebase; `search` buys the literal string the model wrote. Zero hosts named anywhere. The circuit breaker ships empty.

**Not a workflow framework.** The control flow is one cycle — model turn, dispatch tool calls concurrently, append results, repeat — with a queue and a pool beside it. Expressed as a state graph that is two nodes and one conditional edge. There is no topology to declare, no reducer to reduce across nodes, no checkpointing wanted (fresh map per request is decided), and routing in code is the thing this project exists to stop doing. **The specific scar matters more than the argument:** v1's LangGraph was 647 lines with the correct cycle, tested, argued for in its commit message, and never imported by production — blocked by a `"use step"` sandbox where global `fetch` was unavailable and a step closing over a live `CostTracker` died with *"Failed to serialize step arguments."* The ledger, board, evidence store, breaker table and streams here are five live mutable objects held in one function's closure for the whole run. **There is no serialization boundary, so that class of failure cannot recur.**

**Not built-and-never-wired.** This is the failure mode that killed v1 twice — a graph that was never imported, and five registered prompts that never executed. Three properties make it hard to repeat here:

- **The orchestration proper is ~350 lines and it is printed in full in this document.** There is one loop, and if it runs at all it runs the design.
- **There is no second implementation.** The investigator runner *is* the lead loop with a different tool set and a different system line — 0 additional lines.
- **Every branch is exercised on every run.** There is no fallback planner, no veto-once path, no baton-pass module, no budget-raise hook, no resume path. The rarely-fired-branch surface is the seven termination reasons, of which one fires per run and each is one frame.

| Module | LOC | |
|---|---:|---|
| lead loop (turn, streaming dispatch, `next` condition, turn metering, turn cap) | 140 | |
| board (queue, `popAffordable`, dedupe, priority bands, breakers) | 110 | |
| lanes + semaphores + per-host cap + watchdog | 60 | |
| ledger (reserve/settle/refund, tiers, finish reserve, lead metering) | 100 | |
| evidence store + mint + tier stamping | 120 | |
| map store (commutative merge, retract, find/neighbors/stats/gaps/barren/unread) | 130 | |
| `fetch` (modes, timeouts, three sniffers, anchor-text links, projections, cache) | 150 | |
| `search` | 60 | |
| `read`/`recall`/`remember`/`spawn`/`propose`/`next`/`finish` wrappers | 90 | |
| NDJSON streams (four namespaces, non-finite `usd` deliberately dropped) | 80 | |
| investigator runner | **0** | same loop as the lead |
| **Total** | **~1,040** | plus ~180 lines of provider adapters behind interfaces |

**Orchestration proper — loop, board, ledger — is ~350 lines.** v1's `buildWorkflow` was 1,086 lines in one function.

---

## Open questions for the author

**1. Does the run get a second, independent orientation?**
The single-lead shape has one correlated failure and it is the big one: the lead de-brands the target at t≈6s and every mission inherits it. If it reads Connect as "payment links" rather than "multiparty split settlement," fifteen investigations are confidently wrong together. A pool of independent contexts gets diversity for free; this shape does not. Two ways to buy some back, and they cost differently. **(a)** One extra lead-tier read at t≈8s on *independent* material — SERP snippets and third-party writeups about the company, deliberately not the company's own words — diffed against the first framing. Costs ~$0.03 and ~6 seconds, catches the mis-frame before any mission is funded. **(b)** Nothing, and rely on `recall({barren})` plus retraction to catch it at t≈90s, after twelve missions have already been bought on the wrong frame. Related and worth deciding at the same time: should the lead run on `gemini-3-flash-preview` at $0.10 a run, or on `gemini-3.1-pro-preview` at roughly $0.40 — a third of the default ceiling — on the argument that the de-branding turn is the highest-leverage decision in the whole system? I lean (a) plus flash, because a cheap diff beats an expensive single opinion. But the diff is real code and it is a genuine fork.

**2. Can an investigator retract another agent's node, or only the lead?**
Investigator retraction is faster and catches the error at the point of discovery: the verification peek that opens a candidate's site and finds it sells KYC rather than fraud scoring is exactly the context that should be allowed to say so. Lead-only retraction keeps one editor, and avoids two workers flipping the same node in opposite directions inside the same second. My lean is asymmetric — an investigator may retract only with counter-evidence that passes the mint (a quote from a page it fetched that contradicts the claim), and the lead may retract freely on judgement — but that is two code paths where one would do, and reasonable people would ship either.

**3. What should the default ceiling be, and what is the demo?**
$1.50 buys ~150 seconds, ~20 missions and ~44 companies, and utilization is about 48% — the run is money-bound, and lanes idle between bursts. $3.00 buys ~40 missions and roughly double the companies at ~4 minutes, with lanes closer to saturated and a denser map. The first is watchable in one take and is the better artifact for the demo the author asked to build first. The second is the better product. This changes the tier allowances, the lane count, and whether the finish reserve is worth 10% or 20%, so it is worth answering before the ledger is written rather than after.

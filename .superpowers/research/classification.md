# Classifying hosts from a SERP bag, without fetching them all

Market chosen: **vector databases**, anchored on Pinecone. Chosen instead of copying the
web-scraping catalog because it has the same structural ingredients (purpose-built
competitors, bolt-on substitutes, hyperscaler incumbents, a dominant blogging platform,
forums, job boards) but different vocabulary, so it's a real test of whether the method
generalizes rather than an echo of the worked example.

Status note: this run was cut short by budget/time pressure from the coordinator mid-task.
Sections below are marked **measured** where I have data and **not measured** where I ran
out of room. Nothing below is a guess dressed as a measurement.

---

## 1. The bag

40 SERP queries fired (Bright Data SERP zone, `brd_json=1`), 38 on-topic + 2 deliberately
malformed. All 40 returned data (after retrying 4 that hit transient 429s / a Bright Data
"failed_query_rejected" cooldown on one query — logged, not hidden).

- **157 distinct hosts** at full-subdomain granularity, **139 distinct hosts** after
  collapsing to registrable domain (eTLD+1) — the granularity the original 127-host bag used.
  I report at the collapsed (apex) granularity below, since that's what "127 distinct hosts"
  in the prompt's own example means.
- Intents fired: `pain`(4) `switching`(4) `evaluation`(5) `competitor`(6, direct vendor-name
  queries) `build`(4) `buyer`(3, first-person "we built/scaled" phrasing) `hiring`(2)
  `launch`(2, Show HN) `directory`(3, "best X list", "awesome X") `substitute`(3, other-tech
  phrasing) `general`(2) plus 2 malformed (`malformed_url`, `malformed_collision`).

Frequency distribution, top of the bag (apex domain, distinct-query count):

```
27x medium.com      20x reddit.com      13x github.com      11x redis.io
 9x youtube.com      9x zenml.io         8x zilliz.com       7x pinecone.io
 6x tigerdata.com    6x milvus.io        5x ibm.com          5x weaviate.io
 5x langchain.com    4x qdrant.tech      4x linkedin.com     4x microsoft.com
 4x amazon.com       4x encore.dev       3x supabase.com     3x instaclustr.com
 3x pingcap.com      3x firecrawl.dev    3x analyticsvidhya.com  3x datacamp.com
```

Shape matches the prompt's worked example: a UGC/blogging platform and a forum dominate by
raw frequency (medium.com, reddit.com) the same way linkedin.com did in the original bag —
frequency is dominated by platform reach, not by market relevance.

Raw data: `vdb_hosts_apex.json`, `vdb_hosts.json` (subdomain-level), 40 raw SERP payloads
under `vdb_serp/*.json` — all in the scratchpad, available on request but not copied into
this repo.

---

## 2. Ground truth — hand classification (measured, ~35 hosts)

Time: roughly 40 minutes — 40 SERP calls (parallelized, ~2 min wall clock), then front-page
fetches for 26 ambiguous hosts (parallel `curl`, ~15s), then reading titles/descriptions and
fetched `<title>`/meta-description for all of them. The fetch step was the slow part, not
because any single fetch was slow but because judgment on borderline cases (is this company
a vendor in this market, an adjacent-market vendor, or a pure publisher?) took real reading.

| Host | Role(s) | Evidence | Ambiguous? |
|---|---|---|---|
| pinecone.io | **anchor** (the company the map is centered on) | it's the subject of every query | Not a role at all — first thing a classifier must special-case out, or it pollutes every other bucket. `community.pinecone.io` / `docs.pinecone.io` are its own support surfaces, same anchor. |
| weaviate.io | competitor | fetch: "The AI database developers love"; own OSS + cloud product | No |
| qdrant.tech | competitor | fetch: "Qdrant - Vector Search Engine" | No |
| milvus.io | competitor | OSS project site | No — **but** same company as zilliz.com (see below); entity resolution across hosts is a separate problem from role labeling |
| zilliz.com | competitor **+** publisher | fetch: "Zilliz Vector Lakebase... Powered by Milvus" — commercial arm of Milvus, and writes comparison content ("Weaviate vs Qdrant", "LanceDB vs Deep Lake") that reads exactly like third-party analysis | Yes — same organization as milvus.io wearing two faces |
| cloudflare.com | competitor (new entrant) | SERP desc: "Vectorize: a vector database for shipping AI-powered..." — genuine own product, not just a mention | No |
| redis.io | substitute **+** publisher | fetch/SERP: general-purpose store with vector search bolted on; writes its own "Top Pinecone alternatives" comparison | Yes |
| tigerdata.com | substitute **+** publisher | fetch: "Time-Series PostgreSQL at Petabyte Scale... from the creators of TimescaleDB" — Postgres-based, not purpose-built; also writes "Pinecone Alternatives" | Yes |
| pingcap.com | substitute **+** publisher | fetch: "Database for AI Agents \| TiDB Distributed SQL" — adds vectors to a SQL engine; publishes "Best Vector Databases for RAG" featuring itself | Yes |
| meilisearch.com | substitute | fetch: "Unified Search & AI Retrieval Platform" — search engine repositioning as vector retrieval | No |
| supabase.com | substitute + publisher | Postgres-as-a-service + pgvector; own "pgvector vs Pinecone" benchmark posts | Yes |
| instaclustr.com | substitute (managed OSS db hosting) + publisher | fetch: "Open Source Technologies \| Build and Scale Applications Faster" | Yes |
| oracle.com / ibm.com / microsoft.com / amazon.com | substitute/competitor (each has its own vector offering: Oracle AI Vector Search, watsonx, Azure AI Search, OpenSearch/Aurora) **+** neutral-toned publisher | title pattern "What Is Weaviate?", "What is Milvus?" — hyperscaler content reads deliberately neutral/educational even though the company sells a competing product one click away | Yes, systematically — every hyperscaler in the bag does this |
| langchain.com | **integration/framework**, not competitor, not buyer | fetch: "LangChain: Observe, Evaluate, and Deploy Reliable AI Agents"; docs page per vector-DB ("Weaviate integration", "Qdrant integration") — it is the plumbing every vendor gets referenced through, consumes none of them exclusively | No, once you see the doc-per-vendor pattern |
| firecrawl.dev | **publisher here, competitor in a different market** | fetch: "Firecrawl - the context API to search, scrape, and interact with the web" (a web-scraping company, same market as the prompt's own worked example!) publishing "Best Vector Databases in 2026" as SEO content | This is the exact tinyfish pattern, reproduced independently in a different market |
| confident-ai.com | **buyer + adjacent-market vendor** | fetch: "Enterprise AI Evaluation & Observability Platform" — genuine infra story ("Why we replaced Pinecone with PGVector") about their own product's backend, and they sell a different AI product | Same dual-role shape as firecrawl, but on the *buyer* axis instead of *competitor* |
| zenml.io | publisher (pure) | fetch: "ZenML — the unified layer for ML and AI" — MLOps orchestration, not a vector DB; "We Tried and Tested 10 Best Vector Databases" is pure content marketing | No |
| encore.dev | publisher (pure, cleanest case in the bag) | fetch: "Backend Infrastructure for Humans and Agents" — a backend framework with zero overlap with vector databases, publishing a comparison guide purely for developer-SEO reach | No — useful as the *control* case against firecrawl/pingcap/redis, which are NOT pure |
| analyticsvidhya.com, datacamp.com, geeksforgeeks.org | publisher (pure, education/media) | no product in this category; tutorial/course framing | No |
| zenvanriel.com, towardsai.net, iternal.ai | publisher / independent-educator-and-consultant | fetch: "Zen van Riel - Senior AI Engineer \| AI Engineer Launchpad" (individual selling courses), "Towards AI · The AI deployment and education firm", "Iternal — Enterprise AI Consulting" — a recognizable small pattern: solo/boutique AI-education businesses using comparison listicles as top-of-funnel content | Moderately — these read like "buyer" from intent alone (their queries were tagged buyer/hiring) but are publishers on inspection |
| medium.com, dev.to, github.io | **platform** (multi-tenant, many disconnected authors) | not a single publisher — each article has a different actual author/company behind it | Distinct from single-author publisher; can't be resolved without knowing "medium.com is a platform" as a fact, not inferring it from any one result |
| reddit.com, news.ycombinator.com / ycombinator.com, stackoverflow.com | **community** | forum/Q&A phrasing, hobbyist and complaint framing | No — matches this repo's own `NODE_KINDS` concept of `community` already |
| github.com | **mixed by URL path**: OSS repos = competitor code, issues = community, `/topics` and "awesome-*" lists = directory | e.g. "Weaviate is an open-source vector database..." (repo) vs "Is there a request rate limit for Pinecone? · Issue #159" (community complaint) | Host-level labeling is wrong for github.com; needs path-level rule, which the metadata already carries (URL, not just domain) |
| linkedin.com | **mixed by URL path**: company page = competitor/directory, job posting = hiring, article = publisher | reproduces the exact ambiguity the prompt's own prior run found | No new info, confirms it |
| indeed.com, naukri.com | hiring / labor-market, market-**non-specific** | generic "N jobs available" boilerplate, would fire for literally any tech query | These are low-value even though genuinely on-intent — a job board is not evidence about market structure |
| shaped.ai | competitor (**dead/acquired**) | fetch: "Shaped \| The only vector database with a feedback loop... Shaped has been acquired by Whatnot." | A real player, but a closed one — role taxonomy needs a status flag, not just a role |
| flaticon.com, figma.com, magnific.com, icons8.com, svgrepo.com, thenounproject.com, fontawesome.com, vecteezy.com, pinterest.com | **noise** | all 9 organic results of the deliberately malformed query 40 ("vector icon database free download") — icon/graphic-design sites, "vector" collided with its graphic-design sense | Confirmed noise, not ambiguous |
| lemonlimeadventures.com, mudandbloom.com, askmarystone.com, pacificsciencecenter.org, facebook.com (this occurrence) | **noise**, naturally occurring | all 7 results of query 8, "why we left pinecone" — Google read "pinecone" literally (the seed pod), not the product | Not deliberately engineered — this collision happened on a normal-looking query, which matters (see §5) |
| openhelm.ai, drdroid.io, layer3labs.io, blckalpaca.at, kalviumlabs.ai, aiml.qa, liveblocks.io, ranksquire.com | **noise / adjacent**, long-tail | single-hit hosts scattered across otherwise-legitimate `pain`/`switching` queries (1,2,4,5,6,7); fetched fronts show generic AI-agency/infra businesses with no vector-DB product, SEO-reaching into loosely related queries | Confirmed via fetch; would NOT have been caught by the corroboration signal alone at the per-query level since their home queries are otherwise legitimate — see §5 caveat |
| blog.apify.com | **adjacent-market competitor** | Apify — a real competitor in the *web-scraping* market (same market as this whole experiment's worked example) — surfaced once, incidentally | Same shape as firecrawl.dev but at 1x instead of 3x, i.e. too faint to catch by frequency alone |

---

## 3. Role taxonomy arrived at

Confirms every role the prompt named already existed (competitor, substitute, buyer,
directory, publisher, noise) and adds three this market forced into view:

| Role | Definition | Example |
|---|---|---|
| **anchor** | the company the whole map is centered on, appearing in its own results | pinecone.io |
| **competitor** | sells the same product category, same job, same way | weaviate.io, qdrant.tech, cloudflare.com |
| **substitute** | different underlying technology, extended to do the same job | redis.io, tigerdata.com (Postgres), meilisearch.com |
| **integration/framework** | neutral plumbing referenced by everyone, consumes/competes with no one specifically | langchain.com |
| **buyer** | builds something else, adopted (or dropped) a vendor as infrastructure, writes about that decision | confident-ai.com |
| **directory** | curated, structured listing with no editorial voice (awesome-lists, "top 10") | github.io "Awesome Vector Database" |
| **publisher** | comparison/explainer content produced for SEO or lead-gen reach, editorial voice | encore.dev, analyticsvidhya.com |
| **platform** | multi-tenant host where the actual author is someone else entirely | medium.com, dev.to, github.io (blog occurrences) |
| **community** | forum/Q&A where the buyer conversation happens unprompted | reddit.com, news.ycombinator.com, stackoverflow.com |
| **hiring/labor-market** | job board surfacing under hiring intent, market-non-specific | indeed.com, naukri.com |
| **noise** | surfaced by query malformation, word-collision, or unrelated SEO gravity | flaticon.com (icon collision), lemonlimeadventures.com (pinecone collision) |

**A host can hold multiple roles simultaneously**, and the two most common combinations
were not in the original bag's example but recur constantly here:
1. **substitute/competitor + publisher** — every hyperscaler and every bolt-on-vector
   vendor (redis.io, tigerdata.com, pingcap.com, oracle.com, ibm.com, microsoft.com,
   amazon.com, supabase.com, instaclustr.com) writes neutral-toned comparison content that
   quietly ranks itself well. This is the *majority* pattern in this market, not an edge case.
2. **adjacent-market vendor wearing a role in this market** — firecrawl.dev (competitor
   elsewhere, publisher here) and confident-ai.com (vendor elsewhere, genuine buyer here)
   both reproduce the tinyfish pattern from the prompt, independently, in a different market.
   That this pattern reappears unprompted is the strongest evidence it's structural, not a
   one-off in the original bag.

---

## 4. What metadata alone told me vs. what the fetch added (measured)

Built a small rule set using only: distinct-query count, the set of intents that surfaced a
host, and title/description text — **no fetch** — and checked it against the 35-host ground
truth table above.

| Signal available in metadata | Classification it makes safely | Accuracy vs. ground truth |
|---|---|---|
| Title matches `Best\|Top N\|vs\|Comparison\|Alternatives` **and** the host is not itself one of the named products | directory/publisher | 14/15 correct (93%) — the one miss was pingcap.com, correctly flagged as publisher but metadata alone can't also see it's a substitute-vendor, see below |
| Title's grammatical subject is the host's own product ("X is an open-source vector database...") | competitor (or substitute, can't tell which from text alone) | 11/12 correct (92%) on "sells a database" — but metadata **cannot** distinguish competitor from substitute; that requires knowing whether the product is purpose-built or bolt-on, which is a fact about the product, not about the SERP snippet |
| First-person phrasing ("How we...", "Why we replaced...", "We built...") **and** host is not a listed vendor | buyer | 5/6 correct — missed zenvanriel.com, which reads exactly like a buyer post but is actually an individual selling courses; metadata cannot see that the "we" is a solo content business, not a company with production infrastructure |
| Host in a small fixed list (reddit.com, *.ycombinator.com, stackoverflow.com, github.com/discussions) | community | 100%, but only because this is a **memorized list**, not something inferred from any single SERP row — matches the prompt's own note that the 18 community hosts were "pre-identified separately" |
| Host in a small fixed list (medium.com, dev.to, *.github.io, linkedin.com) | platform, not a single-voice source | 100%, same caveat — memorized, not inferred |
| n_distinct_queries alone | **nothing safely** | 0% reliable — pinecone.io (anchor, 7x), medium.com (platform, 27x) and firecrawl.dev (dual-role publisher, 3x) all rank differently but frequency alone never separates them; this replicates the prompt's own finding almost exactly |

**What metadata could never resolve, confirmed needing a fetch:**
- **Competitor vs. substitute** — telling "purpose-built vector DB" from "general-purpose
  store with vector search bolted on" requires knowing what the product actually is.
  redis.io's SERP snippet ("Redis delivers sub-millisecond vector search...") reads
  identically in shape to weaviate.io's — only the fetched front page ("Backend
  Infrastructure for Humans and Agents" vs. a dedicated vector-DB homepage) disambiguates.
- **Dual-role detection (adjacent-market vendor)** — firecrawl.dev's SERP snippet ("Compare
  18 vector databases with real performance benchmarks...") is indistinguishable from
  encore.dev's equally generic "Complete Comparison Guide" snippet. Only the fetched
  homepage revealed one sells web-scraping and the other sells a backend framework — both
  publishers *here*, only one is a competitor *elsewhere*. Metadata alone flattens this
  entirely; it can tell you "publisher," never "publisher, and also X."
  Same failure mode caught confident-ai.com as a plain buyer, missing its adjacent-vendor status.
- **Buyer vs. solo-educator-posing-as-buyer** — zenvanriel.com, towardsai.net, iternal.ai
  all read as buyer/practitioner from title+snippet; the fetch was needed to see "Launchpad,"
  "education firm," "Consulting" in each one's own self-description.
- **Live vs. dead competitor** — shaped.ai's SERP snippet gives no hint it was acquired;
  the front page states it outright.
- **Same-entity resolution across hosts** — nothing in metadata links milvus.io to
  zilliz.com; that's public knowledge, not SERP-derivable at all (would need an external
  company-graph lookup, not even a fetch of either page).

**Failure direction check** (does metadata-only fail safe or unsafe?): every miss above was
metadata *under-claiming* — collapsing a dual role down to the single role its snippet
happened to read as (buyer instead of buyer+vendor, publisher instead of
publisher+substitute), never inventing a role that wasn't there. That is the safe failure
direction: a downstream system that trusts metadata-only labels would under-represent
competitive threats and adjacent-market noise, not fabricate false competitors. It would,
however, silently miss real competitive intelligence (e.g., not realizing tigerdata.com or
redis.io actively markets against Pinecone), which is a real cost, just not a false-positive one.

---

## 5. Bad-query detector (measured, tested against 2 deliberately malformed queries + 1 naturally-occurring case)

Two signals computed per query, no fetch required:

1. **`n_organic`** — trivial but real: the URL-paste query
   (`https://www.capterra.com/search/?query=vector%20database%20software&sort=default`)
   returned **0 organic results** — Google treated the pasted URL as a literal, unmatched
   string and fell back to navigational suggestions only (`"AI Mode"`, `"Shopping"`,
   `"Forums"`). Zero organic results is a clean, unambiguous kill signal on its own.

2. **Cross-query host corroboration** — for each query, the fraction of its returned hosts
   that *also* appear under ≥1 other distinct query in the bag. Legitimate queries in this
   run ranged **16.7%–100%** (median ~71%). Both malformed queries scored far outside that
   band or at its exact floor:

   | Query | n_organic | corroboration | vocab-keyword overlap |
   |---|---|---|---|
   | `vector icon database free download` (deliberately malformed) | 9 | **0.0%** | 100% (fooled — "vector" and "database" appear literally in icon-site copy) |
   | `https://...capterra.com/search?...` (deliberately malformed) | 0 | **0.0%** (undefined, zero hosts) | 0% |
   | `why we left pinecone` (legitimate query, naturally collided) | 7 | **16.7%** | 14% |
   | 38 on-topic queries | 7–10 | 16.7%–100% | 78%–100% |

   Corroboration cleanly separates both malformed queries (0%) from every legitimate query
   (≥16.7%) in this run. **Naive keyword-overlap does not** — query 40's results score 100%
   vocabulary overlap because "vector" and "database" are literally present in icon-site
   copy ("Vector icons in SVG..."), the exact same collision mechanism as the sofragrance
   case. Corroboration catches what keyword matching misses because it doesn't care about
   words, only whether *other independent queries* also found this host — noise, by
   definition, doesn't repeat across unrelated queries.

   The naturally-occurring case (`why we left pinecone`, 16.7%) is the important stress
   test: it wasn't deliberately malformed, it's a normal-looking `switching`-intent query
   that happened to collide with "pinecone" the seed pod. Corroboration flagged it as the
   *lowest-scoring legitimate query in the bag* without being told anything about pine cones —
   a real, unplanned validation of the method.

   **Caveat found, not glossed over:** corroboration has a blind spot for a *generically
   popular* host that happens to appear by coincidence — query 8's one "corroborating" host
   was reddit.com itself (it has 20x corroboration bag-wide from unrelated pine-cone-free
   queries, so its single off-topic appearance here still counts as "supported"). A detector
   built purely on per-query corroboration will always underweight bad queries that happen
   to also return one mega-platform host. It caught this case anyway (16.7% is still an
   outlier low) but a market with a less dominant long tail might not separate as cleanly.

   **Not caught by any per-query signal:** the long-tail noise from §2 (openhelm.ai,
   drdroid.io, layer3labs.io, etc.) rides in on otherwise-legitimate `pain`/`switching`
   queries — those queries score normal corroboration (44%–89%) because *most* of their
   results are legitimate; only one or two hosts per query are noise. Per-query bad-query
   detection and per-host long-tail filtering are two different problems; solving the first
   does not solve the second. The second needs a per-host threshold (e.g. hosts at
   n_distinct_queries=1 AND outside any known role pattern get held back pending a fetch),
   which I did not build or test — **not measured**.

---

## 6. What must be fetched (summary, restated from §4)

Never safe from metadata alone:
- Purpose-built competitor vs. bolt-on substitute (needs the product's actual architecture)
- Whether a publisher/directory host is *also* a vendor in an adjacent market (dual-role
  detection) — metadata under-claims to a single role every time
- Whether a "buyer" post is from an operating company or a solo educator/consultant
- Whether a competitor is still alive or was acquired/shut down
- Whether two apex hosts (e.g. milvus.io / zilliz.com) are the same organizational entity

Safe from metadata alone (with caveats noted in §4):
- Directory/publisher vs. vendor, from title-pattern + self-naming check (93% in this run)
- Community and platform hosts, but only via a memorized fixed list, not inference
- Bad-query detection at the query level, via cross-query corroboration (100% separation
  in this run, 2 malformed + 1 natural case)

---

## 7. What was not done (stated plainly)

- **No systematic accuracy table beyond the ~35 hand-checked hosts** — the full 139-host
  apex bag was not individually hand-classified; the metadata-only rules were checked
  against the hosts I had ground truth for, not the whole bag. A full-bag run would give a
  tighter accuracy percentage than the "14/15", "11/12" style counts above.
- **Long-tail per-host noise filtering** (distinct from per-query bad-query detection) was
  identified as a real, separate problem in §5 but no detector was built or tested for it.
- **URL-path-level classification for github.com and linkedin.com** (repo vs. issue vs.
  topics; company page vs. job post vs. article) was described qualitatively but not turned
  into a rule and scored.
- **Entity resolution across hosts** (milvus.io = zilliz.com) was noted as a gap but not
  investigated further — would need an external company/domain graph, out of scope for a
  SERP-only method.
- No malformed-query variant beyond the two built was tested (e.g., a query with a typo, a
  query in a different language, a query that's just a stray fragment) — only URL-paste and
  term-collision were tried.

# Platform reach experiment: how to reach the places a market talks

**Market tested:** AI coding assistants / AI code review tools (buyer-phrased problems, e.g. "AI pair programmer for large codebase," "AI code review tool for pull requests"). Chosen because web scraping/data infra is already covered by `inspiration/query-catalog-ALL.md`, and this market has heavy, current (2026) activity across every target platform (Reddit, HN, GitHub, Product Hunt, Stack Overflow, X, lobste.rs, dev.to).

**Budget used:** 49 of 60 SERP calls, 1 of 4 Unlocker calls (failed for a platform-policy reason, not a technique failure — see below). Stopped early on explicit instruction after an infrastructure stall; some planned follow-ups were not run (see "What I did not get to").

**Methodology note (data integrity):** The scratchpad directory used for intermediate files turned out to be shared/reused across concurrent agent runs, not isolated to this run as documented. A concurrent process overwrote the query manifest file mid-read, causing 13 of the first 35 fired queries to lose their output before I could capture it (the API calls still completed/billed). I re-fired exactly those 13 queries into a fresh, uniquely-named subdirectory and confirmed all 35 planned queries had valid, non-empty output before analysis. This is why 49 calls were used to get 35 clean results. All numbers below are from the 35 clean, verified result sets.

---

## 1. Query approaches compared

| Group | Purpose | Example query |
|---|---|---|
| A: site:reddit.com + exact phrase vs. plain phrase | Does scoping to Reddit change what surfaces vs. an unscoped buyer-phrased query? | `site:reddit.com "AI pair programmer for large codebase"` vs. `AI pair programmer for large codebase` |
| B: platform named in text vs. site: operator | Does naming the platform in plain text do the same job as `site:`? | `AI pair programmer reddit` vs. `site:reddit.com AI pair programmer` |
| C: direct community queries | Find the community itself, not discussion within it | `best subreddit for AI coding assistants`, `AI coding assistant discord slack community`, `AI coding assistant conference 2026`, `AI coding assistant newsletter` |
| D: platform-native surfaces | Query the platform's own directory/index pages | `site:github.com/topics ai-coding-assistant`, `"AI coding assistant" site:producthunt.com`, `site:stackoverflow.com/questions/tagged AI coding assistant`, `AI pair programming site:lobste.rs`, `site:x.com AI coding assistant launch`, `site:github.com/topics ai-code-review`, `AI coding assistant site:dev.to`, `awesome AI coding assistant github` |
| E: failure direction | Professional/industrial trades on Hacker News/Reddit — expected weak-to-no presence | `site:news.ycombinator.com "precast concrete supplier"`, `site:news.ycombinator.com "industrial HVAC maintenance contractor"`, `site:reddit.com "commercial janitorial services contract"`, `medical device regulatory affairs consultant hacker news` |
| F: baseline category | Plain "best of" search, no platform signal at all | `best AI coding assistants 2026`, `top AI pair programming tools comparison` |

35 queries total, 10 results requested per query (Google `num=20` but organic blocks returned 7-10 typically).

---

## 2. What each approach returned

### Domain composition by group (all results pooled)

| Group | Total results | Unique links | Dominant domain(s) |
|---|---|---|---|
| A (site:reddit vs plain) | 54 | 51 | reddit.com 32/54 (59%) — but 30 of those 32 came from the 3 site:-scoped queries; plain queries were only 3/24 reddit |
| B (platform name vs site:) | 58 | 40 | reddit.com 38, news.ycombinator.com 18 — both variants stayed on-platform |
| C (direct community) | 32 | 32 | scattered — only 3 direct reddit.com links out of 32; rest is third-party roundup blogs, one GitHub awesome-list, conference/newsletter sites |
| D (platform-native) | 90 | 89 | github.com 26, producthunt.com 19, stackoverflow.com 10, lobste.rs 10, x.com 10, dev.to 10 — near-total platform purity per query (9-10/10 on-domain) |
| E (failure direction) | 67 | 63 | news.ycombinator.com 31, reddit.com 22 — see section 6, count is not the same as relevance |
| F (baseline category) | 15 | 14 | 0 platform-native domains at all; pure SEO listicle/blog domains + 2 stray reddit links |

### Usability by group (rough, from manual read of all 35 result sets)

- **A/B site:-scoped queries**: ~95% usable (real threads on-topic), but often duplicate threads across sibling queries (e.g. "After 6 months of daily AI pair programming" appeared in 3 different A/B queries) — diminishing returns from firing many near-synonym queries at the same platform.
- **C (direct community)**: bimodal. `best subreddit for X` and `conference 2026` and `newsletter` queries were high-yield (concrete named communities/events). `discord slack community` was the weakest — mostly returned Slack's own marketing page and generic integration docs, not actual community links.
- **D (platform-native)**: Product Hunt, GitHub topics, lobste.rs, X were high-yield and high-purity. Stack Overflow tag search was the worst of the platform-native queries — most rows were the same auto-injected SO promotional boilerplate ("Paste this into your AI coding assistant: Help me join Stack Overflow for Agents") rather than substantive tag content; the tag *names* were useful, the row content mostly was not.
- **E (failure direction)**: see section 6 — raw usability numbers are misleading here on purpose.
- **F (baseline)**: 100% "usable" in the sense of being real pages, but 0% platform diversity — it's an SEO monoculture of listicle/blog domains.

---

## 3. site: vs. naming the platform in text — the numbers

Three head-to-head pairs, same query intent, only the operator changed:

| Pair | site: operator | Named in text | Results (site: / text) | Domain purity (site: / text) | Link overlap |
|---|---|---|---|---|---|
| AI pair programmer | `site:reddit.com AI pair programmer` | `AI pair programmer reddit` | 10 / 9 | 100% reddit / 100% reddit | 5 shared / 14 union (36%) |
| AI code review tool | `site:news.ycombinator.com AI code review tool` | `AI code review tool hacker news` | 10 / 9 | 100% HN / 89% HN (1 reddit) | 7 shared / 12 union (58%) |
| best AI coding assistant | `site:reddit.com best AI coding assistant` | `best AI coding assistant reddit` | 10 / 10 | 100% reddit / 80% reddit (+qodo.ai, axify.io) | 6 shared / 14 union (43%) |

**Finding: neither wins outright, and they are not redundant.** Naming the platform in plain text is enough to make Google return that platform almost exclusively (80-100% domain purity across all 3 pairs) — you don't strictly need `site:`. But the two forms only overlap 36-58% on the *specific links* returned. Each form surfaces roughly half unique threads the other doesn't. `site:` queries filled the full 10-slot page with on-domain results every time; text-named queries occasionally let a vendor page slip in (qodo.ai, axify.io in the "best AI coding assistant reddit" results — itself a minor platform-native-vendor-discovery side effect). **Practical rule: run both forms per platform, don't treat one as a superset of the other** — the marginal cost of a second SERP call is small relative to the ~40-60% of unique threads it adds.

---

## 4. Did platform-scoped queries find companies the plain baseline missed? Yes, decisively.

I checked 19 distinct vendor/product names that surfaced only in the platform-native group (D), mostly from Product Hunt category pages (`D3`, `D4`) and X.com launch search (`D7`): **Trag, LaReview, Entelligence, Hoji, Wasps, Optibot, LetMeCheck.ai, AgentNotch, Firebender, Billy.sh, Tollecode, moCODE, CodeAI, Cosine, Shipper, FetchCoder, Graphify, Kodus, CodeAnt AI**.

I searched for each name's exact text across every one of the 35 result sets (not just the two baseline queries) to be thorough:

- **16 of 19 (84%) appeared nowhere else at all** — not in the baseline category queries (F1/F2 "best AI coding assistants 2026" / "top AI pair programming tools comparison"), not in any A/B/C/E query either.
- **3 of 19 (Kodus, CodeAnt AI, OpenClaw-adjacent) appeared exactly once outside D**, and each of those single hits was itself another *platform-scoped* query (a `site:news.ycombinator.com` result, a `site:reddit.com` result, a community-Slack result) — never in the plain baseline.
- **0 of 19 appeared in F1 or F2**, the two plain "best AI coding assistant" roundup searches. F1/F2 converged on the same ~10 incumbent brand names every time: GitHub Copilot, Cursor, Claude Code, Amazon Q Developer, JetBrains AI, Codeium, Tabnine, Qodo, Windsurf, Gemini Code Assist.

**This confirms the hypothesis cleanly for this market**: plain "best X" category search is a closed loop over whichever ~10 incumbents already dominate SEO listicles. Product Hunt category pages and X launch search are where the pre-listicle long tail actually lives — smaller, earlier-stage, or narrowly-scoped products that haven't been picked up by content-marketing roundups yet. A founder mapping this market from `F1`/`F2` alone would never learn Kodus, Trag, LaReview, Optibot, LetMeCheck.ai, AgentNotch, Firebender, Cosine, or Tollecode exist — all are real, named, currently-launched products with their own Product Hunt pages.

GitHub topics/awesome-lists (D1, D2, D8) similarly surfaced OSS-only projects (dashboard tools, MCP servers, CLI agents) that never appear in commercial "best of" roundups because they're not commercial products in the SEO-marketing sense — a different, adjacent long tail (open-source alternatives / building blocks rather than funded startups).

---

## 5. Is a SERP result enough to record a community? Partial answer — tested before the stall.

**What title + description alone give you:** a name and a one-line description, usually enough to tell *what gathers there* (e.g. lobste.rs's snippet literally is the tag definition: "Developing artificial intelligence, machine learning. Tag AI usage only with `vibecoding`"). What they do **not** reliably give: activity volume / significance (subscriber counts, stars, post frequency) — SERP snippets almost never carry a number, so "how significant is this community" cannot be answered from the SERP row alone.

**Free-fetch results (no Unlocker), tested on 5 pages:**

| Page | Result | What it added over the SERP snippet |
|---|---|---|
| `reddit.com/r/ChatGPTCoding` (new Reddit) | Blocked — HTTP 200 but body is a bot-check "Please wait for verification" interstitial | Nothing; unusable |
| `old.reddit.com/r/ChatGPTCoding` | **Worked** — HTTP 200, 138KB real HTML | Real recent post titles (e.g. "Reopening of r/ChatGPTCoding," current top posts), confirming the subreddit is active right now — this is exactly the "how significant, right now" signal a SERP snippet can't carry |
| `github.com/topics/ai-coding-assistant` | **Worked** — HTTP 200, 608KB | Related-topic list plus real star counts on associated repos/lists (5082, 4059, 2234, 2181...) — a genuine significance number, not obtainable from the SERP row |
| `stackoverflow.com/questions/tagged/claude-code` | Blocked — Cloudflare "Just a moment..." challenge (403) | Nothing |
| `producthunt.com/posts/kodus` | Blocked — HTTP 403 | Nothing |
| `lobste.rs/t/ai` | **Worked** — HTTP 200, 62KB | Exact, authoritative tag definition (better than any SERP description) plus a countable ~25 stories under the tag — real activity signal |

**Answer so far: no, a SERP result alone is not enough if the record needs to claim "significance," but it is enough for name + what-gathers-there.** 3 of 5 platforms (GitHub, old.reddit.com, lobste.rs) were freely fetchable and added a real number (stars, post recency, story count) the SERP never carries. 2 of 5 (Stack Overflow, Product Hunt, and new Reddit) are bot-walled and need either a workaround URL (old.reddit.com solved Reddit) or a paid Unlocker call.

**Unlocker result: 1 attempt, failed for a policy reason, not a technique failure.** Fetching `reddit.com/r/ChatGPTCoding` through Bright Data's Unlocker zone returned: `Residential Failed (bad_endpoint): Requested site is not available for immediate residential (no KYC) access mode in accordance with robots.txt.` — Reddit is blocked at this account's Unlocker configuration regardless of paying for it; it requires a separate KYC form. This burned 1 of the 4 allotted Unlocker calls without data — the free `old.reddit.com` route made it moot for Reddit anyway. **Did not get to test the Unlocker against Product Hunt or Stack Overflow** before being told to stop (see gaps below).

---

## 6. Telling absence from a bad query

Four failure-direction topics tested, each as a quoted-exact-phrase `site:` query (the strictest form) plus a loose "topic + platform name" companion:

| Query | Raw count | Actually on-topic? | Verdict |
|---|---|---|---|
| `site:news.ycombinator.com "precast concrete supplier"` | **0** | n/a | Clean absence — nothing to interpret |
| `precast concrete supplier hacker news` (loose) | 9 | ~0 substantive — includes a Wikipedia page *about* Hacker News itself, an Instagram post, two trade-press sites, incidental HN comments about concrete physics unrelated to suppliers | False positive by raw count; correct conclusion only after reading titles |
| `site:reddit.com "commercial janitorial services contract"` | 10 | **Yes** — r/sweatystartup, r/smallbusiness, r/cleaningbusiness threads genuinely about pricing/landing janitorial contracts | Real presence — my "no presence" assumption was wrong for this trade on Reddit |
| `site:news.ycombinator.com "industrial HVAC maintenance contractor"` | 10 | **Yes** — genuine Ask HN / discussion threads ("Why is there no Uber for plumbing/HVAC," "America's new millionaire class: Plumbers and HVAC") | Real presence — wrong assumption again, HN has a real "boring business/trades" discourse thread |
| `site:news.ycombinator.com "medical device regulatory affairs consultant"` | 10 | **No** — 10 rows returned but none substantively discuss that exact phrase; matches are generic consulting/startup threads where fragments coincidentally match | This is the genuine "market not here" case, and it does NOT show up as a 0-count |

**The key finding: a nonzero count from a quoted-exact-phrase `site:` query is not proof of presence.** Google silently loosens exact-phrase matching once true hits run out, so a topic with zero real community discussion (medical device regulatory affairs consulting on HN) returns the same "10 results" shape as a topic with genuine discussion (HVAC contracting on HN). The only reliable signal I found:

- **A true 0-count is trustworthy** — when Google can't even loosen its way to 10 results, that's a real absence signal a machine can act on directly.
- **A nonzero count requires reading titles/descriptions for the actual phrase or a close paraphrase**, not just trusting the count. In my E7 case, none of the 10 titles contained "medical device," "regulatory affairs," and "consultant" together — that pattern (high count, low phrase-fidelity) is what a machine should flag as "probably absent, not probably present."
- Two of my three "should have no presence" assumptions were simply wrong (janitorial on Reddit, HVAC on HN) — which is itself a finding: don't assume a trade/industrial market has no community presence without checking; Reddit's small-business/side-hustle subreddits and HN's "trades as boring-business opportunity" discourse cover more blue-collar ground than expected.

I did not get to run the natural follow-up that would sharpen this rule further (see below): a shorter, unquoted `site:` query on the same medical-device topic to see whether presence is fully absent or just doesn't match this exact phrasing.

---

## 7. What I did not get to

- **Did not re-verify the E7 absence conclusion with a broader/shorter query** (e.g., `site:news.ycombinator.com "medical device regulatory"` without the trailing "consultant") to rule out "the phrase was too specific" vs. "the topic genuinely isn't discussed." This is the single most useful follow-up to sharpen section 6's rule and was the next thing planned before the stop instruction.
- **Only 1 of 4 Unlocker calls used**, and it failed on a Reddit-specific KYC policy block rather than testing the technique. Did not get to try the Unlocker against Product Hunt (`producthunt.com/posts/kodus`) or Stack Overflow (`stackoverflow.com/questions/tagged/claude-code`), both of which were free-fetch-blocked by bot walls that a residential Unlocker would plausibly clear. 3 Unlocker calls remain untested.
- **Did not extract a hard subscriber/member count from the old.reddit.com fetch** — confirmed the page is real and fetchable with real recent post titles, but did not finish mining a clean numeric "significance" figure from it before stopping.
- **Single-market design, by instruction** ("pick one market") — no second market was run for cross-market comparison, so findings about e.g. Product Hunt's long-tail yield are demonstrated for AI coding assistants only, not confirmed general.
- **No further new queries or fetches were run after the stop instruction arrived**, per that instruction — all analysis above section "Methodology note" and the final numeric tables was done locally against already-collected JSON, not from new API calls.

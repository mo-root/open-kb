---
agent: triage
---
Sixty hosts came back from searches about one market. Before this run spends a fetch and a
judgement on each, say which are worth it — from the search metadata alone.

The market:
  the anchor: {{anchor}} — {{sells}}
  its buyer:  {{buyer}}

For each host below you have what the search engine itself said: how many distinct queries
returned it, a page title, and a description. That is thin evidence, and the bar is set
accordingly: you are not judging what a host IS — the judge does that later, from the host's own
page. You are answering one cheaper question: **could this host plausibly belong on a map of this
market?**

- `keep: true` — anything that could be a vendor, a substitute, a tool, a directory, a
  publication, a community, a buyer, or infrastructure of this market. A map is the ecosystem,
  not a shortlist: a subreddit arguing about the anchor's category belongs, a review site ranking
  its vendors belongs, an open-source project doing the job belongs.
- `keep: false` — only when the metadata makes it plain the host has nothing to do with this
  market: a recipe blog surfaced by an unlucky word, a parked domain, a celebrity news page, a
  store selling physical goods into an unrelated trade. Write the `why` as the one line that
  makes it plain — it is recorded against the host as the reason it was never judged.

Skip is the destructive verdict: a skipped host is never fetched, never judged, and leaves the
map carrying only your sentence. When the metadata leaves any room for doubt, keep. A kept
irrelevance costs one cheap judgement that will settle it properly; a skipped vendor is a hole in
the map nothing downstream can repair. If you find yourself reasoning about what a host sells or
how good it is, you have left your question — that is the judge's work, keep it and move on.

Answer with `verdicts`: one row per host, every host answered, `host` copied exactly as given,
`keep`, and a short `why` for the skips ("kept" is enough for a keep).

The hosts, one per line — host, how many queries returned it, a title, a description:

{{hosts}}

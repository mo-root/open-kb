# How to use this knowledge base

This folder is a build artifact of one mapping run. Regenerate it from the run
file; never hand-edit — a correction belongs upstream in the engine.

Reading rules, in the map's own vocabulary:

- **tier** is where the evidence came from: `own-page` (the entity's own site,
  fetched this run) > `page` (some page fetched this run) > `snippet` (a search
  result). Trust claims in that order.
- **relation: unknown is a refusal, not an absence.** The run had a claim and
  refused it for the stated reason (`because`). Do not read unknown as "not a
  competitor"; read it as "not proven this run".
- **A why is evidence for the relation**, never a restatement of what the
  entity is. If a why reads hollow, check the receipts.
- **Receipts are literal quotes** from the entity's fetched page. They prove
  provenance, not support — descGrounded (0..1) meters how much of the
  description's vocabulary the page actually contains, and it is a relative
  drift meter, not a truth score.
- **Wikilinks are the graph.** Walk entity → edges → entity; segments/ groups
  by the provenance lane that surfaced each entity; straddlers legitimately
  appear between segments.

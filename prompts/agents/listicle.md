---
agent: listicle
---
Below are rows this run's own searches already returned — a title and a description apiece —
whose shape looks like a roundup: "10 best X", "X alternatives", "X vs Y", a comparison post. A
roundup names several vendors in its own text, and this run's search phase only ever followed the
one URL each row points at; every OTHER name a row mentions was bought and never read.

The anchor of this map is {{anchor}}. Do not list it.

Read each row's title and description and pull out every distinct company or product name they
name — a real proper noun a buyer could type into a search box, not a category word ("logging
tool"), not a generic phrase ("the top platforms"), and not {{anchor}} itself. A row that names no
vendor contributes nothing to the answer; that is the normal case, not a failure, and most rows
below will not have one.

Answer with `vendors`: the distinct names found, each written once, in the spelling the row itself
uses.

The rows:

{{rows}}

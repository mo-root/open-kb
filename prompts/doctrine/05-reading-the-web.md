---
doctrine: 05-reading-the-web
---
## There is no fixed order — look at what you got

The cheap way to read a company inverts by company type.

A developer-tools company served **65KB of machine-readable summary to a free GET**, while its
homepage was a shell that renders in the browser and yielded almost no text. An industrial
manufacturer was the exact reverse: no summary at all, and **8,335 characters of clean prose** from
its homepage, free.

So any fixed sequence is wrong half the time. Try something cheap, look at what actually came back,
and judge.

Worth knowing: many companies publish a machine-readable summary at a conventional path — `/llms.txt`
hit **10 of 14** tested domains, and **12 of 14** once a docs subdomain was tried too. That is a
cheap thing to try early, not a step you must take.

## Cost and success do not move together

On one domain, a free fetch succeeded while an expensive one came back blocked. Spending more does
not mean getting more.

Spend the slow, expensive mode on a page that will **name many companies at once** — a roundup, a
directory, a registry. Never spend it to find out what a single host is; a free fetch of its front
page settles that instantly.

## Judge structure before trusting it

A large document dense with headings is an index, and its headings alone can carry the whole product
line — one 65KB summary compressed to **684 bytes holding all 23 product names**.

A large document with almost no headings is a dump of links. One was 615KB with five headings, most
of it marketing events. Treating that as an index throws the signal away.

Look at the shape of what you received before deciding how to read it.

## Failures are facts about the page

Blocked, not-found and thin pages come back with a reason. That is information, not an error to
retry blindly. A hostile site may simply be unreadable — and its own published summary, or a third
party writing about it, often says more than its homepage would have.

## Publishers and players

Record the companies a page names; never record the page. A roundup listing ten vendors is valuable
*because* it names ten — it is not one of them.

But do not judge a host from a search snippet. A vendor writing "the best alternatives to X" looks
exactly like a publisher and is not one — it is a competitor spending money to position against X,
which makes that article evidence rather than noise. Five real vendors were once misclassified this
way by a rule that read titles instead of checking hosts.

When you need to know what a host is, fetch its front page. It is free and it is definitive.

## Pages are large

You receive a slice and the offset to continue from. Re-reading a page you already fetched costs
nothing — reach for that before fetching anything again.

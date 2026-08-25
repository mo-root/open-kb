# demo/

Six real maps, committed, so a deployment can show what this engine produces
without spending anything.

A live run takes four to nineteen minutes and costs $0.30-$5.00. That is fine
for the person who wants the map and hopeless as a front door: nobody waits
that long on a link somebody sent them, and a hundred visitors is hundreds of
dollars. The maps here are the product — shopify.com with 1,284 entities and
2,788 edges, clustered by market, every node carrying its sources — and they
are instant.

## What is here

`maps/` holds six sweep results copied out of `runs/`, which is gitignored and
therefore absent from a clone.

Every figure below is read straight out of the file beside it — entity and
edge counts are array lengths, cost and duration are the run's own `stats`.

| map | entities | edges | cost | time | why this one |
|---|---|---|---|---|---|
| `sweep-shopify-com-20260823201634` | 1,284 | 2,788 | $0.98 | 19 min | the biggest map |
| `sweep-stripe-com-20260823130137` | 1,210 | 2,726 | $0.95 | 16 min | payments — a market most readers can check by eye |
| `sweep-openai-com-20260823191503` | 1,204 | 3,201 | $0.96 | 16 min | a market that moves faster than the map can be rebuilt |
| `sweep-datadoghq-com-20260823193440` | 1,154 | 3,754 | $1.05 | 19 min | the densest graph — 3.3 edges an entity |
| `sweep-cloudflare-com-20260823162255` | 1,146 | 3,343 | $1.05 | 19 min | infrastructure, where `competitor` is hardest to call |
| `sweep-figma-com-20260823125953` | 976 | 2,348 | $0.77 | 14 min | the cheapest and fastest run here |

**There is no "edges shown" column, and that is a result rather than an
omission.** An earlier set needed one: those maps were built before the engine
learned to refuse a host answering with the anchor's own identity, so a
stranger ended up wearing the anchor's name — `aws.amazon.com` named "Vercel",
`exalate.com` named "Stripe" — and, because the linker resolves a mention by
name, collected every page in the run that mentioned the anchor.
`withoutStolenNames` takes the name back as the map is read and drops the edges
that name minted. Run it over these six and it drops **zero** on every one, so
what the file holds is what the app draws. That earlier set is kept, unedited,
under `archive/pre-agent-20260819/`, and its README figures describe it rather
than these.

They keep their original filenames because the filename is the run's identity:
`lib/runs.ts` reads the id off it and dates the run from the stamp.

## How they were made

`pnpm demo:maps` — `scripts/build-demo-maps.ts`, which reads `runs/`, drops the
one field nothing in the app reads (`searched`, a per-query search transcript
worth 2MB on the larger runs), minifies, and writes here. 21.2MB in, 12.7MB out.
Nothing else is removed: the download button on every map calls core's
`exportKbFiles`, which reads `spans` and `report.recall`, so those stay.

Do not hand-edit these files. Re-run the script.

## Turning the demo on

`OPENKB_DEMO=1`. It does two things:

- `POST /api/map` refuses with 403 and a sentence saying this is a read-only
  demo, pointing at the repo. Every read route is untouched.
- The gallery reads this directory instead of `runs/`, so it lists these six and
  nothing else.

To serve a different set, point `OPENKB_DEMO_MAPS_DIR` at it.

`OPENKB_RUNS_DIR` is **not** consulted in demo mode, and that is deliberate
rather than an oversight: it means "where new runs are written", every Vercel
deployment is told to set it to a scratch path under `/tmp`, and a demo writes
no runs. Letting it decide which maps to serve would hand an operator who
followed the deploy guide an empty gallery. Two questions, two variables.

See DEPLOY.md.

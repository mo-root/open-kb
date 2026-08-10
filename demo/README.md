# demo/

Six real maps, committed, so a deployment can show what this engine produces
without spending anything.

A live run takes four to nineteen minutes and costs $0.30-$5.00. That is fine
for the person who wants the map and hopeless as a front door: nobody waits
that long on a link somebody sent them, and a hundred visitors is hundreds of
dollars. The maps here are the product — stripe.com with 2,551 entities and
3,017 edges, clustered by market, every node carrying its sources — and they
are instant.

## What is here

`maps/` holds six sweep results copied out of `runs/`, which is gitignored and
therefore absent from a clone.

| map | entities | edges | why this one |
|---|---|---|---|
| `sweep-stripe-com-202608070005` | 2,551 | 3,017 | the biggest map |
| `sweep-vercel-com-202608062351` | 2,370 | 6,283 | the densest graph |
| `sweep-supabase-com-202608070017` | 1,494 | 2,351 | the middle of the range |
| `sweep-cursor-com-202608070032` | 891 | 1,796 | a market small enough to read whole |
| `sweep-clerk-com-202608062258` | 449 | 517 | $0.29 — the cheapest run on record |
| `sweep-brightdata-com-202608042230` | 934 | 487 | 0% unreadable — every entity has a real description |

They keep their original filenames because the filename is the run's identity:
`lib/runs.ts` reads the id off it and dates the run from the stamp.

## How they were made

`pnpm demo:maps` — `scripts/build-demo-maps.ts`, which reads `runs/`, drops the
one field nothing in the app reads (`searched`, a per-query search transcript
worth 2MB on the larger runs), minifies, and writes here. 19.4MB in, 8.4MB out.
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

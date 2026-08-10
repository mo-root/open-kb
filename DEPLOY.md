# Deploying open-kb

## Two shapes of host

A sweep takes anywhere from two minutes to over an hour, depending on how broad
the market is, and runs **detached** after its HTTP response returns:
`POST /api/map` answers immediately with a run id and the work carries on in the
background.

That works two ways, and they are not equally good:

- **A box that stays up** — Railway, Render, Fly, the Dockerfile, any host
  running `node`. No time limit, nothing to configure, every run finishes.
- **Vercel** — works, with a ceiling. Roughly half of the runs measured here
  finish inside the limit; the rest are stopped and recorded as failed. Read the
  next section before choosing it.

If you have no reason to prefer one, take the box that stays up.

## Deploying on Vercel

This used to say "you can't". That was written against the old serverless model
and is no longer true, but the honest version is narrower than "it works".

**What makes it possible.** Vercel's default execution model is Fluid Compute,
and Next's `after()` extends the invocation past the response instead of
freezing the instance when the response is flushed. `POST /api/map` hands the
run to `after()`, so the detached sweep is part of the invocation and keeps
running. It is not unlimited: the run shares the function's `maxDuration` with
the request that started it.

**What it costs.** A run that does not finish inside `maxDuration` is stopped.
It does not resume, and there is no queue that picks it up later. You pay for
the work it did and get a failed run.

### A browser run is sized to your plan before it starts

This is the part that used to be a coin flip and is not any more. `POST
/api/map` reads its own `maxDuration`, subtracts the 30s the watchdog reserves
for recording the ending, and works out how many queries fit in what is left
(`queriesThatFit`, `packages/core/src/clock.ts`). It then buys that many and no
more — the opening hand and every widening round together.

| `maxDuration` | Questions the run may buy | Hosts that implies | Est. wall clock |
|---|---|---|---|
| **300s** — Hobby, and every plan's default | 18 | ~230 | 263s of 270 |
| **800s** — Pro / Enterprise maximum | 70 | ~910 | 761s of 770 |
| **1800s** — extended limit, opt-in beta | 175 | ~2,275 | 1768s of 1770 |

```bash
npx tsx -e "import {queriesThatFit,runSeconds} from './packages/core/src/clock.ts';\
for (const l of [300,800,1800]) console.log(l, queriesThatFit(l-30), Math.round(runSeconds(queriesThatFit(l-30))))"
```

Raising the plan raises the map, and it is the only thing that does. A Hobby
deployment produces a few hundred entities where the same anchor from a terminal
produces thousands, and both the live panel and the stored map say so in as many
words — a narrow map is a size, not a weakness, and a reader who is not told
that draws the wrong conclusion about the engine.

**Why 18 and not 40.** Rank is the long pole: one page fetch and one model call
per host found, at a pool of 8, so a query budget is really a host budget
wearing a disguise. The five coefficients and where each was measured are in
`clock.ts`. The short version is that the phases which do not scale cost 60s,
one query costs 1.4s of search and drags ~13 hosts into a phase that spends
0.63s on each of them, and the tail needs 30s to link and write.

**Where the number came from.** A real Vercel run of clerk.com (id `1de8e96c`,
481 spans) bought 132 SERP searches, spent $0.7099, and was stopped 30s before
the 300s ceiling with the rank phase barely started. Run the same arithmetic
backwards over 132 queries and it needed about 23 minutes. It was given four and
a half, and the reader got no map at all for the money.

### How long an unsized run takes

The terminal has no clock and buys what the market is worth. Measured over the
12 sweeps in `runs/` from 2026-08-06 onward — the current engine shape, older
runs were narrower and faster — p50 is **703s**, and the slowest run in the
corpus is 4195s (70 minutes, `sweep-brightdata-com-202608060944.json`).

```bash
python3 - <<'EOF'
import json, glob, re
v=sorted(json.load(open(f))['stats']['seconds']
         for f in glob.glob('runs/sweep-*.json')
         if (m:=re.search(r'-(\d{12,14})\.json$', f)) and m.group(1) >= '20260806')
n=len(v); print(f"n={n} p50={v[n//2]:.0f}s")
for lim in (300, 800, 1800):
    k=sum(1 for s in v if s<=lim); print(f"<={lim}s: {k}/{n} = {round(100*k/n)}%")
EOF
```

Only 6 of those 12 would have fitted in 300s and 7 in 800s, which is what the
sizing above exists to stop being your problem. Note what the corpus does not
say: twelve runs of eight domains is not a forecast, breadth drives duration far
more than the plan does, and the same domain swung from 229s to 1424s on the
same day. That spread is also why the deployment does not trust its own
arithmetic alone — the engine is handed the deadline as well as the budget, and
stops judging with the tail's worth of clock in hand rather than overrunning.

### What you have to turn on

1. **A Pro plan**, if you want more than 300 seconds. Hobby is capped at 300s
   and cannot be raised.
2. **`maxDuration` in `packages/web/app/api/map/route.ts`**, currently `300`.
   - On **Hobby**, leave it. 300 is the only value every plan accepts, and it
     is the default precisely so that a clone deploys anywhere.
   - On **Pro/Enterprise**, raise it to `800` — generally available, with
     nothing to enable — and the query budget follows on its own: it is derived
     from this constant, not written beside it. That one edit takes a run from
     18 questions to 70.
   - For **1800**, the extended limit is an opt-in beta that is enabled per
     function in project settings. Enable it there *first*, then raise the
     constant. Setting the constant alone will not grant you the time.
   - Vercel rejects a `maxDuration` above the plan ceiling *at build time*, so
     an 800 on Hobby means the deployment does not build at all. That is
     deliberate on Vercel's part and is the better failure: a build error rather
     than runs killed at 300s.
3. **Supabase.** Not optional here — see below.

### Supabase stops being optional

On a normal host a finished run is written to `runs/run-<id>.json` and Supabase
is a nice-to-have. On Vercel both halves of that break:

- the filesystem is read-only except `/tmp`, and
- `/tmp` belongs to one instance and does not survive it, so the next request
  can land somewhere that has never heard of the run.

The in-memory registry has the same problem for the same reason. Without
`SUPABASE_URL` and `SUPABASE_SECRET_KEY` a Vercel deployment can *start* runs and
will lose them — including runs that succeeded. Set them, and run
`scripts/supabase-schema.sql` against the project before the first deploy.

Also set **`OPENKB_RUNS_DIR=/tmp/openkb-runs`** as a project environment
variable. On other hosts `next.config.ts` fills this in, which it cannot do here:
on Vercel that file runs at build time on a different machine, so nothing it
assigns reaches the running function. Unset, the app falls back to a path under
the read-only filesystem and every file write fails. Pointing it at `/tmp` makes
those writes succeed as a per-instance cache; Postgres remains the only thing
that actually keeps a run.

### What happens when a run is too long

It is ended deliberately, 30 seconds before the platform's limit, and recorded
as a **failed** run with its spans intact — you can see how far it got and what
it cost.

That margin is the entire feature. Killed at the limit, the invocation stops
mid-write: the span stream never closes, so a browser watching the run waits
forever; no row is written, so `/kb` never lists it; and the money is spent with
nothing to show for it. Stopping early is what turns a silent disappearance into
a recorded failure.

The reader is shown the app's generic failure sentence and a reference; the
cause, naming the limit, is on the run's row and in the function log.

### Not Workflow DevKit

The obvious suggestion for "long job on Vercel" is the Workflow DevKit, and this
repo has already been there and left — see the comments in
`packages/web/next.config.ts` and `packages/web/lib/runs.ts`. Its `"use step"`
sandbox is what the current design exists to escape. Do not reintroduce it.

### Before you deploy to Vercel

**None of this applies to a read-only demo.** Set `OPENKB_DEMO=1` and every
item below is about a capability the deployment no longer has: no run means no
`maxDuration` to size, nothing to persist, and nothing to write to `/tmp`.
Hobby is fine. See "The read-only demo" further down — if the goal is a URL you
can hand to strangers today, that is the whole deploy.

For a deployment that really is meant to run:

- [ ] Pro plan, or `maxDuration` lowered to `300`
- [ ] `SUPABASE_URL` / `SUPABASE_SECRET_KEY` set, schema applied
- [ ] `OPENKB_RUNS_DIR=/tmp/openkb-runs` set
- [ ] everything in "Before you share the URL" below

## What it needs

| Variable | Required | What it is |
|---|---|---|
| `BRIGHTDATA_API_TOKEN` | yes | Bright Data API token |
| `BRIGHTDATA_SERP_ZONE` | yes | name of a **SERP API** zone |
| `BRIGHTDATA_UNLOCKER_ZONE` | yes | name of a **Web Unlocker** zone |
| `OPENROUTER_API_KEY` | yes | model provider key |
| `KB_USER` / `KB_PASSWORD` | **on any public deployment** | basic auth. Unset means OPEN, and the start endpoint takes a domain and spends real money |
| `OPENKB_RUN_CAP_USD` | no — **has a default** | the most one map may cost. Unset, it is derived from the query budget `maxDuration` affords: **$0.41** at 300s, $1.51 at 800s. Enforced *during* the run against the span stream's own total, which counts model + search + fetch. `off` removes it |
| `OPENKB_DAY_CAP_USD` | no — **has a default** | the most this deployment will spend on maps in a UTC day, counted from its own rows in Postgres. Default **$5.00**, about 22 maps. `off` removes it |
| `OPENKB_RUNS_PER_VISITOR_PER_DAY` | no — **has a default** | maps one visitor gets a day. Default **3**. `off` removes it |
| `OPENKB_RUNS_AT_ONCE` | no — **has a default** | maps this deployment builds at the same time. Default **3**. `off` removes it |
| `OPENKB_VISITOR_SALT` | recommended on a public deployment | salts the hash of a visitor's address before it is stored. Without it the `visitor` column is a hash of a 32-bit space, which is minutes of work to reverse |
| `OPENKB_CEILING_USD` | no | a *provider-side* backstop underneath the four above: a ceiling on the OpenRouter KEY's cumulative usage. The key is shared, so this counts other projects too, and it meters no Bright Data at all. Unset means no provider-side ceiling |
| `OPENKB_CEILING_BASE_USD` | no | the key's usage reading when you deployed, so that ceiling counts from now rather than from the key's whole history |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | strongly recommended, **required on Vercel** | without them a container restart loses every run — and on Vercel there is no disk to fall back to, so runs are lost as soon as the instance goes |
| `OPENKB_RUNS_DIR` | **on Vercel**, set to `/tmp/openkb-runs` | where run JSON is written. Other hosts get it from `next.config.ts`; on Vercel that runs at build time on another machine, so it has to be a real project variable pointing at the only writable path |
| `OPENKB_DEMO` | **on any URL you hand to strangers** | `1` makes this a demo: the gallery serves the six committed maps, and no run can be started unless the next row says otherwise. See below |
| `OPENKB_PUBLIC_RUNS_PER_DAY` | no — **unset means the demo refuses every run** | how many maps a day this deployment will buy for visitors. `20` is about $4 at the measured $0.147–$0.202 a run. Unset, `0`, or anything unparseable is a closed door |
| `OPENKB_DEMO_MAPS_DIR` | no | which maps a demo serves. Unset, it finds `demo/maps/` itself. Deliberately **not** `OPENKB_RUNS_DIR`, which means something else |

## The three guards, and what each does not do

**Auth** decides who. It stops a stranger and a crawler. It does not stop an
invited person running two hundred maps.

**The budget** decides how much, and it is four numbers rather than one. A cap on
a single map, enforced while the map is being built; a cap on the day, counted
from this deployment's own rows; a cap per visitor; and a cap on how many run at
once. They compose into one promise: **the day's spend cannot pass
`OPENKB_DAY_CAP_USD`**, because every dollar is either already recorded against a
finished run or reserved at the cap of one still going, and no run may exceed its
cap. All four fail CLOSED — an unreadable store, a value that is not a number, a
day cap below a run cap: each refuses the run and says which. `OPENKB_CEILING_USD`
survives underneath as a provider-side backstop, because it can see spending on
the same key from outside this deployment (the CLI, a second deployment) that
nothing here can.

Details worth knowing before you tune them:

- **Every one is on by default.** A deployment that opens its door should not
  open it onto an unmetered account. Raise them in one line, or write the word
  `off` — a word, so that no typo, blank field or stray space can turn a limit
  off by accident.
- **The day cap needs the schema.** `scripts/supabase-schema.sql` adds
  `runs.usd` and `runs.visitor` and the `claim_run` function; re-run the whole
  file against an existing project, every statement in it is idempotent. Without
  them the deployment refuses every run rather than guessing, and says so.
- **Three of the four are decided inside Postgres, on purpose.** Counting
  today's runs and then starting one is two round trips, and a burst fits
  between them: twenty requests fired together all read the same empty day and
  all start. Measured on the shape that did: 20 admitted against a limit of 3,
  and $4.92 committed against a $1.00 day cap. `claim_run` counts and writes the
  run's row in one transaction under an advisory lock, so the twentieth request
  sees the first nineteen. If a deployment starts answering 503 with
  `no claim_run function` in its log, that is this — re-run the schema file.
- **The per-visitor limit needs a proxy in front.** It reads the LAST entry of
  `x-forwarded-for` (or `x-vercel-forwarded-for` / `x-real-ip` first), because
  every proxy appends and the leftmost entry is whatever the client sent. On a
  bare `next start` box nothing writes those headers and every caller shares one
  bucket; there the day cap and the concurrency limit are the real defence.
- **The run cap's default was measured on one model.** `deepseek/deepseek-v4-flash`,
  over 18 sweeps in `runs/`: `usd = 0.0146 + 0.0106 × queries`, which puts an
  18-query run at $0.205 and corroborates six hosted runs measured at
  $0.147–$0.202. A dearer model bills six to eight times that per query — set
  `OPENKB_RUN_CAP_USD` yourself if you change `OPENKB_MODEL`, or maps will stop
  early. The route logs a line saying so.

**Demo mode** decides whether. `OPENKB_DEMO=1` closes the one endpoint that can
spend, and it is the only one of the three that leaves a useful site behind
when it is on. `OPENKB_PUBLIC_RUNS_PER_DAY` is how you open it again by a
measured amount — a fourth setting, and the only one whose absence is safe in
both directions.

Auth is the one you have to remember; the budget is already on. Demo mode
replaces the need for auth, and the next section is about when to reach for it
instead.

## The read-only demo

**Set `OPENKB_DEMO=1` on any URL you are going to put in front of people you
have not met.** Auth and the ceiling are the settings for a link you hand to
five people; they are the wrong tool for a public one. Auth turns a demo into a
password prompt, and a ceiling turns it into a site that works for the first
three visitors and refuses the fourth.

With the flag on:

- `POST /api/map` answers **403** with a plain sentence — this is a read-only
  demo, clone the repo and bring your own keys. Not a 500, not "temporarily
  unavailable", and not a spinner that never resolves.
- The front page is the six maps, not a form. There is no disabled input to
  type into and no refusal to read on arrival — the 403 above answers a
  request, and nobody on that page has made one.
- Every read route is untouched. The gallery, the graph, the notes, the search
  and the zip export all work.
- The runs directory defaults to `demo/maps/` — six real sweeps, committed,
  8.4MB, from stripe.com's 2,551 entities down to clerk.com's 449. They are
  the product: instant, already paid for, and nobody waits four minutes.

What it does **not** do: it is not auth. Anyone can read the maps, which is the
point. If some of them should not be public, keep `KB_USER`/`KB_PASSWORD` on as
well — the two are independent.

**`OPENKB_RUNS_DIR` has nothing to do with this**, and the separation is on
purpose. That variable says where *new runs are written* — the section above
tells you to point it at `/tmp/openkb-runs` on Vercel, and the Dockerfile hard
-codes `/app/runs`. A demo writes no runs. If it also decided which maps to
serve, an operator who followed both instructions would get an empty gallery on
the host this feature exists for. So demo mode reads `OPENKB_DEMO_MAPS_DIR`
instead, and ignores the other one. Set neither and it finds `demo/maps/` by
itself, which is what a normal deployment should do.

To change which maps ship, edit the list in `scripts/build-demo-maps.ts` and run
`pnpm demo:maps`. Do not hand-edit the JSON.

## Letting strangers run one

A read-only demo is a gallery of maps somebody else paid for. **Set
`OPENKB_PUBLIC_RUNS_PER_DAY` to a whole number and the demo starts buying runs
for visitors, up to that many a day.**

```
OPENKB_DEMO=1
OPENKB_PUBLIC_RUNS_PER_DAY=20
```

### What it costs you

Measured over six real runs through the deployed app: **$0.147 to $0.202 a run**,
returning **197 to 275 entities in 166 to 255 seconds**. So the exposure is about
twenty cents a visitor, and the variable is a dollar figure wearing a count —
`20` is roughly `$4.00` a day, `100` is roughly `$20.00`.

### Why it is a count and not a switch

There is no configuration in which runs are allowed and no limit is set, because
the limit *is* the switch. A boolean plus a separate cap has one more state than
this does, and that state — the switch on, the cap forgotten — is an unmetered
public endpoint. Unset is zero is closed, which is what every existing
deployment and every clone already has, so upgrading to this version changes
nothing anywhere until somebody writes a number.

### Why it is not `OPENKB_DEMO=2`

`OPENKB_DEMO` does three jobs and only one of them is about spending. It also
decides that the front page leads with the maps, and that **every surface serves
only the committed `demo/maps/`, never your own Supabase** — a boundary that was
added after a demo built against this repo listed fifteen maps rather than six,
nine of them real runs of real domains that nobody chose to publish. Widening
that flag would have opened the gallery and the spending door with one edit.

### What a visitor gets

- A box above the gallery, saying **how many runs are left today before they
  type** — not after they are refused — plus what a run costs them, which is
  about four minutes and roughly 230 entities. They are never quoted your bill.
- A live view of the run: phase, elapsed against the run's own estimate, hosts
  seen, entities placed, dollars spent.
- **Their run's link, before they need it.** The run is a background task on the
  server and closing the tab does not stop it, so the map lands at `/kb/<id>`
  whether they wait or not. That link is served **by id only** — the gallery
  stays the curated six, so visitors do not browse each other's runs and they
  never see yours.
- When the day is spent: no box, and a sentence saying when the count resets
  (00:00 UTC). Not a greyed-out form.

### What it requires

**Supabase.** The count is `select count(*) from runs where started_at >= today`,
and there is nowhere else to ask — an in-process counter forgets every run
started by another instance and resets on every restart. If the store cannot be
reached, `POST /api/map` answers **503 and starts nothing**: a reading that could
not be taken is not a licence to spend. The front page renders as the read-only
demo for as long as that lasts.

### What it does not do

It counts runs, not dollars. A run that fails at minute three still bought its
searches and still counts — which is the honest direction — but the allowance
itself cannot see Bright Data spend or a model that suddenly costs more. That is
what `OPENKB_DAY_CAP_USD` is for, and it is on by default underneath this one:
whichever of the two runs out first is the one that closes the door, and the
dollar cap is the one that stays true when the price of a run changes. And
neither is auth: if some of the maps should not be public, keep
`KB_USER`/`KB_PASSWORD` on too.

## Sizing the budget

A clone ships with the budget already on: **$0.41 a map, $5.00 a day, 3 maps a
visitor, 3 at a time.** `.env` being gitignored is no longer the same hazard it
was — the numbers live in the code, not in a file a clone does not get, and the
only way to have no budget is to write `off` on purpose.

What a map costs, so the numbers mean something. Measured two ways that agree:
six real runs through the deployed app came in at **$0.147–$0.202**, and a fit
over the 18 current-shape sweeps in `runs/` says `usd = 0.0146 + 0.0106 ×
queries`, which is **$0.205** for the 18 queries a 300s host affords. Between
58% and 77% of that is Bright Data SERP — exactly one call per fired query — and
the rest is the model.

So $5.00 a day is about 22 maps, and one visitor's three maps is about $0.62.
Raise `OPENKB_DAY_CAP_USD` for a busier day; it is the only one of the four most
deployments ever need to touch.

### What the caps do and do not cover

- The **run cap** is enforced *during* the run, against the span stream's own
  running total, which counts model, search and fetch alike. It trips below the
  cap — `max($0.05, 25% of it)` is held back — so that the calls already in
  flight when the line is crossed still fit underneath. A run therefore ends AT
  its cap, not past it.
- The **day cap** cannot be walked past by concurrency. A run still going is
  held against the budget at the most it can still cost and settles to its real
  cost when it ends, so N runs in flight commit N caps rather than nothing at
  all. A new run starts only if a whole cap still fits, which means the last few
  cents of a day go unspent rather than buying half a map.
- Turning the **run cap off keeps the day cap but weakens it**, from a ceiling
  to a preflight check: with nothing to reserve, several runs started together
  commit nothing and can carry the day past its limit before any of them records
  a cost. The two are worth keeping together.
- The **per-visitor limit** is only as good as the proxy in front of it. See the
  note above; on a bare box it degrades to one shared bucket, which is safe but
  blunt.
- A **stale `running` row** — a run whose instance died without writing its
  ending — is counted at its cap for the rest of the day. A deployment losing
  several runs a day will run out of budget early, which is the right answer to
  a deployment that is losing runs.

### The provider-side backstop

`OPENKB_CEILING_USD` is now optional and is not the budget. It is a preflight
check on the OpenRouter key's cumulative usage, which is useful for exactly one
thing the caps above cannot see: spending on the same key from somewhere else —
the CLI, `scripts/swarm.ts`, a second deployment. It still cannot stop a run
already under way, still meters no Bright Data, and still counts every other
project on that key. It no longer disappears on a typo: a malformed value
refuses every run and names itself.

Read the key's current usage first and set the base, so it counts from your
deploy rather than from the key's whole history:

```bash
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

`OPENKB_CEILING_BASE_USD` = that `usage` figure. `OPENKB_CEILING_USD` = what you are
willing to lose across everything on the key.

## Deploy

```bash
docker build -t open-kb .
docker run -p 3000:3000 --env-file .env open-kb
```

Or point Railway/Render/Fly at the repo; they will find the Dockerfile.

## Before you share the URL

If this is a **read-only** demo, the first three boxes collapse into one:

- [ ] `OPENKB_DEMO=1` set, `OPENKB_PUBLIC_RUNS_PER_DAY` unset, and
      `curl -X POST <url>/api/map -d '{"domain":"resend.com"}'` answers 403
- [ ] the front page shows six maps and no input box
- [ ] the gallery at `/kb` lists six maps, and one of them opens

If it is a demo that **buys runs for visitors**, add:

- [ ] `OPENKB_PUBLIC_RUNS_PER_DAY` set to a number you are willing to see
      multiplied by $0.20, and the front page says how many are left today
- [ ] `SUPABASE_URL` set and the schema run — without it every run is refused
      with a 503, on purpose
- [ ] one run started from the deployment itself, left to finish with the tab
      CLOSED, and its `/kb/<id>` link opened afterwards
- [ ] `scripts/supabase-schema.sql` re-run, so `runs.usd`, `runs.visitor` and
      the `claim_run` function exist — the budget counts from those two columns
      and claims through that function, and refuses every run without them
- [ ] `OPENKB_DAY_CAP_USD` set to a number you are willing to lose in one day,
      or left at its $5.00 default
- [ ] `OPENKB_VISITOR_SALT` set to anything unguessable
- [ ] `OPENKB_CEILING_USD` set as the provider-side backstop underneath it all

Otherwise, for a deployment that really is meant to run:

- [ ] `KB_USER` and `KB_PASSWORD` set, and you have opened the URL in a private window to confirm it asks
- [ ] `SUPABASE_URL` set, and `scripts/supabase-schema.sql` already run against that project
- [ ] the budget's defaults read and either accepted or raised — they are ON,
      so a deployment you run maps on yourself stops at $5.00 a day and three
      maps an address unless you say otherwise
- [ ] `OPENKB_CEILING_USD` and `OPENKB_CEILING_BASE_USD` set if the key is shared with anything else
- [ ] one run started and finished on the deployment itself, not just locally

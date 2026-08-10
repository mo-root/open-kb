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
| `OPENKB_CEILING_USD` | **on any public deployment** | ceiling on cumulative MODEL spend, checked before a run starts. It does not meter Bright Data, and it cannot stop a run already under way. Unset means unlimited |
| `OPENKB_CEILING_BASE_USD` | no | the key's usage reading when you deployed, so the ceiling counts from now rather than from the key's whole history |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | strongly recommended, **required on Vercel** | without them a container restart loses every run — and on Vercel there is no disk to fall back to, so runs are lost as soon as the instance goes |
| `OPENKB_RUNS_DIR` | **on Vercel**, set to `/tmp/openkb-runs` | where run JSON is written. Other hosts get it from `next.config.ts`; on Vercel that runs at build time on another machine, so it has to be a real project variable pointing at the only writable path |
| `OPENKB_DEMO` | **on any URL you hand to strangers** | `1` makes this a read-only demo: no run can be started, and the gallery serves the six committed maps. See below |
| `OPENKB_DEMO_MAPS_DIR` | no | which maps a demo serves. Unset, it finds `demo/maps/` itself. Deliberately **not** `OPENKB_RUNS_DIR`, which means something else |

## The three guards, and what each does not do

**Auth** decides who. It stops a stranger and a crawler. It does not stop an
invited person running two hundred maps.

**The ceiling** decides how much. It is read from the provider's own usage figure
rather than counted in the process, because a counter resets on restart and knows
nothing about runs started by another instance. It fails CLOSED: if the provider
cannot be reached, no run starts.

**Demo mode** decides whether. `OPENKB_DEMO=1` closes the one endpoint that can
spend, and it is the only one of the three that leaves a useful site behind
when it is on.

The first two are a pair — set both or neither leaves the obvious hole. The
third replaces the need for them, and the next section is about when to reach
for it instead.

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
- The map page says the same thing above a disabled input, so nobody types a
  domain into a control that is going to ignore them.
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

## Sizing the ceiling

`.env` is gitignored, so a clone ships with **no ceiling at all** — set one before
the deployment is reachable by anyone. `OPENKB_CEILING_USD=5` is the invite-gated
setting: enough for a couple of runs by someone you handed the link to.

Size it knowing what it does not cover. It is a **preflight** check on cumulative
OpenRouter usage, so:

- it cannot stop a run already under way — one stored run cost **$5.07 on its own**;
- concurrent requests all read the same figure and can start together past it;
- Bright Data spend is outside it entirely, and on the current config that is the
  larger share of the bill;
- a malformed value parses to `NaN` and silently disables the check.

Treat it as a brake on *starting* runs, not a cap on what a deployment can spend.
Until those gaps are closed, do not leave a deployment reachable without
`KB_USER`/`KB_PASSWORD` set.

Read the key's current usage first and set the base, so the ceiling counts
from your deploy:

```bash
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

`OPENKB_CEILING_BASE_USD` = that `usage` figure. `OPENKB_CEILING_USD` = what you are
willing to lose.

## Deploy

```bash
docker build -t open-kb .
docker run -p 3000:3000 --env-file .env open-kb
```

Or point Railway/Render/Fly at the repo; they will find the Dockerfile.

## Before you share the URL

If this is a public demo, the first three boxes collapse into one:

- [ ] `OPENKB_DEMO=1` set, and you have confirmed the Map button is disabled and
      `curl -X POST <url>/api/map -d '{"domain":"resend.com"}'` answers 403
- [ ] the gallery at `/kb` lists six maps, and one of them opens

Otherwise, for a deployment that really is meant to run:

- [ ] `KB_USER` and `KB_PASSWORD` set, and you have opened the URL in a private window to confirm it asks
- [ ] `OPENKB_CEILING_USD` set, and `OPENKB_CEILING_BASE_USD` set to the key's usage at deploy time
- [ ] `SUPABASE_URL` set, and `scripts/supabase-schema.sql` already run against that project
- [ ] one run started and finished on the deployment itself, not just locally

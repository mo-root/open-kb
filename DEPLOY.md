# Deploying open-kb

## Why not Vercel

A sweep takes one to twelve minutes and runs **detached** after its HTTP response
returns: `POST /api/map` answers immediately with a run id and the work carries on
in the background. Serverless kills the instance when the response is sent, so
every run would die the moment it started.

It needs a host that keeps the process alive. Railway, Render and Fly all work,
as does any box running `node`.

## What it needs

| Variable | Required | What it is |
|---|---|---|
| `BRIGHTDATA_API_TOKEN` | yes | Bright Data API token |
| `BRIGHTDATA_SERP_ZONE` | yes | name of a **SERP API** zone |
| `BRIGHTDATA_UNLOCKER_ZONE` | yes | name of a **Web Unlocker** zone |
| `OPENROUTER_API_KEY` | yes | model provider key |
| `KB_USER` / `KB_PASSWORD` | **on any public deployment** | basic auth. Unset means OPEN, and the start endpoint takes a domain and spends real money |
| `OPENKB_CEILING_USD` | **on any public deployment** | total dollars this deployment may ever spend. Unset means unlimited |
| `OPENKB_CEILING_BASE_USD` | no | the key's usage reading when you deployed, so the ceiling counts from now rather than from the key's whole history |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | strongly recommended | without them a container restart loses every run |

## The two guards, and what each does not do

**Auth** decides who. It stops a stranger and a crawler. It does not stop an
invited person running two hundred maps.

**The ceiling** decides how much. It is read from the provider's own usage figure
rather than counted in the process, because a counter resets on restart and knows
nothing about runs started by another instance. It fails CLOSED: if the provider
cannot be reached, no run starts.

Set both. Either alone leaves the obvious hole.

## Sizing the ceiling

A run costs roughly $0.50 at twenty queries and $2.00 at forty. Read the key's
current usage first and set the base, so the ceiling counts from your deploy:

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

- [ ] `KB_USER` and `KB_PASSWORD` set, and you have opened the URL in a private window to confirm it asks
- [ ] `OPENKB_CEILING_USD` set, and `OPENKB_CEILING_BASE_USD` set to the key's usage at deploy time
- [ ] `SUPABASE_URL` set, and `scripts/supabase-schema.sql` already run against that project
- [ ] one run started and finished on the deployment itself, not just locally

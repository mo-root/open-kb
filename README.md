<div align="center">

<img src="./assets/mark.svg" alt="" width="76" height="76" />

# open&#183;knowledge base

### One domain in, knowledge base out

[![MIT](https://img.shields.io/badge/License-MIT-4B8BFF?style=flat-square&labelColor=0a1628)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-4B8BFF?style=flat-square&labelColor=0a1628)](https://nodejs.org)
[![Powered by Bright Data](https://img.shields.io/badge/Powered%20by-Bright%20Data-22D3EE?style=flat-square&labelColor=0a1628)](https://brightdata.com)
[![Live demo](https://img.shields.io/badge/Live-demo-1b4fd8?style=flat-square&labelColor=0a1628)](https://open-kb-demo.vercel.app)

**[→ Try the beta](https://open-kb-demo.vercel.app)**

</div>

Point it at `stripe.com` and it maps the whole market — competitors,
substitutes, integrations, buyers, and where the market argues. It never
searches the company's name: it works out the job each product does and
searches for the job. Every claim carries a URL and a literal quote from a page
the run fetched, and the map exports as a folder of markdown your agent can
walk, with `llms.txt` at the door.

<img src="./assets/launch.gif" alt="The launch film: twenty known domains stream past, yourcompany.com snaps into place, its glyphs detonate into de-branded queries, settle into a rotating market orbit, crystallize into a labeled knowledge graph, and plug into an agent — one domain in, knowledge base out" width="100%" />

<sub>The launch film — [watch it with sound](./assets/launch.mp4)</sub>

<div align="center">

## [→ Open the demo](https://open-kb-demo.vercel.app)

[vercel.com](https://open-kb-demo.vercel.app/kb/sweep-vercel-com-202608062351) ·
[stripe.com](https://open-kb-demo.vercel.app/kb/sweep-stripe-com-202608070005) ·
[brightdata.com](https://open-kb-demo.vercel.app/kb/sweep-brightdata-com-202608042230)
— or [read a map as markdown](./examples/kb-clerk-com/README.md)

</div>

## Quickstart

Node 20+, a [Bright Data](https://brightdata.com) account with a SERP and an
Unlocker zone, and an [OpenRouter](https://openrouter.ai) key.

```bash
git clone https://github.com/mo-root/open-kb.git && cd open-kb && pnpm install
cp .env.example .env      # four keys, named in the file
pnpm sweep stripe.com
```

```
runs/sweep-stripe-com-<stamp>.json   every entity, edge and span

kb-stripe-com/                       pnpm run export <run>
├── entities/     one file per company, with its quotes
├── relations/    competitor · substitute · integration · buyer
├── segments/     each market, and who is in it
└── llms.txt      the door an agent comes in through
```

## How it works

Five agents make the judgement calls — what the company sells, what to search,
when to widen, what a host is, how two entities relate. Each one is a markdown
prompt in [`prompts/`](./prompts) you can edit. Around them, code holds the
guarantees: a citation must be a literal substring of bytes the run stored, a
`competitor` verdict needs that host's own readable page, an edge needs both
ends to exist, and every paid call lands on the run's live meter under a hard
cap.

A second engine, the swarm, buys depth on top of the sweep's breadth: a lead
agent funds missions on a priced board and six lanes work them.
[ARCHITECTURE.md](./ARCHITECTURE.md) covers both engines phase by phase;
[DEPLOY.md](./DEPLOY.md) covers putting it on a host.

## Every command

```bash
set -a && source .env && set +a   # the CLI reads keys from the shell

pnpm sweep stripe.com        # breadth: the map
pnpm swarm stripe.com 5      # depth, with a ceiling
pnpm run export <run> vault  # the map as a folder of markdown
pnpm run diff a.json b.json  # what moved between two runs of one anchor
pnpm run audit <run>         # deal a review packet, score it symmetrically
pnpm test                    # 1,387 tests, no network, no keys

cd packages/web && pnpm dev  # the app, http://localhost:3210
```

## Drive it from your coding agent

An [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
at [`skills/mapping-markets`](./skills/mapping-markets) teaches Claude Code and
other agents to run maps, read them, and tune the query doctrine:

```bash
npx skills add mo-root/open-kb/skills/mapping-markets
```

## Stack

**Bright Data** (SERP API, Web Unlocker) for searches that do not get blocked ·
**OpenRouter** via AI SDK 7, answers typed with Zod · **Next.js 16** for the
app · **Supabase** optional locally, required on Vercel.

## License

MIT. Use it, fork it, ship it.

<div align="center">

<sub>Built on Bright Data's web infrastructure. Not affiliated with, endorsed by, or sponsored by Bright Data.</sub>

</div>

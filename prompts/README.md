# Prompts

This is what the agent actually reads. Everything here is loaded from disk at runtime — edit a
file, run again, behaviour changes. No rebuild, no code change, no deploy.

If you want to change how open-kb thinks, you change these files. Not the TypeScript.

## The two kinds of file

**`doctrine/`** — knowledge. What is true about finding a market, written once and shared by every
agent that needs it. Numbered, because it has a reading order: the agent reads it top to bottom
before it does anything.

**`agents/`** — roles. Who you are, what you were handed, how you finish. Short. An agent file
declares which doctrine it needs and the loader stitches them together.

Doctrine is numbered because knowledge has an order. Agents are not, because there is no fixed
order in which agents run — the run decides that.

## What each doctrine file owns

| file | owns |
|---|---|
| `01-the-thesis.md` | Why searching a company's own words only returns that company. What a run produces. |
| `02-relations.md` | The relations — eight commercial (competitor, substitute, adjacent, shaper, dependency, integration, buyer, target) and three channel (covers, lists, discusses) — and the test that separates each from its nearest neighbour. |
| `03-evidence.md` | What a claim must carry, and why recording *is* the job. |
| `04-search-craft.md` | How to compose a query and what kind of page each shape buys. |
| `05-reading-the-web.md` | How to read a company and a page cheaply, and when an expensive fetch earns its cost. |
| `06-breadth.md` | Why the map is the ecosystem and not the shortlist. |
| `07-query-families.md` | The plain, debranded and branded query families — which door each opens, and why debranded means de-anchored, not de-named. |

## How composition works

`agents/investigator.md` starts with:

```yaml
---
agent: investigator
includes: [01-the-thesis, 02-relations, 03-evidence, 04-search-craft, 05-reading-the-web, 06-breadth]
---
```

At runtime the loader reads each named doctrine file, concatenates the bodies in that order, and
appends the agent's own body last. That whole string becomes the system prompt.

To see exactly what an agent receives:

```
npx tsx scripts/show-prompt.ts investigator
```

## The house style, and why

Every rule in here states **the failure that motivated it**. This is not decoration. A rule without
its failure reads as somebody's preference, and the next person to touch the file deletes it. With
the failure attached, it survives.

So the files read like:

> Never batch to the end. A run can stop at any moment — the budget runs out, a fetch hangs, the
> step limit is reached — and anything not yet written is lost.

rather than "record findings incrementally."

The rest of the style:

- **Second person, addressed to a competent colleague.** Assume intelligence, supply judgement.
- **No numbered ladders, no if/then chains.** If you find yourself writing "first try X, then Y",
  you are writing a pipeline. Write the judgement that would choose X instead. Every fixed order we
  have shipped turned out to be wrong for half the companies we pointed it at.
- **Real numbers from real runs.** "Category-shaped queries returned roughly twice the distinct
  vendors" beats "prefer category queries". The measurements in these files came from firing real
  queries at real search engines; keep them accurate, and update them when we measure again.
- **Examples de-branded.** The doctrine must not read as being about one company.

## Length is emphasis

Every doctrine file is concatenated into one system prompt, so every line competes with every other
line for the agent's attention.

This is not a theoretical concern. A live run once searched twelve times, read thirteen pages,
correctly identified twelve real competitors — and recorded **none of them**, returning an essay
instead. The doctrine at the time gave four rich sections to searching and one thin paragraph to
recording. The agent optimised for what the doctrine emphasised. Splitting recording into its own
file and stating it plainly fixed it on the next run.

If you add a section, ask what it displaces.

## Before you commit an edit

```
pnpm test
```

`packages/core/tests/prompts.test.ts` checks that every file's declared identity matches its
filename, that every name in an `includes` list resolves, that the composed prompt still contains
distinctive text from each included file, and that it stays inside a size ceiling. A doctrine file
silently dropped from an `includes` list fails the suite rather than a demo.

The size ceiling is deliberate and currently has little headroom. The next file added will force a
real decision about what comes out.

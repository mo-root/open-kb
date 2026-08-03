# Overnight brief

What each loop iteration does, so the work is the same whether it runs at 2am or 5am.

## Start here

An audit checked 207 entities from a real map against the live web: **86 right, 121 wrong**. Every
error was the same one. The classifier receives a hostname, three titles and one description, and is
asked to be certain, so it promotes anything ranking for the market's vocabulary into a competitor.
A comparison site that ranks the anchor #1 was recorded as a rival selling proxies; a host whose
name contained "llm" was given a proxy network it does not have.

The prompt has been told to stop guessing, which is a floor rather than a fix. **The fix is to
classify from fetched front pages instead of snippets**, and the doctrine has said so all along:
"when you need to know what a host is, fetch its front page. It is free and it is definitive."

A direct fetch costs $0 and about a second, and runs concurrently. Four hundred hosts is under a
minute of wall clock and nothing on the bill. This is the first thing to build, and the first
overnight run should measure it: same anchor, same query count, classification from snippets versus
from fetched pages, and how many of the audit's named failures survive.

## The question being answered

Every measurement in this repo comes from `brightdata.com` and `resend.com`. Both publish an
`llms.txt` and both sell developer tools. The tool is supposed to map an industrial pump
manufacturer just as well, and nobody has ever checked.

So: **which markets does it fail on, and how.**

## Budget

`$15`, self-imposed, on top of the harness's own guard. `scripts/overnight.ts` re-reads the
OpenRouter key limit before every run and stops while `$3` of headroom remains, because a sweep cut
off by a 402 mid-classification has bought every search and kept none of them.

If the key reports less than `$3`, stop the loop and say so. Do not work around it.

## One iteration

1. **Check the budget.** Read the key's headroom. Under `$3`, stop.
2. **Run the next unmapped target.** `pnpm sweep <domain> 30`. One at a time, so a failure is
   attributable.
3. **Record the row.** Append to `runs/overnight/results.jsonl`: domain, entities, hosts, products,
   markets, uncovered markets, cost, seconds, and the error if it failed.
4. **Read the map, not the numbers.** Open the run's entities. Are they real companies in that
   market? Is the relation right read from the anchor outward? Is the `why` line specific enough to
   act on? A run that produced 200 entities of the wrong market is a failure with a healthy count.
5. **If something broke, decide what kind of break it is** (below), fix that class, commit, and
   re-run that one target to verify.
6. **Write the finding down** in `runs/overnight/FINDINGS.md` whether or not it was fixed.

## Optimisation is half the job

Fixing breaks is the floor. The other half is finding cheaper and faster ways to do what already
works, and every run is an experiment that costs money whether or not anything is learned from it.

The measurements to keep taking, because each one has already moved a number today:

- **Where the wall clock goes**, per stage, per run. Classification was 63% of it before the batches
  ran concurrently. Search was next, until the chunk barrier came out. Look at the phase log of every
  run rather than the total.
- **Output tokens against the answer's own size.** Output is 90% of the model bill at six times the
  input price. A stage emitting far more than its answer needs is thinking, and thinking is worth
  paying for on judgement and worthless on labelling.
- **Yield per query.** New hosts each round buys, and where it drops off. A round returning almost
  nothing new is money spent on corroboration.
- **Yield per page.** Pages two through four of a query against page one.
- **What each stage would cost on a smaller model.** Classification with reasoning at minimum is a
  labelling task against a fixed vocabulary, which is the workload a cheaper model exists for.

Try things. A change with a measurement behind it is worth committing even if the gain is small, and
a change without one is not worth committing even if it feels obvious.

## What counts as worth fixing overnight

Fix, commit and re-run:

- A crash, hang or unhandled error.
- A stage that silently produced nothing: no products, no capabilities, no queries for a core
  market.
- A prompt rule that measurably misfires, the way equal-per-market coverage sent a third of a small
  budget to an MCP integration.
- Anything where the code and a comment disagree about what happens.

Write down, do not fix:

- Anything needing a judgement about what the product should be.
- Anything where the fix is a guess and the run cost more than $2 to reproduce.
- Ranking, weighting or scoring changes with no measurement behind them.
- Anything touching `packages/core/src/evidence.ts`. The mint is the guarantee.

## Rules

- **Never raise the budget**, in the script or on the key.
- **Never delete a run file.** They are the evidence.
- `pnpm check` and `pnpm vitest run` must both pass before any commit.
- One fix per commit, with the measurement that justified it in the message.
- The branch is `overnight/2026-08-03`, cut from `feat/foundation-and-investigator`. Everything lands
  there. Do not merge, do not rebase, do not touch `main` or the parent branch, do not push. The
  point of a separate branch is that a bad night is one `git branch -D` away.
- A failing target is a result. Record it and move on rather than fighting one domain all night.

## Stopping

Stop and write the summary when any of these is true:

- The key has under `$3` of headroom.
- `$15` has been spent.
- Every target in `scripts/overnight.ts` has a row.
- The same fix has failed to hold twice. Something is wrong with the diagnosis, and a third attempt
  is spending money to confirm it.

## The morning report

`runs/overnight/FINDINGS.md`, in this order:

1. Which markets mapped well, which failed, and the failure mode for each.
2. What was fixed, with the before and after.
3. What was found and left alone, and why.
4. Every optimisation tried, the measurement before and after, and the ones that did not work.
   A change that was tried and abandoned is worth as much as one that landed, because otherwise it
   gets tried again.
5. The one thing most worth doing next, with the evidence for it.

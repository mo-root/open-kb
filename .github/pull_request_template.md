## What and why

## Testing

- [ ] `pnpm check && pnpm test` pass, zero failures, zero new skips
- [ ] If this adds a stage, flag, or agent: `.env.example` and the README's
      stage table updated to match
- [ ] If this touches `packages/core`: still clean under
      `scripts/check-core-purity.mjs` (part of `pnpm check`)

No live or paid run needed for most changes — see `CONTRIBUTING.md`. If this
PR genuinely needs one to prove (a new provider parameter, a real rate-limit
response), say so here and point at the `tests/live/*.live.test.ts` file that
covers it.

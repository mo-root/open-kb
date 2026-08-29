import path from "node:path"
import { defineConfig } from "vitest/config"

// `packages/web` colocates its tests beside the code they cover, following v1,
// so the pattern has to reach those too. It did not, and a new store's whole
// test file was collected by nothing and reported as neither passing nor
// failing: the suite went green while the code was untested.
//
// `{ts,tsx}` is that same failure, one extension later and not yet sprung.
// 35 of the 38 files under `components/` are `.tsx` — the three that are not
// are two index barrels and a types module — so a test named after the thing it
// covers is `Foo.test.tsx` essentially every time, and `*.test.ts` matches none
// of those. It matches zero files today and no test is missing; the trap is the
// FIRST component test anyone writes, disappearing exactly the way the store's
// file did. An empty glob is not a defect and no coverage was invented to fill
// it — only the extension was widened, everywhere, so the same slip cannot
// arrive through `lib/`, `tests/` or a package's `tests/` either. A `.test.tsx`
// with real JSX in it both collects and runs once the brace is there; esbuild's
// automatic runtime finds React in the web package, so nothing else was needed.
//
// This stays an ALLOWLIST of directories rather than becoming `**/*.test.{ts,tsx}`
// minus exclusions. Three trees on this disk hold test files that are not ours:
// `node_modules`, the gitignored `inspiration/` reference checkouts, and a
// `.claude/worktrees/` copy of this repo that another agent is editing right
// now. That is not hypothetical — swapping this include for
// `**/*.test.{ts,tsx}` was measured, and it collects 107 files instead of 60:
// our 60 plus 47 belonging to the worktree, because vitest's default excludes
// drop that copy's node_modules but not the copy. "Everything except" would
// have to predict directories nobody has created yet, and its failure mode is
// running someone else's suite as ours and believing the result. The
// allowlist's failure mode is a test that never runs, and that one is now
// guarded: scripts/check-test-collection.mjs fails, naming the file, when a
// first-party test is collected by nothing. Silent became loud, which was the
// only real charge against naming directories.
//
// `packages/*/tests/**` already generalizes over packages, so a new top-level
// package needs no edit here. The gap an allowlist keeps is a package that
// colocates the way `web` does — and `packages/web/app/**` is deliberately NOT
// listed ahead of a test existing there, because adding a directory with no
// tests in it is the same empty glob this comment just spent a paragraph
// declining to treat as a bug. The day someone writes `app/foo.test.tsx`, the
// guard names the file and the fix is this list, one line.
export default defineConfig({
  // `@/…` is `packages/web`'s tsconfig path alias, and it is how every module in
  // that app imports its own siblings. tsc and Next both resolve it; vitest did
  // not, so importing any web module that uses it failed at collection with
  // "Cannot find package '@/lib/theme'" — the module under test never loaded.
  //
  // The alias is REPO-WIDE here, which is wider than the tsconfig that defines
  // it. Nothing outside `packages/web` writes `@/` today (the other packages are
  // NodeNext and use relative or workspace specifiers), so the cost is
  // hypothetical: a future `packages/core` test importing `@/foo` would resolve
  // into the web app instead of failing. Vite's alias matches on the specifier,
  // not on the importer, so scoping it properly is not available — the honest
  // record is this paragraph rather than a scope that does not exist.
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "packages/web") },
  },
  test: {
    include: [
      "tests/**/*.test.{ts,tsx}",
      "packages/*/tests/**/*.test.{ts,tsx}",
      // `app/**` was left off deliberately while nothing lived there; see the
      // last paragraph above. `app/global-error.test.tsx` is that first test.
      "packages/web/app/**/*.test.{ts,tsx}",
      "packages/web/lib/**/*.test.{ts,tsx}",
      "packages/web/components/**/*.test.{ts,tsx}",
      // Direct children of `packages/web/` itself — not recursive, so it does
      // not widen into any of the three trees above. `middleware.ts` is the
      // first test to live here (see `middleware.test.ts`'s own doc comment
      // for how this gap was found: `check-test-collection.mjs` named it).
      "packages/web/*.test.{ts,tsx}",
      // Same story one level deeper: `packages/web/scripts/` sat outside
      // every glob above until `bake-layouts.test.ts` needed it (see that
      // file's own doc comment). Non-recursive for the same reason as the
      // line above — `scripts/` holds one file today, not a tree.
      "packages/web/scripts/*.test.{ts,tsx}",
    ],
  },
})

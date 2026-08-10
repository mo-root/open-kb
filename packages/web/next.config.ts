import { readFileSync } from "node:fs"
import path from "node:path"
import type { NextConfig } from "next"

const repoRoot = path.resolve(import.meta.dirname, "../..")

/**
 * The credentials live in the repo root's `.env`, and Next only looks in the app
 * directory. Rather than keep a second copy of live API tokens next to a
 * Next.js app, or a symlink that a fresh clone would not have, the root file
 * is read here, at config time, in the same Node process that then serves every
 * route.
 *
 * Existing values always win, so a real environment variable (CI, a shell
 * export, `next start` behind a process manager) is never overwritten by a file
 * that happens to be lying around.
 */
function loadRepoEnv(): void {
  let text: string
  try {
    text = readFileSync(path.join(repoRoot, ".env"), "utf8")
  } catch {
    return // no root .env — the route's own preflight will say what is missing
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!
    if (process.env[key] !== undefined) continue
    let value = (m[2] ?? "").trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

loadRepoEnv()

/**
 * Where finished runs are written (lib/runs.ts).
 *
 * Set here for the same reason `.env` is read here: on a long-lived server this
 * config is evaluated in the Node process that then serves every route, so it
 * is the one place that reliably knows where the repo root is. A route
 * resolving it from `process.cwd()` would be resolving from `packages/web`
 * under `next dev` and from somewhere else again under a different launcher.
 *
 * `??=` so an explicit environment variable still wins.
 *
 * NOT ON A BUILD-ONCE-RUN-ELSEWHERE HOST, and the guard is the whole point.
 * The sentence above — "the same process that serves every route" — is true of
 * `next dev`, `next start` and the Dockerfile, and false on Vercel, where this
 * file runs at BUILD time on a build machine that is not the machine serving
 * anything. Nothing assigned here survives into the lambda, so on Vercel this
 * line is not merely useless: if it did carry, it would carry
 * `/vercel/path0/runs`, a path that does not exist at runtime, in place of the
 * `/tmp` fallback lib/runs.ts can actually write to. Left unset, the runtime
 * resolves it itself from a real project environment variable.
 */
if (!process.env.VERCEL) {
  process.env.OPENKB_RUNS_DIR ??= path.join(repoRoot, "runs")
}

/**
 * No workflow wrapper. The v1 app wrapped this config in `withWorkflow()` and
 * started runs with `start(buildWorkflow)`. That `"use step"` sandbox is what
 * this rewrite exists to escape: a run here is a plain async function writing
 * into a `SpanStream` held by an in-memory registry (lib/runs.ts).
 */
const nextConfig: NextConfig = {
  // Pin the workspace root so a stray lockfile elsewhere on the machine is not
  // picked as the root, there are several above this directory.
  turbopack: { root: repoRoot },

  /**
   * The same pin for the file tracer, which is a different mechanism from
   * `turbopack.root` and was left to inference.
   *
   * Inference reads lockfiles, so it lands on this repo root by luck of there
   * being a `pnpm-lock.yaml` there — and `outputFileTracingIncludes` below
   * resolves its globs against this value. A tracing root that moved would move
   * those globs with it and silently include nothing, which is the failure this
   * whole block exists to prevent. Stated, so it cannot drift.
   */
  outputFileTracingRoot: repoRoot,

  /**
   * Ship `prompts/` with the map route. WITHOUT THIS, EVERY RUN DIES ON A
   * SERVERLESS HOST, and not for any reason to do with how long a run takes.
   *
   * `promptsRoot()` in packages/sweep finds the directory by walking the
   * filesystem at run time. Next's tracer works by following imports, and a
   * filesystem walk is not an import — there is nothing in the module graph
   * that names these files, so the tracer has never had a reason to copy them.
   * Verified rather than assumed: before this entry, the traced set for
   * `/api/map` was 111 files and exactly zero of them were under `prompts/`.
   * The 96KB of doctrine and agent instructions simply was not in the bundle,
   * and the first model call of the first run threw "cannot find prompts/".
   *
   * This is the entire reason a naive deploy of this app looks like proof that
   * serverless does not work. It fails in the first seconds, nowhere near any
   * duration limit, and the error names a missing directory rather than a
   * missing build step.
   *
   * The key is a route path, not a glob over source files: only `/api/map`
   * starts a sweep, so only that lambda pays the 96KB.
   *
   * `../../` IS LOAD-BEARING AND IS NOT RELATIVE TO THE TRACING ROOT. The
   * obvious spelling, `./prompts/**\/*`, is what the Next documentation's
   * examples look like and it silently matches nothing here — verified, twice:
   * the config parsed (it is echoed in `.next/required-server-files.json`) and
   * the traced set stayed at 111 files with zero prompts in it. A glob that
   * matches nothing is not an error, it contributes no files and the build goes
   * green.
   *
   * The reason is in `next/dist/build/collect-build-traces.js`: the include
   * globs run through `glob(pattern, { cwd: dir })` where `dir` is the PROJECT
   * directory, and are then resolved with `path.join(dir, file)`. `dir` here is
   * `packages/web`, so `./prompts` means `packages/web/prompts`, which does not
   * exist. `outputFileTracingRoot` bounds what MAY be included; it is not what
   * the globs are measured from. Two `..` climb out of the app to the repo root
   * where `prompts/` actually is, and that is still inside the tracing root, so
   * it is allowed.
   */
  /**
   * The second half of this entry is `demo/maps/` — the six committed maps a
   * read-only deployment serves (demo/README.md), and the same class of file as
   * `prompts/` in every way that matters to the tracer: read off the filesystem
   * at run time, named by no import, therefore invisible to it. Both globs
   * carry the same `../../`, for the reason spelled out above; both are inside
   * the tracing root; and they live in one option because they are one problem.
   *
   * WHY A SEPARATE KEY, and a wide one. `prompts/` belongs to `/api/map` alone
   * because only that route starts a sweep. The maps belong to the opposite
   * set: every route that reads the runs directory, which today is four pages
   * (`/kb`, `/kb/[id]`, `/runs`, `/runs/[id]`) and six API routes under
   * `/api/kb` and `/api/run`, and tomorrow is whatever else calls
   * `listStoredRuns`. Enumerating ten route paths here would put the demo one
   * forgotten line away from a gallery that renders "Nothing mapped yet." on a
   * deployment carrying every map it needs — the failure mode `demoMapsDir`
   * throws to avoid, arriving through the build instead of the runtime. So the
   * key is the whole app.
   *
   * WHAT THE WIDTH COSTS, measured rather than waved at: 8.4MB per function
   * that gets it. Vercel's limit is 250MB uncompressed per function, the files
   * are read on demand rather than loaded at boot, and the alternative is a
   * list that has to be maintained in step with the routes. Bandwidth is the
   * cheap side of that trade.
   *
   * The one function that does NOT want them is the one that cannot be reached
   * in demo mode anyway, and 8.4MB is a rounding error next to the engine it
   * already bundles.
   */
  outputFileTracingIncludes: {
    "/api/map": ["../../prompts/**/*"],
    "/**": ["../../demo/maps/*.json"],
  },
  // The engine packages resolve to raw TypeScript (`main: ./src/index.ts`), so
  // the bundler has to compile them rather than treat them as prebuilt deps.
  transpilePackages: ["@open-kb/core", "@open-kb/providers", "@open-kb/sweep"],

  /**
   * Why this app runs on webpack rather than turbopack.
   *
   * `packages/core` and `packages/providers` are NodeNext ESM, so every internal
   * specifier carries the extension the runtime will use: `export * from
   * "./evidence.js"` in a file that is actually `evidence.ts`. TypeScript and
   * Node both understand that; Turbopack does not remap it, and every import
   * inside the engine fails with `Can't resolve './evidence.js'`, ten of them,
   * before a single route can be served.
   *
   * `extensionAlias` is webpack's answer to exactly this, and it is one line.
   * The alternatives were worse: point the packages at their compiled `dist`
   * (a build step before every `dev`, and no HMR across the workspace), or edit
   * core's specifiers (which this task is explicitly not allowed to do, and
   * should not want to, NodeNext is correct for a package meant to run under
   * plain `node`).
   *
   * `next dev --webpack` in package.json is the other half of this; without the
   * flag Next 16 defaults to Turbopack and ignores everything below.
   */
  webpack(config) {
    config.resolve = config.resolve ?? {}
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    }
    return config
  },
}

export default nextConfig

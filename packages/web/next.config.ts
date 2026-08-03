import { readFileSync } from "node:fs"
import path from "node:path"
import type { NextConfig } from "next"

const repoRoot = path.resolve(import.meta.dirname, "../..")

/**
 * The credentials live in the REPO ROOT's `.env`, and Next only looks in the app
 * directory. Rather than keep a second copy of live API tokens next to a
 * Next.js app — or a symlink that a fresh clone would not have — the root file
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
 * Set here for the same reason `.env` is read here: this config is evaluated in
 * the Node process that then serves every route, so it is the one place that
 * reliably knows where the repo root is. A route resolving it from
 * `process.cwd()` would be resolving from `packages/web` under `next dev` and
 * from somewhere else again under a different launcher.
 *
 * `??=` so an explicit environment variable still wins.
 */
process.env.OPENKB_RUNS_DIR ??= path.join(repoRoot, "runs")

/**
 * NO WORKFLOW WRAPPER. The v1 app wrapped this config in `withWorkflow()` and
 * started runs with `start(buildWorkflow)`. That `"use step"` sandbox is what
 * this rewrite exists to escape: a run here is a plain async function writing
 * into a `SpanStream` held by an in-memory registry (lib/runs.ts).
 */
const nextConfig: NextConfig = {
  // Pin the workspace root so a stray lockfile elsewhere on the machine is not
  // picked as the root — there are several above this directory.
  turbopack: { root: repoRoot },
  // The engine packages resolve to raw TypeScript (`main: ./src/index.ts`), so
  // the bundler has to compile them rather than treat them as prebuilt deps.
  transpilePackages: ["@open-kb/core", "@open-kb/providers", "@open-kb/sweep"],

  /**
   * WHY THIS APP RUNS ON WEBPACK AND NOT TURBOPACK.
   *
   * `packages/core` and `packages/providers` are NodeNext ESM, so every internal
   * specifier carries the extension the runtime will use: `export * from
   * "./evidence.js"` in a file that is actually `evidence.ts`. TypeScript and
   * Node both understand that; Turbopack does not remap it, and every import
   * inside the engine fails with `Can't resolve './evidence.js'` — ten of them,
   * before a single route can be served.
   *
   * `extensionAlias` is webpack's answer to exactly this, and it is one line.
   * The alternatives were worse: point the packages at their compiled `dist`
   * (a build step before every `dev`, and no HMR across the workspace), or edit
   * core's specifiers (which this task is explicitly not allowed to do, and
   * should not want to — NodeNext is correct for a package meant to run under
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

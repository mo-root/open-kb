import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * scripts/build-demo-maps.ts had zero test coverage anywhere:
 * `packages/web/lib/demo-maps.test.ts` reads the six committed files in
 * `demo/maps/` back through the app's own loader, but never runs the script
 * that writes them. Nothing on disk exercised its two loud-failure guards
 * (missing source, malformed source), the `searched`-drop, or the
 * clear-before-rebuild step that removes a map dropped from `PICKS`.
 *
 * The script resolves `FROM`/`TO` from `import.meta.dirname`, not
 * `process.cwd()` — `ROOT = resolve(import.meta.dirname, "..")` — so unlike
 * the `runInEmptyClone` scripts (see
 * seven-scripts-crashed-on-a-runs-directory-that-does-not-exist.test.ts),
 * running it from a scratch `cwd` would NOT sandbox it: it would still
 * resolve `FROM`/`TO` to this repo's real `runs/` and `demo/maps/`, and the
 * clear-before-rebuild step deletes every `.json` already in `TO` before it
 * reads a single source file. Running the unmodified script against the
 * real tree in a container with no `runs/` (every sandboxed fire's own
 * constraint, see build-demo-maps.ts's own PICKS comment) would delete the
 * six committed maps and then throw.
 *
 * So the fixture copies the script's own source into a throwaway root and
 * runs it from THERE: `<tmp>/scripts/build-demo-maps.ts` resolves
 * `ROOT` to `<tmp>`, `FROM` to `<tmp>/runs`, `TO` to `<tmp>/demo/maps` — the
 * real script, unmodified, fully sandboxed by the same path arithmetic it
 * uses in production.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url))
const SCRIPT_SRC = readFileSync(join(REPO, "scripts", "build-demo-maps.ts"), "utf8")
const tsx = join(REPO, "node_modules", ".bin", "tsx")

const PICKS = [
  "sweep-shopify-com-20260823201634.json",
  "sweep-openai-com-20260823191503.json",
  "sweep-stripe-com-20260823130137.json",
  "sweep-cloudflare-com-20260823162255.json",
  "sweep-datadoghq-com-20260823193440.json",
  "sweep-figma-com-20260823125953.json",
] as const

/** A sandboxed root with the script copied into `scripts/`, so its own
 *  `import.meta.dirname`-relative `ROOT` lands inside the temp dir instead
 *  of this repo. */
function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "openkb-demo-maps-"))
  mkdirSync(join(dir, "scripts"), { recursive: true })
  mkdirSync(join(dir, "runs"), { recursive: true })
  writeFileSync(join(dir, "scripts", "build-demo-maps.ts"), SCRIPT_SRC, "utf8")
  return dir
}

function run(dir: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(tsx, [join(dir, "scripts", "build-demo-maps.ts")], { encoding: "utf8" })
    return { status: 0, stdout, stderr: "" }
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") }
  }
}

function fixtureRun(extra: Record<string, unknown> = {}) {
  return { anchor: "example.com", entities: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }], searched: [{ q: "example" }], ...extra }
}

describe("build-demo-maps.ts, sandboxed away from the real runs/ and demo/maps/", () => {
  it("throws its own named error when the first pick is missing from runs/, not a bare ENOENT", () => {
    const dir = makeSandbox()
    try {
      const { status, stderr } = run(dir)
      expect(status).not.toBe(0)
      expect(stderr).toContain(`${PICKS[0]} is not in runs/ — cannot rebuild demo/maps/ without it`)
      expect(stderr).not.toContain("ENOENT")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("throws its own named error when a pick's file has no anchor/entities, not a JSON.parse or undefined crash", () => {
    const dir = makeSandbox()
    try {
      writeFileSync(join(dir, "runs", PICKS[0]), JSON.stringify({ notASweepResult: true }), "utf8")
      const { status, stderr } = run(dir)
      expect(status).not.toBe(0)
      expect(stderr).toContain(`${PICKS[0]} is not a sweep result — it has no anchor and entities`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("drops `searched`, keeps everything else, and clears a stale map no longer in PICKS", () => {
    const dir = makeSandbox()
    try {
      for (const file of PICKS) {
        writeFileSync(join(dir, "runs", file), JSON.stringify(fixtureRun()), "utf8")
      }
      // A leftover map from a prior PICKS list — proves the clear-before-rebuild
      // step (build-demo-maps.ts:169-171) actually removes it rather than
      // leaving it to linger as a gallery card this file no longer mentions.
      mkdirSync(join(dir, "demo", "maps"), { recursive: true })
      writeFileSync(join(dir, "demo", "maps", "sweep-stale-example-com-000.json"), "{}", "utf8")

      const { status, stdout, stderr } = run(dir)
      expect(stderr).toBe("")
      expect(status).toBe(0)

      const outFiles = readdirSync(join(dir, "demo", "maps")).sort()
      expect(outFiles).toEqual([...PICKS].sort())

      for (const file of PICKS) {
        const written = JSON.parse(readFileSync(join(dir, "demo", "maps", file), "utf8"))
        expect(written).not.toHaveProperty("searched")
        expect(written.anchor).toBe("example.com")
        expect(written.entities).toHaveLength(2)
      }

      expect(stdout).toContain(`demo/maps/ — ${PICKS.length} maps`)
      expect(stdout).toContain("total")
      expect(stdout).toContain("on disk")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

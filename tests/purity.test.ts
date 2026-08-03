import { describe, it, expect, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"

const PROBE_DIR = "packages/core/src"
const PROBE_FILE = join(PROBE_DIR, "__purity-probe.ts")

function runChecker(): { status: number; output: string } {
  // stdio: "pipe" is required — execFileSync's undocumented-in-practice default echoes the
  // child's stderr straight to this process's stderr in addition to capturing it, which would
  // spam violation output into the test run even on expected failures.
  try {
    const output = execFileSync("node", ["scripts/check-core-purity.mjs"], {
      encoding: "utf8",
      stdio: "pipe",
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { status: e.status, output: `${e.stdout}${e.stderr}` }
  }
}

describe("core purity", () => {
  it("core contains no env access, DOM, or vendor names", () => {
    const run = () => execFileSync("node", ["scripts/check-core-purity.mjs"], { encoding: "utf8" })
    expect(run).not.toThrow()
  })

  describe("bypass hardening", () => {
    afterEach(() => {
      if (existsSync(PROBE_FILE)) rmSync(PROBE_FILE)
    })

    it("catches process.env accessed via optional chaining", () => {
      writeFileSync(PROBE_FILE, `export const a = process?.env?.API_KEY\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("process.env — credentials are a parameter")
    })

    it("catches process.env with incidental whitespace", () => {
      writeFileSync(PROBE_FILE, `export const a = process . env\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("process.env — credentials are a parameter")
    })

    it("catches document accessed via optional chaining", () => {
      writeFileSync(PROBE_FILE, `export const a = document?.title\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("DOM API in a headless engine")
    })

    it("catches window accessed via optional chaining", () => {
      writeFileSync(PROBE_FILE, `export const a = window?.location\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("DOM API in a headless engine")
    })

    it("does not false-positive on identifiers that merely end in 'window'", () => {
      writeFileSync(PROBE_FILE, `export const a = somewindow.foo\n`)
      const { status } = runChecker()
      expect(status).toBe(0)
    })

    it("catches process.env split across lines, where no single line contains the full match", () => {
      // A line-by-line scan would miss this: neither "process" nor ".env" nor ".API_KEY"
      // alone matches process.env — only the joined text does.
      writeFileSync(PROBE_FILE, `export const a = process\n  .env\n  .API_KEY\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("process.env — credentials are a parameter")
    })
  })

  describe("HTTP framing", () => {
    afterEach(() => {
      if (existsSync(PROBE_FILE)) rmSync(PROBE_FILE)
    })

    it("catches a direct fetch( call", () => {
      writeFileSync(PROBE_FILE, `export const a = fetch("https://example.com")\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("HTTP framing")
    })

    it("catches XMLHttpRequest", () => {
      writeFileSync(PROBE_FILE, `export const a = new XMLHttpRequest()\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("HTTP framing")
    })

    it("catches new Request(", () => {
      writeFileSync(PROBE_FILE, `export const a = new Request("https://example.com")\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("HTTP framing")
    })

    it("catches a static import of node:http", () => {
      writeFileSync(PROBE_FILE, `import http from "node:http"\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("HTTP framing")
    })

    it("catches a static import of node:https", () => {
      writeFileSync(PROBE_FILE, `import https from "node:https"\n`)
      const { status, output } = runChecker()
      expect(status).not.toBe(0)
      expect(output).toContain("HTTP framing")
    })

    it("does not false-positive on identifiers that merely contain 'fetch'", () => {
      writeFileSync(
        PROBE_FILE,
        `export interface X { fetchedAt: string }\nexport const hasFetched = (x: X) => Boolean(x.fetchedAt)\n`,
      )
      const { status } = runChecker()
      expect(status).toBe(0)
    })

    it("does not false-positive on a 'fetch' property declaration or a fetch-prefixed method call", () => {
      // A port declared on an interface (`fetch: FetchPort`) is exactly the pattern core is
      // supposed to use — a provider injects the implementation. Calling through an injected
      // port (`ctx.fetch.get(url)`) is core using that port, not core making the HTTP call
      // itself. Neither should trip the HTTP-framing rule; if a future regex change makes them
      // trip it, this gate would start crying wolf and get disabled.
      writeFileSync(
        PROBE_FILE,
        [
          "export interface Port {",
          "  fetch: FetchPort",
          "}",
          "export function useIt(ctx: { fetch: { get: (u: string) => Promise<string> } }) {",
          '  return ctx.fetch.get("https://example.com")',
          "}",
          "",
        ].join("\n"),
      )
      const { status } = runChecker()
      expect(status).toBe(0)
    })
  })
})

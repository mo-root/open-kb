# open-kb Foundation & Investigator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the engine's trustworthy foundation — evidence that cannot be faked, failures that cannot hide, spans that account for every call — and prove it by running one real investigator agent that finds real companies with real citations.

**Architecture:** A pure, network-free core (`@open-kb/core`) holding the evidence store, content sniffer, span stream, and tool contract. A separate `@open-kb/providers` package adapting Bright Data SERP and Unlocker behind core's interfaces. One investigator agent built on the AI SDK's tool loop, driven by a minimal doctrine, wired to those tools.

**Tech Stack:** TypeScript 5.7+, Node ≥20 (this machine runs v20.19.5), pnpm 9 (this machine runs 9.1.0), `ai@^7.0.48` (AI SDK), `@openrouter/ai-sdk-provider@^3.0.0`, `zod@^4`, `vitest@^3`, `tsup`.

**Verified before writing this plan** — do not re-derive these from memory:
- `ai@7.0.48` exports `ToolLoopAgent`, `stepCountIs`, `isLoopFinished`, `hasToolCall`, `tool`. There is no `Agent` export.
- `ai/test` exports `MockLanguageModelV4` (and a legacy `MockLanguageModelV3`), plus `simulateReadableStream`. Use **V4** with `ai@7`.
- `@openrouter/ai-sdk-provider@3.0.0` peers `ai@^7`. Version `2.x` peers `ai@^6` — installing the wrong pair silently downgrades `ai`.

## Global Constraints

- `packages/core/src/**` MUST NOT contain: `process.env`, any DOM API (`document.`, `window.`), any vendor name (`brightdata`, `openrouter`), or any HTTP framing. Enforced by a CI grep.
- Credentials are always a parameter, never read from the environment inside `core` or `providers`.
- Every evidence quote MUST be a literal substring of bytes fetched during this run. One mint function, zero fallback branches.
- HTTP status codes are never trusted. Content is sniffed. Measured cases that must be detected: **200 with a zero-byte body** (`stripe.com` via Unlocker, 33–60s), and **200 returning 487KB of HTML where a text file was requested** (`vercel.com/llms-full.txt`).
- Every tool returns a result object. Tools never throw for expected failures. Refusals are prose the model can act on.
- Node ≥20, ESM only (`"type": "module"`).
- Test runner is `vitest`. No test touches the network except those in `tests/live/`, which are skipped unless `OPENKB_LIVE=1`.

---

### Task 1: Repo scaffold and the purity gate

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `scripts/check-core-purity.mjs`
- Test: `tests/purity.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: the `@open-kb/core` package name and the `pnpm test` / `pnpm check` scripts every later task uses.

- [ ] **Step 1: Write the failing test**

```ts
// tests/purity.test.ts
import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"

describe("core purity", () => {
  it("core contains no env access, DOM, or vendor names", () => {
    const run = () => execFileSync("node", ["scripts/check-core-purity.mjs"], { encoding: "utf8" })
    expect(run).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/purity.test.ts`
Expected: FAIL — `scripts/check-core-purity.mjs` does not exist.

- [ ] **Step 3: Write the scaffold and the checker**

```json
// package.json
{
  "name": "open-kb",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "check": "node scripts/check-core-purity.mjs && tsc -b"
  },
  "devDependencies": { "typescript": "^5.7.2", "vitest": "^3.0.0", "@types/node": "^22.10.0" }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true
  }
}
```

```json
// packages/core/package.json
{
  "name": "@open-kb/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": { "@types/node": "^22.10.0" }
}
```

`@types/node` is required in the package, not just at the root: pnpm does not hoist by default, and
`packages/core/src/prompts.ts` (Task 9) imports `node:fs` and `node:path`.

```json
// packages/core/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "lib": ["ES2023"], "outDir": "dist" }, "include": ["src"] }
```

Note `"lib": ["ES2023"]` with **no `"DOM"`** — that omission is the point. It makes `document.` a compile error inside core.

```js
// scripts/check-core-purity.mjs
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const FORBIDDEN = [
  [/process\.env/, "process.env — credentials are a parameter"],
  [/\bdocument\.|window\./, "DOM API in a headless engine"],
  [/brightdata|openrouter|gemini/i, "vendor name in core"],
]

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith(".ts")) out.push(p)
  }
  return out
}

const violations = []
for (const file of walk("packages/core/src")) {
  const text = readFileSync(file, "utf8")
  text.split("\n").forEach((line, i) => {
    for (const [re, why] of FORBIDDEN) {
      if (re.test(line)) violations.push(`${file}:${i + 1}  ${why}\n    ${line.trim()}`)
    }
  })
}

if (violations.length) {
  console.error("core purity violations:\n" + violations.join("\n"))
  process.exit(1)
}
console.log("core purity: clean")
```

```ts
// packages/core/src/index.ts
export const VERSION = "0.0.0"
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config"
export default defineConfig({ test: { include: ["tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"] } })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm vitest run tests/purity.test.ts`
Expected: PASS, and the script prints `core purity: clean`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold workspace with core purity gate"
```

---

### Task 2: URL canonicalization

**Files:**
- Create: `packages/core/src/url.ts`
- Test: `packages/core/tests/url.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `canonicalUrl(raw: string): string` — used by the evidence store to answer "did this run fetch that URL" across spelling differences.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/url.test.ts
import { describe, it, expect } from "vitest"
import { canonicalUrl } from "../src/url.js"

describe("canonicalUrl", () => {
  it("normalises host case, www, trailing slash and fragment", () => {
    expect(canonicalUrl("HTTPS://WWW.Stripe.com/radar/")).toBe("https://stripe.com/radar")
    expect(canonicalUrl("https://stripe.com/radar#pricing")).toBe("https://stripe.com/radar")
  })

  it("drops tracking params but keeps meaningful ones", () => {
    expect(canonicalUrl("https://a.com/x?utm_source=g&id=7")).toBe("https://a.com/x?id=7")
  })

  it("treats the bare root and the slashed root as the same url", () => {
    expect(canonicalUrl("https://a.com")).toBe(canonicalUrl("https://a.com/"))
  })

  it("returns the input unchanged when it cannot be parsed", () => {
    expect(canonicalUrl("not a url")).toBe("not a url")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/url.test.ts`
Expected: FAIL — cannot find module `../src/url.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/url.ts
const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$)/i

/**
 * Reduce a URL to a stable identity so "did we fetch this?" survives spelling.
 * Never throws: an unparseable string is its own canonical form.
 */
export function canonicalUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  u.hash = ""
  u.protocol = u.protocol.toLowerCase()
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "")
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING.test(key)) u.searchParams.delete(key)
  }
  u.searchParams.sort()
  let path = u.pathname
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  u.pathname = path
  const qs = u.searchParams.toString()
  return `${u.protocol}//${u.host}${u.pathname}${qs ? "?" + qs : ""}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/url.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/url.ts packages/core/tests/url.test.ts
git commit -m "feat(core): canonical url identity"
```

---

### Task 3: Content sniffing — status codes are not trusted

**Files:**
- Create: `packages/core/src/sniff.ts`
- Test: `packages/core/tests/sniff.test.ts`
- Create: `fixtures/soft404-vercel-llms-full.html` (any 2KB of real HTML; content is irrelevant, shape is not)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type FetchStatus = "found" | "not_found" | "blocked"`
  - `interface RawResponse { url: string; httpStatus: number; body: string; contentType?: string }`
  - `interface SniffResult { status: FetchStatus; reason?: string; text: string }`
  - `function sniff(r: RawResponse): SniffResult`
  - `function extractText(html: string): string`

- [ ] **Step 1: Write the failing test**

Each case here is a real measurement, not a hypothetical. Keep the comments — they are why the rule exists.

```ts
// packages/core/tests/sniff.test.ts
import { describe, it, expect } from "vitest"
import { sniff, extractText } from "../src/sniff.js"

describe("sniff", () => {
  it("calls a 200 with an empty body blocked", () => {
    // MEASURED: Bright Data Unlocker on stripe.com returned HTTP 200,
    // Content-Length 0, after 33-60s. Twice, on two different zones.
    const r = sniff({ url: "https://stripe.com/radar", httpStatus: 200, body: "" })
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("empty-body")
  })

  it("calls a 200 that renders almost no text blocked", () => {
    const shell = "<html><head><title>x</title></head><body><div id='root'></div><script>var a=1</script></body></html>"
    const r = sniff({ url: "https://example.com", httpStatus: 200, body: shell })
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("thin-render")
  })

  it("calls HTML returned for a .txt request a soft 404", () => {
    // MEASURED: vercel.com/llms-full.txt returned HTTP 200 with 487KB of HTML.
    const r = sniff({
      url: "https://vercel.com/llms-full.txt",
      httpStatus: 200,
      body: "<!doctype html><html><body>" + "text ".repeat(400) + "</body></html>",
    })
    expect(r.status).toBe("not_found")
    expect(r.reason).toBe("soft-404")
  })

  it("accepts a real text file", () => {
    const body = "# Stripe\n> Stripe is a technology company that provides financial infrastructure.\n" + "## Payments\n".repeat(30)
    const r = sniff({ url: "https://stripe.com/llms.txt", httpStatus: 200, body })
    expect(r.status).toBe("found")
    expect(r.text).toContain("financial infrastructure")
  })

  it("accepts an ordinary content page and returns its text", () => {
    // MEASURED: an industrial manufacturer's homepage yielded 8,335 chars to a plain curl.
    const body = "<html><body><h1>Cables, Connectors, PCBA</h1><p>" + "we assemble boards. ".repeat(60) + "</p></body></html>"
    const r = sniff({ url: "https://www.nortechsys.com/", httpStatus: 200, body })
    expect(r.status).toBe("found")
    expect(r.text).toContain("Cables, Connectors, PCBA")
  })

  it("maps a 4xx to not_found and a 5xx to blocked", () => {
    expect(sniff({ url: "https://a.com/x", httpStatus: 404, body: "nope" }).status).toBe("not_found")
    expect(sniff({ url: "https://a.com/x", httpStatus: 503, body: "" }).status).toBe("blocked")
  })
})

describe("extractText", () => {
  it("strips script and style content, not just tags", () => {
    const html = "<html><style>.a{color:red}</style><script>var x=1</script><p>hello world</p></html>"
    expect(extractText(html)).toBe("hello world")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/sniff.test.ts`
Expected: FAIL — cannot find module `../src/sniff.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/sniff.ts

export type FetchStatus = "found" | "not_found" | "blocked"

export interface RawResponse {
  url: string
  httpStatus: number
  body: string
  contentType?: string
}

export interface SniffResult {
  status: FetchStatus
  reason?: string
  text: string
}

/** Minimum extractable characters before we call a page substantive. */
const THIN_TEXT = 200

export function extractText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype html|<html\b)/i.test(body)
}

function expectsPlainText(url: string): boolean {
  return /\.(txt|md|json)(\?|$)/i.test(url)
}

/**
 * Decide what actually happened, ignoring what the status line claims.
 * Three measured failures this exists to catch:
 *   - 200 with a zero-byte body (a hard block that looks like success)
 *   - 200 with an app shell and no text (a JS-rendered page)
 *   - 200 with HTML where a text file was requested (a soft 404)
 */
export function sniff(r: RawResponse): SniffResult {
  if (r.httpStatus >= 500) return { status: "blocked", reason: "server-error", text: "" }
  if (r.httpStatus >= 400) return { status: "not_found", reason: `http-${r.httpStatus}`, text: "" }

  if (r.body.length === 0) return { status: "blocked", reason: "empty-body", text: "" }

  if (expectsPlainText(r.url) && looksLikeHtml(r.body)) {
    return { status: "not_found", reason: "soft-404", text: "" }
  }

  const text = looksLikeHtml(r.body) || /<[a-z][\s\S]*>/i.test(r.body) ? extractText(r.body) : r.body

  if (text.length < THIN_TEXT) {
    return { status: "blocked", reason: "thin-render", text }
  }

  return { status: "found", text }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/sniff.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sniff.ts packages/core/tests/sniff.test.ts
git commit -m "feat(core): sniff content instead of trusting status codes"
```

---

### Task 4: The evidence store and the single mint

**Files:**
- Create: `packages/core/src/evidence.ts`
- Test: `packages/core/tests/evidence.test.ts`

**Interfaces:**
- Consumes: `canonicalUrl` (Task 2), `FetchStatus` (Task 3)
- Produces:
  - `interface Evidence { url: string; quote: string; fetchedAt: string; status: FetchStatus }`
  - `interface FetchRecord { handle: string; url: string; text: string; fetchedAt: string; status: FetchStatus; reason?: string }`
  - `class CitationError extends Error`
  - `class EvidenceStore` with `record(...)`, `get(handle)`, `hasFetched(url)`, `cite(handle, quote)`, `size()`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/evidence.test.ts
import { describe, it, expect } from "vitest"
import { EvidenceStore, CitationError } from "../src/evidence.js"

const NOW = () => "2026-08-03T10:00:00.000Z"

describe("EvidenceStore", () => {
  it("mints a citation whose quote is present in fetched bytes", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "Acme sells anti-bot bypass APIs.", status: "found" })
    const ev = s.cite(rec.handle, "anti-bot bypass APIs")
    expect(ev.url).toBe("https://a.com/p")
    expect(ev.quote).toBe("anti-bot bypass APIs")
    expect(ev.status).toBe("found")
    expect(ev.fetchedAt).toBe("2026-08-03T10:00:00.000Z")
  })

  it("refuses a quote that is not in the fetched bytes", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "Acme sells proxies.", status: "found" })
    expect(() => s.cite(rec.handle, "Acme raised $50M")).toThrow(CitationError)
  })

  it("refuses a citation against an unknown handle", () => {
    const s = new EvidenceStore(NOW)
    expect(() => s.cite("ev999", "anything")).toThrow(CitationError)
  })

  it("refuses to cite a page that was blocked", () => {
    // A blocked page has no bytes to prove anything with.
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://stripe.com/radar", text: "", status: "blocked", reason: "empty-body" })
    expect(() => s.cite(rec.handle, "anything")).toThrow(CitationError)
  })

  it("normalises whitespace when matching so wrapped quotes still verify", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "we assemble\n  printed circuit  boards", status: "found" })
    expect(() => s.cite(rec.handle, "assemble printed circuit boards")).not.toThrow()
  })

  it("knows whether a url was fetched, across spelling differences", () => {
    const s = new EvidenceStore(NOW)
    s.record({ url: "https://WWW.A.com/p/", text: "x".repeat(50), status: "found" })
    expect(s.hasFetched("https://a.com/p")).toBe(true)
    expect(s.hasFetched("https://a.com/other")).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/evidence.test.ts`
Expected: FAIL — cannot find module `../src/evidence.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/evidence.ts
import { canonicalUrl } from "./url.js"
import type { FetchStatus } from "./sniff.js"

export interface Evidence {
  url: string
  quote: string
  fetchedAt: string
  status: FetchStatus
}

export interface FetchRecord {
  handle: string
  url: string
  canonical: string
  text: string
  fetchedAt: string
  status: FetchStatus
  reason?: string
}

export class CitationError extends Error {}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()

/**
 * Every byte the run fetched, and the ONLY way to turn those bytes into a citation.
 *
 * `cite` is the single mint. It has no fallback branch on purpose: if a quote cannot be
 * proven against stored bytes, no Evidence exists. A previous generation of this system
 * synthesised the proving quote out of the value it was meant to prove, which made every
 * citation on screen meaningless.
 */
export class EvidenceStore {
  #records = new Map<string, FetchRecord>()
  #byUrl = new Map<string, string>()
  #n = 0
  #now: () => string

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now
  }

  record(input: { url: string; text: string; status: FetchStatus; reason?: string }): FetchRecord {
    const handle = `ev${++this.#n}`
    const canonical = canonicalUrl(input.url)
    const rec: FetchRecord = {
      handle,
      url: input.url,
      canonical,
      text: input.text,
      fetchedAt: this.#now(),
      status: input.status,
      reason: input.reason,
    }
    this.#records.set(handle, rec)
    if (input.status === "found") this.#byUrl.set(canonical, handle)
    return rec
  }

  get(handle: string): FetchRecord | undefined {
    return this.#records.get(handle)
  }

  hasFetched(url: string): boolean {
    return this.#byUrl.has(canonicalUrl(url))
  }

  size(): number {
    return this.#records.size
  }

  cite(handle: string, quote: string): Evidence {
    const rec = this.#records.get(handle)
    if (!rec) throw new CitationError(`no such handle: ${handle}`)
    if (rec.status !== "found") {
      throw new CitationError(`cannot cite ${handle}: page was ${rec.status}${rec.reason ? ` (${rec.reason})` : ""}`)
    }
    if (!squash(rec.text).includes(squash(quote))) {
      throw new CitationError(`quote not present in ${rec.url}`)
    }
    return { url: rec.url, quote, fetchedAt: rec.fetchedAt, status: rec.status }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/evidence.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/evidence.ts packages/core/tests/evidence.test.ts
git commit -m "feat(core): evidence store with a single unfakeable mint"
```

---

### Task 5: The span stream

**Files:**
- Create: `packages/core/src/spans.ts`
- Test: `packages/core/tests/spans.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Span { seq; ts; runId; agentId; parentId; kind; name; argsDigest; ms; ok; error?; tokensIn?; tokensOut?; usd; runningUsd }`
  - `type SpanKind = "model" | "search" | "fetch" | "read" | "remember" | "spawn"`
  - `class SpanStream` with `emit(partial)`, `stream()`, `close()`, `totalUsd()`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/spans.test.ts
import { describe, it, expect } from "vitest"
import { SpanStream } from "../src/spans.js"

const base = { runId: "r1", agentId: "lead", parentId: null, ms: 10, ok: true, usd: 0 }

describe("SpanStream", () => {
  it("numbers spans monotonically and accumulates cost", () => {
    const s = new SpanStream(() => "2026-08-03T10:00:00.000Z")
    const a = s.emit({ ...base, kind: "search", name: "serp", argsDigest: "web scraping api", usd: 0.002 })
    const b = s.emit({ ...base, kind: "fetch", name: "unlock", argsDigest: "https://a.com", usd: 0.01 })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.runningUsd).toBeCloseTo(0.002)
    expect(b.runningUsd).toBeCloseTo(0.012)
    expect(s.totalUsd()).toBeCloseTo(0.012)
  })

  it("emits a span for a failure, with the reason in words", () => {
    const s = new SpanStream()
    const sp = s.emit({ ...base, kind: "fetch", name: "unlock", argsDigest: "https://stripe.com/radar",
                        ok: false, error: "blocked: empty-body after 51s" })
    expect(sp.ok).toBe(false)
    expect(sp.error).toContain("empty-body")
  })

  it("refuses to record a non-finite cost rather than reporting a healthy zero", () => {
    const s = new SpanStream()
    const sp = s.emit({ ...base, kind: "model", name: "flash", argsDigest: "turn 3", usd: Number.NaN })
    expect(sp.usd).toBe(0)
    expect(sp.ok).toBe(false)
    expect(sp.error).toContain("non-finite cost")
    expect(s.totalUsd()).toBe(0)
  })

  it("delivers spans to an async consumer and ends when closed", async () => {
    const s = new SpanStream()
    const got: number[] = []
    const consumer = (async () => {
      for await (const sp of s.stream()) got.push(sp.seq)
    })()
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "a" })
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "b" })
    s.close()
    await consumer
    expect(got).toEqual([1, 2])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/spans.test.ts`
Expected: FAIL — cannot find module `../src/spans.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/spans.ts

export type SpanKind = "model" | "search" | "fetch" | "read" | "remember" | "spawn"

export interface Span {
  seq: number
  ts: string
  runId: string
  agentId: string
  parentId: string | null
  kind: SpanKind
  /** model id, or tool name */
  name: string
  /** the real query or URL — the only place a viewer sees which question was bought */
  argsDigest: string
  ms: number
  ok: boolean
  error?: string
  tokensIn?: number
  tokensOut?: number
  usd: number
  runningUsd: number
}

export type SpanInput = Omit<Span, "seq" | "ts" | "runningUsd"> & { usd?: number }

/**
 * One append-only log of everything the run did, successes and failures alike.
 * A failed call that emits nothing is indistinguishable from work never attempted.
 */
export class SpanStream {
  #seq = 0
  #total = 0
  #now: () => string
  #buffer: Span[] = []
  #waiters: Array<(s: Span | null) => void> = []
  #closed = false

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now
  }

  emit(input: SpanInput): Span {
    let usd = input.usd ?? 0
    let ok = input.ok
    let error = input.error

    if (!Number.isFinite(usd)) {
      // Never let a missing number render as a healthy $0.00.
      usd = 0
      ok = false
      error = [error, "non-finite cost reported"].filter(Boolean).join("; ")
    }

    this.#total += usd
    const span: Span = {
      ...input,
      usd,
      ok,
      error,
      seq: ++this.#seq,
      ts: this.#now(),
      runningUsd: this.#total,
    }

    const waiter = this.#waiters.shift()
    if (waiter) waiter(span)
    else this.#buffer.push(span)
    return span
  }

  totalUsd(): number {
    return this.#total
  }

  close(): void {
    this.#closed = true
    for (const w of this.#waiters.splice(0)) w(null)
  }

  async *stream(): AsyncGenerator<Span> {
    while (true) {
      const next = this.#buffer.shift()
      if (next) {
        yield next
        continue
      }
      if (this.#closed) return
      const span = await new Promise<Span | null>((res) => this.#waiters.push(res))
      if (span === null) return
      yield span
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/spans.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/spans.ts packages/core/tests/spans.test.ts
git commit -m "feat(core): span stream with honest failure and cost accounting"
```

---

### Task 6: Provider interfaces and a fake provider

**Files:**
- Create: `packages/core/src/ports.ts`
- Create: `packages/core/src/testing/fake-provider.ts`
- Test: `packages/core/tests/ports.test.ts`

**Interfaces:**
- Consumes: `RawResponse` (Task 3)
- Produces:
  - `interface SearchHit { url: string; title: string; description: string }`
  - `interface SearchPort { search(queries: string[]): Promise<Array<{ query: string; hits: SearchHit[]; ok: boolean; error?: string; usd: number }>> }`
  - `interface FetchPort { get(url: string, mode: "direct" | "unlocked"): Promise<RawResponse & { ms: number; usd: number }> }`
  - `class FakeSearch implements SearchPort`, `class FakeFetch implements FetchPort`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/ports.test.ts
import { describe, it, expect } from "vitest"
import { FakeSearch, FakeFetch } from "../src/testing/fake-provider.js"

describe("fake providers", () => {
  it("returns configured hits per query and reports cost", async () => {
    const s = new FakeSearch({ "web scraping api": [{ url: "https://x.com", title: "X", description: "scraping" }] })
    const [r] = await s.search(["web scraping api"])
    expect(r!.ok).toBe(true)
    expect(r!.hits[0]!.url).toBe("https://x.com")
    expect(r!.usd).toBeGreaterThan(0)
  })

  it("reports an unknown query as an empty but successful search", async () => {
    const s = new FakeSearch({})
    const [r] = await s.search(["nothing here"])
    expect(r!.ok).toBe(true)
    expect(r!.hits).toEqual([])
  })

  it("can be told to fail a specific query without failing the batch", async () => {
    const s = new FakeSearch({ good: [] }, { failing: ["bad"] })
    const rs = await s.search(["good", "bad"])
    expect(rs[0]!.ok).toBe(true)
    expect(rs[1]!.ok).toBe(false)
    expect(rs[1]!.error).toBeTruthy()
  })

  it("can simulate the measured 200-with-empty-body block", async () => {
    const f = new FakeFetch({ "https://stripe.com/radar": { httpStatus: 200, body: "" } })
    const r = await f.get("https://stripe.com/radar", "unlocked")
    expect(r.httpStatus).toBe(200)
    expect(r.body).toBe("")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/ports.test.ts`
Expected: FAIL — cannot find module `../src/testing/fake-provider.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/ports.ts
import type { RawResponse } from "./sniff.js"

export interface SearchHit {
  url: string
  title: string
  description: string
}

export interface SearchResult {
  query: string
  hits: SearchHit[]
  ok: boolean
  error?: string
  usd: number
  ms: number
}

/** Search is batched: one call carries many queries, one model turn buys a whole wave. */
export interface SearchPort {
  search(queries: string[]): Promise<SearchResult[]>
}

export type FetchMode = "direct" | "unlocked"

export interface FetchResponse extends RawResponse {
  ms: number
  usd: number
}

export interface FetchPort {
  get(url: string, mode: FetchMode): Promise<FetchResponse>
}
```

```ts
// packages/core/src/testing/fake-provider.ts
import type { SearchHit, SearchPort, SearchResult, FetchPort, FetchMode, FetchResponse } from "../ports.js"

export class FakeSearch implements SearchPort {
  constructor(
    private table: Record<string, SearchHit[]>,
    private opts: { failing?: string[] } = {},
  ) {}

  async search(queries: string[]): Promise<SearchResult[]> {
    return queries.map((query) => {
      if (this.opts.failing?.includes(query)) {
        return { query, hits: [], ok: false, error: "search provider refused this query", usd: 0, ms: 1 }
      }
      return { query, hits: this.table[query] ?? [], ok: true, usd: 0.001, ms: 5 }
    })
  }
}

export class FakeFetch implements FetchPort {
  constructor(private table: Record<string, { httpStatus: number; body: string; contentType?: string }>) {}

  async get(url: string, mode: FetchMode): Promise<FetchResponse> {
    const row = this.table[url] ?? { httpStatus: 404, body: "" }
    return {
      url,
      httpStatus: row.httpStatus,
      body: row.body,
      contentType: row.contentType,
      ms: mode === "unlocked" ? 14_000 : 300,
      usd: mode === "unlocked" ? 0.008 : 0,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/ports.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ports.ts packages/core/src/testing packages/core/tests/ports.test.ts
git commit -m "feat(core): provider ports and fakes"
```

---

### Task 7: The tools

**Files:**
- Create: `packages/core/src/tools.ts`
- Test: `packages/core/tests/tools.test.ts`

**Interfaces:**
- Consumes: `SearchPort`, `FetchPort` (Task 6), `EvidenceStore` (Task 4), `sniff` (Task 3), `SpanStream` (Task 5)
- Produces:
  - `interface RunContext { evidence: EvidenceStore; spans: SpanStream; search: SearchPort; fetch: FetchPort; runId: string; agentId: string; parentId: string | null }`
  - `function makeTools(ctx: RunContext)` returning `{ search, fetch, read, remember }`, each an AI SDK `tool()` definition
  - `interface Finding { nodes: NodeInput[]; edges: EdgeInput[] }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/tools.test.ts
import { describe, it, expect } from "vitest"
import { EvidenceStore } from "../src/evidence.js"
import { SpanStream } from "../src/spans.js"
import { FakeSearch, FakeFetch } from "../src/testing/fake-provider.js"
import { makeTools } from "../src/tools.js"

const ctx = () => ({
  evidence: new EvidenceStore(() => "2026-08-03T10:00:00.000Z"),
  spans: new SpanStream(() => "2026-08-03T10:00:00.000Z"),
  search: new FakeSearch({ "anti-bot bypass api": [{ url: "https://rival.com", title: "Rival", description: "bypass" }] }),
  fetch: new FakeFetch({
    "https://rival.com": { httpStatus: 200, body: "<html><body><p>" + "Rival sells an anti-bot bypass API for developers. ".repeat(8) + "</p></body></html>" },
    "https://stripe.com/radar": { httpStatus: 200, body: "" },
  }),
  runId: "r1",
  agentId: "inv1",
  parentId: "lead",
  graph: { nodes: new Map(), edges: [] },
})

describe("search tool", () => {
  it("returns hits and emits one span carrying the query text", async () => {
    const c = ctx()
    const t = makeTools(c)
    const out = await t.search.execute!({ queries: ["anti-bot bypass api"], why: "find rivals by what they do" }, {} as never)
    expect(out.results[0]!.hits).toHaveLength(1)
    const spans = []
    c.spans.close()
    for await (const s of c.spans.stream()) spans.push(s)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.argsDigest).toBe("anti-bot bypass api")
    expect(spans[0]!.kind).toBe("search")
  })
})

describe("fetch tool", () => {
  it("stores fetched bytes and hands back a handle plus a slice", async () => {
    const c = ctx()
    const t = makeTools(c)
    const out = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "learn what this host is" }, {} as never)
    const r = out.results[0]!
    expect(r.status).toBe("found")
    expect(r.handle).toMatch(/^ev\d+$/)
    expect(r.slice).toContain("anti-bot bypass API")
  })

  it("reports the measured empty-body block as blocked, in words, without throwing", async () => {
    const c = ctx()
    const t = makeTools(c)
    const out = await t.fetch.execute!({ urls: ["https://stripe.com/radar"], mode: "unlocked", why: "read the product page" }, {} as never)
    const r = out.results[0]!
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("empty-body")
    expect(r.handle).toBeUndefined()
  })
})

describe("remember tool", () => {
  it("writes a node when every quote verifies", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "x" }, {} as never)
    const handle = f.results[0]!.handle!
    const out = await t.remember.execute!({
      nodes: [{
        kind: "company", name: "Rival", what: "sells an anti-bot bypass API",
        whyHere: "sells the same capability as the anchor, to the same buyer",
        howFound: "anti-bot bypass api",
        evidence: [{ handle, quote: "Rival sells an anti-bot bypass API" }],
      }],
      edges: [],
    }, {} as never)
    expect(out.written.nodes).toBe(1)
    expect(out.rejected).toHaveLength(0)
  })

  it("rejects a node whose quote was never fetched, and says why", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "x" }, {} as never)
    const handle = f.results[0]!.handle!
    const out = await t.remember.execute!({
      nodes: [{
        kind: "company", name: "Rival", what: "raised $50M last year",
        whyHere: "competitor", howFound: "anti-bot bypass api",
        evidence: [{ handle, quote: "Rival raised $50M in Series B" }],
      }],
      edges: [],
    }, {} as never)
    expect(out.written.nodes).toBe(0)
    expect(out.rejected[0]).toContain("quote not present")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/tools.test.ts`
Expected: FAIL — cannot find module `../src/tools.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/tools.ts
import { tool } from "ai"
import { z } from "zod"
import { sniff } from "./sniff.js"
import { EvidenceStore, CitationError, type Evidence } from "./evidence.js"
import type { SpanStream } from "./spans.js"
import type { SearchPort, FetchPort } from "./ports.js"

export interface RunContext {
  evidence: EvidenceStore
  spans: SpanStream
  search: SearchPort
  fetch: FetchPort
  runId: string
  agentId: string
  parentId: string | null
  /** nodes and edges written so far, keyed by id */
  graph: { nodes: Map<string, StoredNode>; edges: StoredEdge[] }
}

export const RELATIONS = ["competitor", "substitute", "dependency", "integration", "shaper"] as const
export type Relation = (typeof RELATIONS)[number]

export interface StoredNode {
  id: string
  kind: "company" | "capability" | "buyer"
  name: string
  what: string
  whyHere: string
  howFound: string
  evidence: Evidence[]
}

export interface StoredEdge {
  from: string
  to: string
  relation: Relation
  whyHere: string
  howFound: string
  evidence: Evidence[]
}

/** How much of a fetched page reaches the model. Pages run to 900KB; contexts do not. */
const SLICE = 8_000

const evidenceRef = z.object({
  handle: z.string().describe("the handle returned by fetch for the page this quote is on"),
  quote: z.string().min(8).describe("text copied verbatim from that page"),
})

export function makeTools(ctx: RunContext) {
  const span = (kind: Parameters<SpanStream["emit"]>[0]["kind"], name: string, argsDigest: string, extra: { ms: number; usd?: number; ok: boolean; error?: string }) =>
    ctx.spans.emit({ runId: ctx.runId, agentId: ctx.agentId, parentId: ctx.parentId, kind, name, argsDigest, ...extra })

  const search = tool({
    description:
      "Run several web searches at once. Cheap and fast — this is how you find out what exists. " +
      "Batch every query you want in one call; one call buys a whole wave.",
    inputSchema: z.object({
      queries: z.array(z.string()).min(1).max(12),
      why: z.string().describe("what you expect these queries to buy, and why it is worth it"),
    }),
    execute: async ({ queries }) => {
      const results = await ctx.search.search(queries)
      for (const r of results) {
        span("search", "serp", r.query, { ms: r.ms, usd: r.usd, ok: r.ok, error: r.error })
      }
      return {
        results: results.map((r) => ({
          query: r.query,
          ok: r.ok,
          error: r.error,
          hits: r.hits.map((h) => ({ url: h.url, title: h.title, description: h.description })),
        })),
      }
    },
  })

  const fetchTool = tool({
    description:
      "Read web pages. mode 'direct' is FREE and instant but fails on sites that block or render in the browser. " +
      "mode 'unlocked' gets through almost anything but costs money and takes 13-16 seconds per page. " +
      "You choose. Spend an unlock on a page that will name many things at once; do not spend one to find out what a company is.",
    inputSchema: z.object({
      urls: z.array(z.string().url()).min(1).max(8),
      mode: z.enum(["direct", "unlocked"]),
      why: z.string().describe("why these pages, and why this mode is worth its cost"),
    }),
    execute: async ({ urls, mode }) => {
      const out = await Promise.all(
        urls.map(async (url) => {
          const raw = await ctx.fetch.get(url, mode)
          const s = sniff(raw)
          const rec = ctx.evidence.record({ url, text: s.text, status: s.status, reason: s.reason })
          span("fetch", mode, url, {
            ms: raw.ms,
            usd: raw.usd,
            ok: s.status === "found",
            error: s.status === "found" ? undefined : `${s.status}: ${s.reason ?? "unknown"}`,
          })
          if (s.status !== "found") {
            return {
              url,
              status: s.status,
              reason: s.reason,
              hint:
                s.reason === "empty-body"
                  ? "the site refused us; try a different page or accept that this one is unreadable"
                  : s.reason === "thin-render"
                    ? "this page is assembled in the browser; an unlocked fetch may work, but costs 13-16s"
                    : "nothing usable came back",
            }
          }
          return {
            url,
            status: s.status,
            handle: rec.handle,
            bytes: s.text.length,
            truncated: s.text.length > SLICE,
            slice: s.text.slice(0, SLICE),
          }
        }),
      )
      return { results: out }
    },
  })

  const read = tool({
    description: "FREE. Re-read a page you already fetched, from a given offset. Costs nothing — use it instead of re-fetching.",
    inputSchema: z.object({
      handle: z.string(),
      offset: z.number().int().min(0).default(0),
    }),
    execute: async ({ handle, offset }) => {
      const rec = ctx.evidence.get(handle)
      span("read", "slice", handle, { ms: 0, usd: 0, ok: !!rec })
      if (!rec) return { ok: false, reason: `no such handle: ${handle}` }
      if (rec.status !== "found") return { ok: false, reason: `that page was ${rec.status} (${rec.reason ?? "unknown"})` }
      return { ok: true, slice: rec.text.slice(offset, offset + SLICE), bytes: rec.text.length, offset }
    },
  })

  const remember = tool({
    description:
      "Write what you found onto the map. Every node and edge needs a reason it belongs here and a quote " +
      "from a page you actually fetched. Anything you cannot prove is rejected and told back to you.",
    inputSchema: z.object({
      nodes: z.array(
        z.object({
          kind: z.enum(["company", "capability", "buyer"]),
          name: z.string(),
          what: z.string().describe("what it sells, and to whom"),
          whyHere: z.string().describe("why it belongs on THIS map, stated against the company we started from"),
          howFound: z.string().describe("the query or page that surfaced it"),
          evidence: z.array(evidenceRef).min(1),
        }),
      ).default([]),
      edges: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          relation: z.enum(RELATIONS),
          whyHere: z.string(),
          howFound: z.string(),
          evidence: z.array(evidenceRef).min(1),
        }),
      ).default([]),
    }),
    execute: async ({ nodes, edges }) => {
      const rejected: string[] = []
      let wroteNodes = 0
      let wroteEdges = 0

      const mint = (refs: Array<{ handle: string; quote: string }>, label: string): Evidence[] | null => {
        const out: Evidence[] = []
        for (const r of refs) {
          try {
            out.push(ctx.evidence.cite(r.handle, r.quote))
          } catch (e) {
            rejected.push(`${label}: ${(e as CitationError).message}`)
            return null
          }
        }
        return out
      }

      for (const n of nodes) {
        const ev = mint(n.evidence, `node "${n.name}"`)
        if (!ev) continue
        const id = `${n.kind}:${n.name.toLowerCase().replace(/\s+/g, "-")}`
        const existing = ctx.graph.nodes.get(id)
        if (existing) existing.evidence.push(...ev)
        else ctx.graph.nodes.set(id, { id, kind: n.kind, name: n.name, what: n.what, whyHere: n.whyHere, howFound: n.howFound, evidence: ev })
        wroteNodes++
      }

      for (const e of edges) {
        const ev = mint(e.evidence, `edge ${e.from}->${e.to}`)
        if (!ev) continue
        ctx.graph.edges.push({ from: e.from, to: e.to, relation: e.relation, whyHere: e.whyHere, howFound: e.howFound, evidence: ev })
        wroteEdges++
      }

      span("remember", "write", `${wroteNodes}n/${wroteEdges}e`, { ms: 0, usd: 0, ok: rejected.length === 0 })
      return { written: { nodes: wroteNodes, edges: wroteEdges }, rejected }
    },
  })

  return { search, fetch: fetchTool, read, remember }
}
```

Add `ai` to `packages/core/package.json` dependencies: `"ai": "^7.0.48"` (alongside the existing `zod`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/tools.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools.ts packages/core/tests/tools.test.ts packages/core/package.json
git commit -m "feat(core): search, fetch, read and remember tools"
```

---

### Task 8: Bright Data providers

**Files:**
- Create: `packages/providers/package.json`, `packages/providers/tsconfig.json`
- Create: `packages/providers/src/brightdata.ts`
- Create: `packages/providers/src/index.ts`
- Test: `packages/providers/tests/brightdata.test.ts`
- Test: `tests/live/brightdata.live.test.ts`

**Interfaces:**
- Consumes: `SearchPort`, `FetchPort`, `SearchResult`, `FetchResponse` (Task 6)
- Produces:
  - `interface BrightDataCredentials { token: string; serpZone: string; unlockerZone: string }`
  - `function brightDataSearch(creds, opts?): SearchPort`
  - `function brightDataFetch(creds, opts?): FetchPort`

- [ ] **Step 1: Write the failing test**

```ts
// packages/providers/tests/brightdata.test.ts
import { describe, it, expect, vi } from "vitest"
import { brightDataSearch, brightDataFetch } from "../src/brightdata.js"

const creds = { token: "t", serpZone: "serp", unlockerZone: "unlock" }

describe("brightDataSearch", () => {
  it("asks google for parsed json and maps organic results", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ organic: [{ link: "https://a.com", title: "A", description: "d" }] }), { status: 200 }),
    )
    const s = brightDataSearch(creds, { fetchImpl: fetchSpy as unknown as typeof fetch })
    const [r] = await s.search(["web scraping api"])
    expect(r!.ok).toBe(true)
    expect(r!.hits[0]!.url).toBe("https://a.com")
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.zone).toBe("serp")
    expect(body.url).toContain("brd_json=1")
    expect(decodeURIComponent(body.url)).toContain("web scraping api")
  })

  it("fails one query without failing the batch", async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      n++
      return n === 1 ? new Response("boom", { status: 500 }) : new Response(JSON.stringify({ organic: [] }), { status: 200 })
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const rs = await s.search(["bad", "good"])
    expect(rs[0]!.ok).toBe(false)
    expect(rs[1]!.ok).toBe(true)
  })
})

describe("brightDataFetch", () => {
  it("uses no proxy at all for direct mode", async () => {
    const fetchImpl = vi.fn(async () => new Response("hello", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "direct")
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://a.com")
    expect(r.usd).toBe(0)
    expect(r.body).toBe("hello")
  })

  it("routes unlocked mode through the unlocker zone and prices it", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>ok</html>", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "unlocked")
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.brightdata.com/request")
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.zone).toBe("unlock")
    expect(r.usd).toBeGreaterThan(0)
  })

  it("returns a zero-byte 200 unchanged so the sniffer can judge it", async () => {
    // MEASURED: this is exactly what stripe.com does. The provider must not paper over it.
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://stripe.com/radar", "unlocked")
    expect(r.httpStatus).toBe(200)
    expect(r.body).toBe("")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/providers/tests/brightdata.test.ts`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Write minimal implementation**

```json
// packages/providers/package.json
{
  "name": "@open-kb/providers",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@open-kb/core": "workspace:*" },
  "devDependencies": { "@types/node": "^22.10.0" }
}
```

`@types/node` supplies the global `fetch`, `Response`, and `RequestInit` types this file uses. The
tsconfig deliberately omits `"DOM"` from `lib`, so without it these are compile errors.

```json
// packages/providers/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "outDir": "dist", "composite": true },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

Also add this package to the root `tsconfig.json` references so `pnpm check` builds it:

```json
{ "files": [], "references": [{ "path": "./packages/core" }, { "path": "./packages/providers" }] }
```

```ts
// packages/providers/src/brightdata.ts
import type { SearchPort, SearchResult, FetchPort, FetchMode, FetchResponse } from "@open-kb/core"

export interface BrightDataCredentials {
  token: string
  serpZone: string
  unlockerZone: string
}

interface Opts {
  fetchImpl?: typeof fetch
  /** rough per-call prices, used for accounting only */
  serpUsd?: number
  unlockUsd?: number
}

const API = "https://api.brightdata.com/request"

export function brightDataSearch(creds: BrightDataCredentials, opts: Opts = {}): SearchPort {
  const f = opts.fetchImpl ?? fetch
  const price = opts.serpUsd ?? 0.0015

  return {
    async search(queries) {
      return Promise.all(
        queries.map(async (query): Promise<SearchResult> => {
          const started = Date.now()
          const target = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&brd_json=1`
          try {
            const res = await f(API, {
              method: "POST",
              headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ zone: creds.serpZone, url: target, format: "raw" }),
            })
            const ms = Date.now() - started
            if (!res.ok) return { query, hits: [], ok: false, error: `serp http ${res.status}`, usd: price, ms }
            const text = await res.text()
            let parsed: { organic?: Array<{ link?: string; title?: string; description?: string }> }
            try {
              parsed = JSON.parse(text)
            } catch {
              return { query, hits: [], ok: false, error: "serp returned unparseable body", usd: price, ms }
            }
            const hits = (parsed.organic ?? [])
              .filter((h) => typeof h.link === "string")
              .map((h) => ({ url: h.link!, title: h.title ?? "", description: h.description ?? "" }))
            return { query, hits, ok: true, usd: price, ms }
          } catch (e) {
            return { query, hits: [], ok: false, error: `serp failed: ${(e as Error).message}`, usd: 0, ms: Date.now() - started }
          }
        }),
      )
    },
  }
}

export function brightDataFetch(creds: BrightDataCredentials, opts: Opts = {}): FetchPort {
  const f = opts.fetchImpl ?? fetch
  const price = opts.unlockUsd ?? 0.008

  return {
    async get(url: string, mode: FetchMode): Promise<FetchResponse> {
      const started = Date.now()

      if (mode === "direct") {
        try {
          const res = await f(url, { redirect: "follow" })
          const body = await res.text()
          return { url, httpStatus: res.status, body, contentType: res.headers.get("content-type") ?? undefined, ms: Date.now() - started, usd: 0 }
        } catch (e) {
          return { url, httpStatus: 0, body: "", ms: Date.now() - started, usd: 0, contentType: undefined }
        }
      }

      try {
        const res = await f(API, {
          method: "POST",
          headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ zone: creds.unlockerZone, url, format: "raw" }),
        })
        const body = await res.text()
        // Deliberately returned as-is. A 200 with an empty body is a real, measured outcome
        // and it is the sniffer's job to call it — not ours to hide.
        return { url, httpStatus: res.status, body, contentType: res.headers.get("content-type") ?? undefined, ms: Date.now() - started, usd: price }
      } catch (e) {
        return { url, httpStatus: 0, body: "", ms: Date.now() - started, usd: price, contentType: undefined }
      }
    },
  }
}
```

```ts
// packages/providers/src/index.ts
export { brightDataSearch, brightDataFetch, type BrightDataCredentials } from "./brightdata.js"
```

Export the port types from core's `index.ts` so providers can import them:

```ts
// packages/core/src/index.ts
export * from "./url.js"
export * from "./sniff.js"
export * from "./evidence.js"
export * from "./spans.js"
export * from "./ports.js"
export * from "./tools.js"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/providers/tests/brightdata.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the live test (skipped by default)**

```ts
// tests/live/brightdata.live.test.ts
import { describe, it, expect } from "vitest"
import { brightDataSearch, brightDataFetch } from "@open-kb/providers"
import { sniff } from "@open-kb/core"

const live = process.env.OPENKB_LIVE === "1"

describe.skipIf(!live)("brightdata live", () => {
  const creds = {
    token: process.env.BRIGHTDATA_API_TOKEN!,
    serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
    unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
  }

  it("returns organic results for a real query", async () => {
    const [r] = await brightDataSearch(creds).search(["anti-bot bypass api"])
    expect(r!.ok).toBe(true)
    expect(r!.hits.length).toBeGreaterThan(3)
  }, 60_000)

  it("reads a real machine-readable summary with a free direct fetch", async () => {
    const raw = await brightDataFetch(creds).get("https://stripe.com/llms.txt", "direct")
    const s = sniff(raw)
    expect(s.status).toBe("found")
    expect(s.text.length).toBeGreaterThan(10_000)
    expect(raw.usd).toBe(0)
  }, 60_000)

  it("detects the measured silent block on a hostile site", async () => {
    const raw = await brightDataFetch(creds).get("https://docs.stripe.com/radar", "unlocked")
    const s = sniff(raw)
    expect(["blocked", "not_found"]).toContain(s.status)
  }, 120_000)
})
```

Run: `OPENKB_LIVE=1 pnpm vitest run tests/live/brightdata.live.test.ts` (requires the repo `.env` exported)
Expected: PASS, 3 tests. Without `OPENKB_LIVE=1` they are skipped.

- [ ] **Step 6: Commit**

```bash
git add packages/providers packages/core/src/index.ts tests/live
git commit -m "feat(providers): bright data serp and unlocker adapters"
```

---

### Task 9: The investigator agent

**Files:**
- Create: `prompts/doctrine/00-minimum.md`
- Create: `prompts/agents/investigator.md`
- Create: `packages/core/src/prompts.ts`
- Create: `packages/core/src/investigator.ts`
- Test: `packages/core/tests/investigator.test.ts`
- Test: `tests/live/investigator.live.test.ts`

**Interfaces:**
- Consumes: `makeTools`, `RunContext` (Task 7), providers (Task 8)
- Produces:
  - `function loadPrompt(name: string, dir?: string): { frontmatter: Record<string,string>; body: string }`
  - `async function investigate(opts: { anchor: string; mission: string; ctx: RunContext; model: LanguageModel; maxSteps?: number }): Promise<{ summary: string; nodes: number; edges: number; usd: number }>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/investigator.test.ts
import { describe, it, expect } from "vitest"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { EvidenceStore } from "../src/evidence.js"
import { SpanStream } from "../src/spans.js"
import { FakeSearch, FakeFetch } from "../src/testing/fake-provider.js"
import { investigate } from "../src/investigator.js"
import { loadPrompt } from "../src/prompts.js"

describe("loadPrompt", () => {
  it("reads frontmatter and body, and fails when agent name and filename disagree", () => {
    const p = loadPrompt("investigator", "prompts/agents")
    expect(p.frontmatter.agent).toBe("investigator")
    expect(p.body.length).toBeGreaterThan(200)
  })
})

describe("investigate", () => {
  it("runs the tool loop, writes findings, and reports what it spent", async () => {
    const ctx = {
      evidence: new EvidenceStore(),
      spans: new SpanStream(),
      search: new FakeSearch({ "anti-bot bypass api": [{ url: "https://rival.com", title: "Rival", description: "bypass" }] }),
      fetch: new FakeFetch({
        "https://rival.com": { httpStatus: 200, body: "<p>" + "Rival sells an anti-bot bypass API to developers. ".repeat(8) + "</p>" },
      }),
      runId: "r1",
      agentId: "inv1",
      parentId: "lead",
      graph: { nodes: new Map(), edges: [] },
    }

    // Scripted model: search, then fetch, then remember, then a closing summary.
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const chunks =
          turn === 0
            ? [{ type: "tool-call" as const, toolCallId: "1", toolName: "search",
                 input: JSON.stringify({ queries: ["anti-bot bypass api"], why: "find rivals by capability" }) }]
            : turn === 1
              ? [{ type: "tool-call" as const, toolCallId: "2", toolName: "fetch",
                   input: JSON.stringify({ urls: ["https://rival.com"], mode: "direct", why: "confirm what this host is" }) }]
              : turn === 2
                ? [{ type: "tool-call" as const, toolCallId: "3", toolName: "remember",
                     input: JSON.stringify({
                       nodes: [{ kind: "company", name: "Rival", what: "anti-bot bypass API",
                                 whyHere: "sells the same capability to the same buyer",
                                 howFound: "anti-bot bypass api",
                                 evidence: [{ handle: "ev1", quote: "Rival sells an anti-bot bypass API" }] }],
                       edges: [],
                     }) }]
                : [{ type: "text-delta" as const, id: "t", delta: "Found one rival." }]
        return {
          stream: simulateReadableStream({
            chunks: [
              ...chunks,
              { type: "finish" as const, finishReason: turn >= 3 ? "stop" : "tool-calls",
                usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            ],
          }),
        }
      },
    })

    const out = await investigate({ anchor: "example.com", mission: "find head-on rivals", ctx, model, maxSteps: 6 })
    expect(out.nodes).toBe(1)
    expect(ctx.graph.nodes.size).toBe(1)
    const node = [...ctx.graph.nodes.values()][0]!
    expect(node.evidence[0]!.url).toBe("https://rival.com")
    expect(node.whyHere).toContain("same capability")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/investigator.test.ts`
Expected: FAIL — cannot find modules `../src/investigator.js` and `../src/prompts.js`.

- [ ] **Step 3: Write the doctrine, the agent prompt, the loader, and the agent**

```markdown
<!-- prompts/doctrine/00-minimum.md -->
---
doctrine: 00-minimum
---
## Why finding a market is hard

Every company describes itself in words it invented. Searching those words returns that
company and nothing else — its own pages, its own docs, its own press. This is not a
volume problem. Fifty branded queries do not beat five: the anchor is the ceiling, not
the count.

Measured, across two very different markets: describing what a product *does* returned
roughly twice the distinct vendors that naming its category did, and the two barely
overlapped — 3 shared out of 20 in software, 2 out of 23 in manufacturing. In one
industrial market, brand-anchored queries returned five results and **not one** was a
real company; they were review sites, an SEO farm, and a different company with a
similar name.

So: work out what the thing does, then describe that to a search engine several ways,
at several levels of specificity. Each description is a different question and reaches
a different part of the web.

## Words that fail

A term built from the company's own coinages is not a market — it is a product name
with a generic noun attached, and every result is a page that company wrote. Watch for
this: a term can look perfectly generic and still be a coinage. If a search returns the
company's own properties, the query bought nothing, and its own open-source projects
and docs domains count as its properties even when the name looks unrelated.

The opposite failure does not announce itself the same way. A term can be clean of the
brand and still be wrong, because it is so broad it names a different market entirely.
Nothing in the results will look like an error. You have to check that what came back
actually does the job the anchor does.

## Reading a company

There is no fixed order to try. The cheap route inverts by company type: developer-tool
companies often publish a machine-readable summary at a conventional path while their
homepage is an empty shell that renders in the browser, and older industrial companies
are the exact reverse — no summary at all, but a homepage that hands you thousands of
words of plain text for free. Look at what you got, and judge.

Where structure exists, use it. A large document with many headings is usually an index,
and the headings alone can carry the whole product line at a fraction of the bytes. A
large document with almost no headings is usually a dump of links, and stripping it to
headings destroys the signal instead of concentrating it.

## Players and publishers

Record the companies a page names; never record the page. A roundup listing ten vendors
is worth reading precisely because it names ten vendors — it is not itself one of them.

But do not decide what a host is from a search snippet. A vendor writing "the best
alternatives to X" looks exactly like a publisher and is not one — it is a competitor
spending money to position against X, which makes the article evidence rather than
noise. When you need to know what a host actually is, fetch its front page directly.
That costs nothing.

## What a claim must carry

Every node and edge needs: what it is, why it belongs on this map stated against the
company you started from, the query or page that surfaced it, and a quote from a page
you actually fetched. "Similar company" is worth nothing to a reader. Say what it sells
and to whom, and say why a buyer looking at the anchor would end up looking at this.

You cannot cite a page you did not fetch. Quotes are checked against the bytes.
```

```markdown
<!-- prompts/agents/investigator.md -->
---
agent: investigator
includes: [00-minimum]
---
You are investigating one angle on a market, on behalf of a map someone else is
assembling. You will be given the company the map is anchored on, and one mission.

Work the mission you were given. Do not spread into other angles — someone else has
those, and duplicating them wastes the run.

How to spend:

- Search broadly and early. Searches are cheap and each distinct phrasing reaches a
  different part of the web. Batch them: one call takes many queries.
- Fetching a page directly is free. Use it freely — especially to find out what a host
  actually is.
- An unlocked fetch costs real money and takes 13 to 16 seconds. Spend one on a page
  that will name many companies at once. Do not spend one to identify a single vendor;
  the snippet and a free fetch already told you.
- Write findings with `remember` **as you go**, never in one batch at the end. A run
  can end before you are finished, and anything unwritten is lost.

Tools answer in words, including when they refuse. A refusal is information: adjust and
carry on. If a page comes back blocked or empty, that is a fact about the page, not an
error to retry blindly.

Stop when new searches keep returning things you have already written down.

Finish with two or three sentences on what you found and what you did not — the gaps
matter as much as the finds.
```

```ts
// packages/core/src/prompts.ts
import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface LoadedPrompt {
  frontmatter: Record<string, string>
  body: string
}

/**
 * Minimal frontmatter reader. The filename is the identity: a prompt whose `agent`
 * disagrees with its filename is a bug that must fail loudly rather than run silently.
 */
export function loadPrompt(name: string, dir: string): LoadedPrompt {
  const raw = readFileSync(join(dir, `${name}.md`), "utf8")
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!m) throw new Error(`${name}.md has no frontmatter`)
  const frontmatter: Record<string, string> = {}
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim())
    if (kv) frontmatter[kv[1]!] = kv[2]!.trim()
  }
  const key = frontmatter.agent ?? frontmatter.doctrine
  if (key && key !== name) throw new Error(`${name}.md declares "${key}" — filename and identity must match`)
  return { frontmatter, body: m[2]!.trim() }
}

/** Compose an agent prompt with the doctrine files it declares in `includes`. */
export function composePrompt(agent: string, agentsDir: string, doctrineDir: string): string {
  const a = loadPrompt(agent, agentsDir)
  const includes = (a.frontmatter.includes ?? "").replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean)
  const parts = includes.map((d) => loadPrompt(d, doctrineDir).body)
  return [...parts, a.body].join("\n\n---\n\n")
}
```

```ts
// packages/core/src/investigator.ts
import { ToolLoopAgent, stepCountIs, type LanguageModel } from "ai"
import { makeTools, type RunContext } from "./tools.js"
import { composePrompt } from "./prompts.js"

export interface InvestigateOptions {
  anchor: string
  mission: string
  ctx: RunContext
  model: LanguageModel
  maxSteps?: number
  agentsDir?: string
  doctrineDir?: string
}

export interface InvestigateResult {
  summary: string
  nodes: number
  edges: number
  usd: number
}

/**
 * One agent, one mission, its own context. It writes findings as it goes, so a run that
 * dies partway still leaves everything the agent actually proved.
 */
export async function investigate(opts: InvestigateOptions): Promise<InvestigateResult> {
  const { anchor, mission, ctx, model } = opts
  const beforeNodes = ctx.graph.nodes.size
  const beforeEdges = ctx.graph.edges.length
  const beforeUsd = ctx.spans.totalUsd()

  const instructions = composePrompt(
    "investigator",
    opts.agentsDir ?? "prompts/agents",
    opts.doctrineDir ?? "prompts/doctrine",
  )

  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools: makeTools(ctx),
    stopWhen: stepCountIs(opts.maxSteps ?? 24),
  })

  const result = await agent.generate({
    prompt: `The map is anchored on: ${anchor}\n\nYour mission: ${mission}\n\nGO.`,
  })

  return {
    summary: result.text,
    nodes: ctx.graph.nodes.size - beforeNodes,
    edges: ctx.graph.edges.length - beforeEdges,
    usd: ctx.spans.totalUsd() - beforeUsd,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/investigator.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the live end-to-end test**

```ts
// tests/live/investigator.live.test.ts
import { describe, it, expect } from "vitest"
import { openrouter } from "@openrouter/ai-sdk-provider"
import { EvidenceStore, SpanStream, investigate } from "@open-kb/core"
import { brightDataSearch, brightDataFetch } from "@open-kb/providers"

const live = process.env.OPENKB_LIVE === "1"

describe.skipIf(!live)("investigator, live", () => {
  it("finds real companies with real citations", async () => {
    const creds = {
      token: process.env.BRIGHTDATA_API_TOKEN!,
      serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
      unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
    }
    const ctx = {
      evidence: new EvidenceStore(),
      spans: new SpanStream(),
      search: brightDataSearch(creds),
      fetch: brightDataFetch(creds),
      runId: "live1",
      agentId: "inv1",
      parentId: null,
      graph: { nodes: new Map(), edges: [] },
    }

    const out = await investigate({
      anchor: "resend.com",
      mission:
        "Find companies selling the same capability: an API developers call to send transactional email from an application. " +
        "Describe that capability to the search engine several different ways rather than naming the anchor.",
      ctx,
      model: openrouter(process.env.OPENKB_MODEL ?? "google/gemini-3-flash-preview"),
      maxSteps: 20,
    })

    expect(out.nodes).toBeGreaterThanOrEqual(3)

    // Every claim must be provable — this is the whole promise.
    for (const n of ctx.graph.nodes.values()) {
      expect(n.evidence.length).toBeGreaterThan(0)
      expect(n.whyHere.length).toBeGreaterThan(20)
      for (const e of n.evidence) expect(ctx.evidence.hasFetched(e.url)).toBe(true)
    }

    console.log(`nodes=${out.nodes} edges=${out.edges} usd=$${out.usd.toFixed(4)}`)
  }, 300_000)
})
```

Run: `OPENKB_LIVE=1 pnpm vitest run tests/live/investigator.live.test.ts`
Expected: PASS. Prints the node count and the real dollar cost — **the first real measurement of what work costs.**

- [ ] **Step 6: Commit**

```bash
git add prompts packages/core/src/prompts.ts packages/core/src/investigator.ts packages/core/tests/investigator.test.ts tests/live/investigator.live.test.ts
git commit -m "feat(core): investigator agent with minimum doctrine"
```

---

## Done when

- `pnpm test` is green with zero network access.
- `pnpm check` passes the core purity gate.
- `OPENKB_LIVE=1 pnpm test` runs a real investigator against `resend.com` and returns at least three companies, every one with a quote traceable to a URL the run actually fetched.
- The console prints what that run cost.

## Not in this plan

The lead agent, the board, the lanes, non-blocking spawn, convergence termination, the full doctrine, the web demo, the CLI, and the skill. Plan 2 starts at the lead.

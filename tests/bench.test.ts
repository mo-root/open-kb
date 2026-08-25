import { describe, expect, it } from "vitest"
import { deriveRun, label, median, medianRow, runRow, stampOf, table, type Envelope, type Run } from "../scripts/bench.js"

/**
 * `pnpm bench`'s reading and row-building logic had no direct test anywhere.
 * The whole file ran at import time (argv, `readFileSync`/`readdirSync`,
 * console), so nothing could import it in a test process — the same shape
 * `bakeoff.ts`, `diff-runs.ts`, `read.ts` and the other CLI readers were in
 * before their own fires. Coverage gap found sweeping `scripts/*.ts beyond
 * sweep.ts` (D-scope: "areas nobody has swept" — this branch's
 * `docs/overnight-backlog.md` is gone, per 481fa6d; SELF-62 through SELF-66
 * established scripts/*.ts as where this convention keeps finding work once
 * that file stopped existing).
 *
 * `readRun` (disk I/O: `readFileSync`, `statSync`, JSON.parse with a
 * try/catch for a non-JSON file) is split the same way `diff-runs.ts`'s
 * `parseRun` was split from its own `readRun`: the shape-sniffing and
 * aggregation pulled out as pure `deriveRun(file, json, mtimeMs)`, gated CLI
 * body behind the same `invokedDirectly` guard those files use. No behavior
 * changed — same field reads, same era/engine detection, same table shape.
 */

const run = (over: Partial<Run> = {}): Run => ({
  file: "sweep-a-com-20260101120000.json",
  engine: "sweep",
  source: "cli",
  anchor: "a.com",
  at: Date.parse("2026-08-06T14:00:00Z"),
  atFrom: "filename",
  grounded: true,
  markers: [],
  hosts: 100,
  onMap: 40,
  noise: 5,
  selfRow: null,
  rivals: 12,
  companies: 8,
  products: 20,
  unread: 3,
  medGrounded: 0.81,
  edges: 60,
  usd: 1.386,
  seconds: 812,
  statQueries: 18,
  firedQueries: 26,
  ...over,
})

describe("stampOf", () => {
  it("parses the fourteen-digit stamp (with seconds) as UTC", () => {
    expect(stampOf("sweep-a-com-20260821105321.json")).toBe(Date.parse("2026-08-21T10:53:21Z"))
  })

  it("parses the twelve-digit stamp (pre-seconds era), seconds defaulting to 00", () => {
    expect(stampOf("sweep-a-com-202608211053.json")).toBe(Date.parse("2026-08-21T10:53:00Z"))
  })

  it("returns null when the filename carries no stamp at all", () => {
    expect(stampOf("notes-a-com.json")).toBeNull()
  })

  it("returns null when the stamp digits parse to an invalid date", () => {
    expect(stampOf("sweep-a-com-20261399995999.json")).toBeNull()
  })
})

describe("median", () => {
  it("returns null for an empty population", () => {
    expect(median([])).toBeNull()
  })

  it("returns the middle value of an odd-length population, sorted first", () => {
    expect(median([5, 1, 3])).toBe(3)
  })

  it("averages the two middle values of an even-length population, sorted first", () => {
    expect(median([8, 2, 4, 6])).toBe(5)
  })

  it("does not mutate its input", () => {
    const xs = [3, 1, 2]
    median(xs)
    expect(xs).toEqual([3, 1, 2])
  })
})

const company = (domain: string, over: Record<string, unknown> = {}) => ({
  name: domain,
  domain,
  kind: "company",
  relation: "competitor",
  ...over,
})

describe("deriveRun", () => {
  it("reads top-level entities — the sweep and swarm shape", () => {
    const json: Envelope = { anchor: "a.com", entities: [company("a.com"), company("b.com")] }
    const r = deriveRun("sweep-a-com-20260101120000.json", json, 0)
    expect("engine" in r).toBe(true)
    expect((r as Run).onMap).toBe(1) // a.com is the self row, excluded
  })

  it("reads entities under result — the kernel wrapper shape", () => {
    const json: Envelope = { result: { anchor: "b.com", entities: [company("c.com")] } }
    const r = deriveRun("kernel-b-com-20260101120000.json", json, 0) as Run
    expect(r.onMap).toBe(1)
    expect(r.anchor).toBe("b.com")
  })

  it("refuses a shape with neither, naming the keys it did find", () => {
    const r = deriveRun("weird.json", { foo: 1 } as unknown as Envelope, 0)
    expect(r).toEqual({ file: "weird.json", why: "no entities at the top level or under result (keys: foo)" })
  })

  it("detects the swarm engine by a `tier` field on any row, not by filename", () => {
    const json: Envelope = { anchor: "a.com", entities: [company("x.com", { tier: "peek" })] }
    const r = deriveRun("swarm-a-com-20260101120000.json", json, 0) as Run
    expect(r.engine).toBe("swarm")
  })

  it("defaults to sweep when no row carries a tier", () => {
    const json: Envelope = { anchor: "a.com", entities: [company("x.com")] }
    const r = deriveRun("web-run.json", json, 0) as Run
    expect(r.engine).toBe("sweep")
  })

  it("refuses a file whose name and row shape disagree on engine", () => {
    const json: Envelope = { anchor: "a.com", entities: [company("x.com", { tier: "peek" })] }
    const r = deriveRun("sweep-a-com-20260101120000.json", json, 0)
    expect(r).toEqual({ file: "sweep-a-com-20260101120000.json", why: "named sweep but its rows look like swarm" })
  })

  it("marks source cli for a swarm-/sweep-named file, web otherwise", () => {
    const json: Envelope = { anchor: "a.com", entities: [company("x.com")] }
    expect((deriveRun("sweep-a-com-20260101120000.json", json, 0) as Run).source).toBe("cli")
    expect((deriveRun("kernel-run-20260101.json", json, 0) as Run).source).toBe("web")
  })

  it("normalizes the anchor: www-stripped, lowercased, falling back to domain then '(unnamed)'", () => {
    const withAnchor = deriveRun("f.json", { anchor: "www.A.com", entities: [company("x.com")] }, 0) as Run
    expect(withAnchor.anchor).toBe("a.com")
    const withDomain = deriveRun("f.json", { domain: "B.com", entities: [company("x.com")] }, 0) as Run
    expect(withDomain.anchor).toBe("b.com")
    const withNeither = deriveRun("f.json", { entities: [company("x.com")] }, 0) as Run
    expect(withNeither.anchor).toBe("(unnamed)")
  })

  it("falls through at/atFrom: filename stamp, then endedAt, then the passed-in mtime", () => {
    const json: Envelope = { anchor: "a.com", entities: [company("x.com")] }
    const byFilename = deriveRun("sweep-a-com-20260821105321.json", json, 999) as Run
    expect(byFilename.atFrom).toBe("filename")
    expect(byFilename.at).toBe(Date.parse("2026-08-21T10:53:21Z"))

    const byEndedAt = deriveRun("web-run.json", { ...json, endedAt: 12345 }, 999) as Run
    expect(byEndedAt.atFrom).toBe("endedAt")
    expect(byEndedAt.at).toBe(12345)

    const byMtime = deriveRun("web-run.json", json, 777) as Run
    expect(byMtime.atFrom).toBe("mtime")
    expect(byMtime.at).toBe(777)
  })

  it("excludes noise rows and the anchor's own row from every count, and reports them separately", () => {
    const json: Envelope = {
      anchor: "a.com",
      entities: [company("a.com"), company("junk.com", { kind: "noise" }), company("b.com"), company("c.com")],
    }
    const r = deriveRun("f.json", json, 0) as Run
    expect(r.onMap).toBe(2)
    expect(r.noise).toBe(1)
    expect(r.selfRow).toEqual(company("a.com"))
  })

  it("counts rivals as competitor + substitute, and companies/products by kind", () => {
    const json: Envelope = {
      anchor: "a.com",
      entities: [
        company("b.com", { relation: "competitor" }),
        company("c.com", { relation: "substitute" }),
        company("d.com", { relation: "adjacent" }),
        company("e.com", { kind: "product", relation: "competitor" }),
      ],
    }
    const r = deriveRun("f.json", json, 0) as Run
    expect(r.rivals).toBe(3)
    expect(r.companies).toBe(3) // b.com, c.com, d.com all default to kind "company"
    expect(r.products).toBe(1)
  })

  it("is in the grounding era once any kept row carries descGrounded or unreadableReason, and only then counts unread", () => {
    const groundedJson: Envelope = { anchor: "a.com", entities: [company("b.com", { descGrounded: 0.5 })] }
    const g = deriveRun("f.json", groundedJson, 0) as Run
    expect(g.grounded).toBe(true)
    expect(g.medGrounded).toBe(0.5)

    const ungroundedJson: Envelope = { anchor: "a.com", entities: [company("b.com")] }
    const u = deriveRun("f.json", ungroundedJson, 0) as Run
    expect(u.grounded).toBe(false)
    expect(u.unread).toBeNull()

    const unreadJson: Envelope = {
      anchor: "a.com",
      entities: [company("b.com", { unreadableReason: "404" }), company("c.com")],
    }
    const r = deriveRun("f.json", unreadJson, 0) as Run
    expect(r.grounded).toBe(true)
    expect(r.unread).toBe(1)
  })

  it("fingerprints which optional fields appear on any row, in MARKERS order", () => {
    const json: Envelope = {
      anchor: "a.com",
      entities: [company("b.com", { descGrounded: 0.5 }), company("c.com", { tier: "peek" })],
    }
    const r = deriveRun("f.json", json, 0) as Run
    expect(r.markers).toEqual(["tier", "descGrounded"])
  })

  it("reads stats and edges, null-safe when a field is missing or the wrong type", () => {
    const json: Envelope = {
      anchor: "a.com",
      entities: [company("b.com")],
      edges: [{}, {}],
      stats: { hosts: 50, usd: "oops" as unknown as number, seconds: 100, queries: 18 },
      searched: [{}, {}, {}],
    }
    const r = deriveRun("f.json", json, 0) as Run
    expect(r.hosts).toBe(50)
    expect(r.usd).toBeNull()
    expect(r.seconds).toBe(100)
    expect(r.statQueries).toBe(18)
    expect(r.firedQueries).toBe(3)
    expect(r.edges).toBe(2)
  })
})

describe("table", () => {
  it("right-aligns known numeric columns and left-aligns the rest", () => {
    const md = table(["anchor", "hosts"], [["a.com", "5"]])
    expect(md).toBe(["| anchor | hosts |", "| :--- | ---: |", "| a.com | 5 |"].join("\n"))
  })

  it("renders a header with no rows", () => {
    expect(table(["anchor"], [])).toBe(["| anchor |", "| :--- |"].join("\n"))
  })
})

describe("label", () => {
  it("prints the anchor and the UTC stamp, month-day hour:minute", () => {
    expect(label(run({ at: Date.parse("2026-08-06T23:31:00Z"), anchor: "clerk.com" }))).toBe("`clerk.com` 08-06 23:31")
  })

  it("omits the stamp when at is null", () => {
    expect(label(run({ at: null }))).toBe("`a.com`")
  })

  it("daggers a run stamped before the meter learned per-model prices", () => {
    expect(label(run({ at: Date.parse("2026-08-01T00:00:00Z") }))).toContain("†")
    expect(label(run({ at: Date.parse("2026-08-10T00:00:00Z") }))).not.toContain("†")
  })

  it("marks a web-sourced run", () => {
    expect(label(run({ source: "web" }))).toContain("*(web)*")
  })
})

describe("runRow", () => {
  it("formats every cell, null reading as an em dash", () => {
    expect(
      runRow(
        run({
          at: Date.parse("2026-08-10T00:00:00Z"),
          hosts: 100,
          onMap: 40,
          rivals: 12,
          unread: 10,
          medGrounded: 0.812,
          usd: 2,
          seconds: 100.6,
        }),
      ),
    ).toEqual(["`a.com` 08-10 00:00", "100", "40", "12", "25%", "0.81", "2.00", "101", "0.0500"])
  })

  it("renders every unmeasured field as an em dash rather than 0 or NaN", () => {
    expect(runRow(run({ hosts: null, onMap: 0, unread: null, medGrounded: null, usd: null, seconds: null }))).toEqual([
      "`a.com` 08-06 14:00",
      "—",
      "0",
      "12",
      "—",
      "—",
      "—",
      "—",
      "—",
    ])
  })
})

describe("medianRow", () => {
  it("takes the median of each column independently, $/entity as the median of the per-run ratios", () => {
    const rows = [
      run({ hosts: 100, onMap: 40, usd: 2, seconds: 100 }), // 0.05/entity
      run({ hosts: 200, onMap: 20, usd: 4, seconds: 200 }), // 0.2/entity
    ]
    const cells = medianRow(rows)
    expect(cells[0]).toBe("**median of 2**")
    expect(cells[1]).toBe("150") // hosts
    expect(cells[2]).toBe("30") // onMap
    expect(cells[6]).toBe("3.00") // usd
    expect(cells[8]).toBe("0.1250") // median of [0.05, 0.2]
  })

  it("reads as all em dashes over zero runs", () => {
    expect(medianRow([])).toEqual(["**median of 0**", "—", "—", "—", "—", "—", "—", "—", "—"])
  })
})

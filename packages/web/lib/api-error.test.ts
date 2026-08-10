import { format } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { faultNotice, faultRef, faultResponse, guarded, logFault, namedFaults } from "./api-error"

/**
 * The exact string measured escaping lib/runs.ts on a `next start` with
 * OPENKB_RUNS_DIR=/. Every leak assertion below is written against this rather
 * than a stand-in, because it is what actually reaches this code today, and it
 * is what makes the leak concrete: a variable's name, a value, and two paths.
 */
const REAL_FAULT = new Error(
  'OPENKB_RUNS_DIR is "/", which resolves to / — the filesystem root. No run can ' +
    "be read or written there. Point it at a subdirectory, e.g. /openkb-runs.",
)

/** Every fragment of that message a body must never contain in production. */
const SECRETS = ["OPENKB_RUNS_DIR", "filesystem root", "/openkb-runs", "resolves to"]

let logged: unknown[][]

beforeEach(() => {
  logged = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/** What `grep <ref>` would actually print: console.error's own formatting,
 *  first line only. Asserting on this rather than on the arguments is the only
 *  way to pin the claim the module makes — that the ref and the message land on
 *  ONE line, unlike the page digest, which needs `grep -B6`. */
function firstLoggedLine(): string {
  const args = logged[0]
  if (!args) throw new Error("nothing was logged")
  return format(...args).split("\n")[0] ?? ""
}

const req = (url = "https://kb.test/api/kb", method = "GET") => new Request(url, { method })

describe("faultRef", () => {
  it("is 12 hex characters", () => {
    expect(faultRef()).toMatch(/^[0-9a-f]{12}$/)
  })

  it("names one occurrence, not an error class", () => {
    // The opposite of React's digest, which hashes the message. Two faults from
    // the same cause must be separable, or "here is my ref" narrows nothing.
    const a = faultResponse(REAL_FAULT, req())
    const b = faultResponse(REAL_FAULT, req())
    expect(a.status).toBe(500)
    expect(b.status).toBe(500)
    expect(logged).toHaveLength(2)
    expect(format(...logged[0]!)).not.toBe(format(...logged[1]!))
  })
})

describe("faultResponse", () => {
  it("answers 500 with a JSON content-type", async () => {
    // The measured fault was 500, zero bytes, and NO content-type header at
    // all, so the header is half of what is being fixed.
    const res = faultResponse(REAL_FAULT, req())
    expect(res.status).toBe(500)
    expect(res.headers.get("content-type")).toMatch(/application\/json/)
    expect((await res.text()).length).toBeGreaterThan(0)
  })

  it("is not cacheable", () => {
    // A cached 500 hands one request's ref to every reader who follows it.
    expect(faultResponse(REAL_FAULT, req()).headers.get("cache-control")).toBe("no-store")
  })

  it("carries the ref in the body and in the log, identically", async () => {
    const body = (await faultResponse(REAL_FAULT, req()).json()) as { ref: string }
    expect(body.ref).toMatch(/^[0-9a-f]{12}$/)
    expect(firstLoggedLine()).toContain(body.ref)
  })

  it("puts the ref and the cause on the same log line, so a bare grep works", () => {
    faultResponse(REAL_FAULT, req("https://kb.test/api/kb/x/note?path=y"))
    const line = firstLoggedLine()
    expect(line).toContain("OPENKB_RUNS_DIR")
    expect(line).toContain("GET /api/kb/x/note?path=y")
  })

  it("spells the ref into `error`, which is the field the clients render", async () => {
    // NoteView and KbOverview print `error` and nothing else. If the token were
    // only in `ref`, a screenshot of a broken panel would carry no token.
    const body = (await faultResponse(REAL_FAULT, req()).json()) as { error: string; ref: string }
    expect(body.error).toContain(body.ref)
  })

  describe("in production", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production")
    })

    it("puts no server-origin text in the body at all", async () => {
      const text = await faultResponse(REAL_FAULT, req()).text()
      for (const secret of SECRETS) expect(text).not.toContain(secret)
    })

    it("omits `detail` entirely rather than blanking it", async () => {
      const body = (await faultResponse(REAL_FAULT, req()).json()) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(["error", "ref"])
    })

    it("still logs the whole thing server-side", () => {
      faultResponse(REAL_FAULT, req())
      expect(firstLoggedLine()).toContain("filesystem root")
    })

    it("redacts a thrown non-Error too", async () => {
      const text = await faultResponse(`OPENKB_RUNS_DIR is "/"`, req()).text()
      expect(text).not.toContain("OPENKB_RUNS_DIR")
    })
  })

  describe("outside production", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "development")
    })

    it("carries the real message as `detail`", async () => {
      const body = (await faultResponse(REAL_FAULT, req()).json()) as { detail?: string }
      expect(body.detail).toBe(REAL_FAULT.message)
    })

    it("keeps `error` fixed, so its meaning never changes with the build mode", async () => {
      const dev = (await faultResponse(REAL_FAULT, req()).json()) as { error: string; ref: string }
      vi.stubEnv("NODE_ENV", "production")
      const prod = (await faultResponse(REAL_FAULT, req()).json()) as { error: string; ref: string }
      expect(dev.error.replace(dev.ref, "<ref>")).toBe(prod.error.replace(prod.ref, "<ref>"))
    })

    it("stringifies a thrown non-Error", async () => {
      const body = (await faultResponse("kaboom", req()).json()) as { detail?: string }
      expect(body.detail).toBe("kaboom")
    })
  })
})

describe("logFault", () => {
  // The stream route's only option once its headers are gone.
  it("returns a ref and logs it without producing a response", () => {
    const ref = logFault(REAL_FAULT, req("https://kb.test/api/run/abc/stream"))
    expect(ref).toMatch(/^[0-9a-f]{12}$/)
    expect(firstLoggedLine()).toContain(ref)
    expect(firstLoggedLine()).toContain("GET /api/run/abc/stream")
  })

  it("survives a caller that has no Request to hand", () => {
    expect(() => logFault(REAL_FAULT)).not.toThrow()
    expect(firstLoggedLine()).toContain("(no request)")
  })
})

describe("namedFaults — the whole shelf", () => {
  it("is exactly this list", () => {
    // Not a brittle test, the review. Widening the set of sentences a page may
    // print verbatim is the failure this mechanism exists to make hard, so it
    // costs a red line here and someone reading the new entry before it ships.
    expect(Object.keys(namedFaults).sort()).toEqual([
      "demoMapsMissing",
      "runsDirIsRoot",
      "runsDirUnreadable",
    ])
  })

  it("mints the exact string that was measured escaping the pages", () => {
    // Byte for byte with 81bd308's wording. The catalogue took the text out of
    // lib/runs.ts; this is what stops that move from becoming a rewrite.
    expect(namedFaults.runsDirIsRoot("/", "/").message).toBe(REAL_FAULT.message)
  })

  it("tells a demo that lost its maps apart from a demo with none", () => {
    // The third entry earns its place on exactly the argument the header of
    // `namedFaults` sets: there is a remedy in the environment and the sentence
    // names it. Without this the failure renders as "Nothing mapped yet." on a
    // deployment carrying six maps in its bundle — 81bd308's lie, told by the
    // one mode that must never send a reader off to build a map themselves.
    const message = namedFaults.demoMapsMissing("/var/task", "demo/maps").message
    expect(message).toContain("demo/maps")
    expect(message).toContain("/var/task")
    expect(message).toContain("OPENKB_DEMO_MAPS_DIR")
    expect(message).toMatch(/not an empty demo/i)
  })

  it("says it in this app's own words, with nothing caught in the holes", () => {
    // The rule every entry lives under: the prose is a literal in api-error.ts
    // and the holes take values this app computed. Both of these are — a path
    // this module resolved and a constant lib/runs.ts spells out — so a
    // `faultNotice` may print the whole thing to a stranger's browser.
    const shown = faultNotice(namedFaults.demoMapsMissing("/var/task", "demo/maps"), "GET /kb")
    expect(shown).toContain("OPENKB_DEMO")
    expect(shown).not.toMatch(/quote ref/)
  })
})

describe("faultNotice — what a page is allowed to say", () => {
  it("prints a named fault in full, because that message IS the product", () => {
    // The inversion of every leak assertion above: the same string that must
    // never escape an unknown fault is the string an operator needs here. It
    // names the variable they set and the subdirectory that fixes it.
    const shown = faultNotice(namedFaults.runsDirIsRoot("/", "/"), "GET /kb")
    expect(shown).toBe(REAL_FAULT.message)
    for (const secret of SECRETS) expect(shown).toContain(secret)
  })

  it("does not log a named fault — there is nothing to correlate", () => {
    // /kb re-reads the registry on every request. A line per render would bury
    // the faults that actually carry a ref.
    faultNotice(namedFaults.runsDirIsRoot("/", "/"), "GET /kb")
    expect(logged).toHaveLength(0)
  })

  it("recognises the brand when `instanceof` cannot — a second module copy", () => {
    // Same hazard lib/runs.ts keeps its registry on `Symbol.for` for: two
    // copies of a module make `instanceof` false between them, and the failure
    // would be silent — the useful message replaced by a ref.
    const fromAnotherCopy = new Error(REAL_FAULT.message)
    Object.defineProperty(fromAnotherCopy, Symbol.for("open-kb.named-fault"), { value: true })
    expect(faultNotice(fromAnotherCopy, "GET /kb")).toBe(REAL_FAULT.message)
    expect(logged).toHaveLength(0)
  })

  it("carries the ref in what the page shows and on the log line, identically", () => {
    const shown = faultNotice(new Error("kaboom"), "GET /runs")
    const ref = /ref ([0-9a-f]{12})/.exec(shown)?.[1]
    expect(ref).toBeDefined()
    expect(firstLoggedLine()).toContain(ref)
    // A page has no Request to hand, so it passes its own route instead.
    expect(firstLoggedLine()).toContain("GET /runs")
    expect(firstLoggedLine()).toContain("kaboom")
  })

  it("prints neither an unknown fault's message nor any fragment of it", () => {
    vi.stubEnv("NODE_ENV", "production")
    // REAL_FAULT unnamed stands in for the throw this catch is unbounded
    // against — today a `summaryOf` bug, tomorrow anything. Same words, no
    // catalogue entry, and therefore not repeatable.
    const shown = faultNotice(REAL_FAULT, "GET /kb")
    for (const secret of SECRETS) expect(shown).not.toContain(secret)
    expect(shown).toMatch(/quote ref [0-9a-f]{12}/)
    // The words themselves are not lost, they are just not in the page.
    expect(firstLoggedLine()).toContain("filesystem root")
  })

  it("says the same thing outside production, because a page has only one string", () => {
    // Deliberately unlike `faultResponse`, which may add `detail` in dev. There
    // the fixed sentence still ships in `error`; here the sentence IS the whole
    // message, so a build-mode branch would be the leak the day a build mode is
    // wrong.
    vi.stubEnv("NODE_ENV", "development")
    const shown = faultNotice(REAL_FAULT, "GET /kb")
    for (const secret of SECRETS) expect(shown).not.toContain(secret)
  })

  it("redacts a thrown non-Error too", () => {
    expect(faultNotice(`OPENKB_RUNS_DIR is "/"`, "GET /kb")).not.toContain("OPENKB_RUNS_DIR")
  })

  const ANYTHING: [string, unknown][] = [
    ["a named fault", namedFaults.runsDirIsRoot("/", "/")],
    ["an ordinary error", new Error("kaboom")],
    ["an error with no message", new Error("")],
    ["a thrown string", "kaboom"],
    ["a thrown empty string", ""],
    ["a thrown object", { code: 500 }],
    ["null", null],
    ["undefined", undefined],
  ]

  it.each(ANYTHING)("never returns an empty string, given %s", (_what, thrown) => {
    expect(faultNotice(thrown, "GET /kb")).not.toBe("")
  })

  it("keeps 'unreadable' distinguishable from 'nothing here yet', on both branches", () => {
    // The ladder both list pages render, reproduced exactly:
    //   error ? "Could not list…" : rows.length === 0 ? "Nothing mapped yet." : <table>
    // An empty notice would take the second rung and restore the lie 81bd308
    // removed — an operator who pointed OPENKB_RUNS_DIR somewhere unusable is
    // told their deployment has never run anything, and goes off to pay again.
    const ladder = (err: unknown) => (faultNotice(err, "GET /kb") ? "could not list" : "nothing yet")
    expect(ladder(namedFaults.runsDirIsRoot("/", "/"))).toBe("could not list")
    expect(ladder(new Error(""))).toBe("could not list")
    expect(ladder("")).toBe("could not list")
    expect(ladder(undefined)).toBe("could not list")
  })
})

describe("guarded", () => {
  it("returns a handler's response untouched", async () => {
    const handler = guarded(async () => Response.json({ kbs: [] }))
    const res = await handler()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kbs: [] })
    expect(logged).toHaveLength(0)
  })

  it("leaves a deliberate refusal byte-identical and unlogged", async () => {
    // The whole class this must not touch: 404 "no such knowledge base", 400
    // "path is required", and api/map/route.ts's 400/503/429. They are returns,
    // not throws.
    const handler = guarded(async () =>
      Response.json({ error: "no such knowledge base" }, { status: 404 }),
    )
    const res = await handler()
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('{"error":"no such knowledge base"}')
    expect(logged).toHaveLength(0)
  })

  it("turns a throw into the fault response", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const handler = guarded(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
      await params
      throw REAL_FAULT
    })
    const res = await handler(req("https://kb.test/api/kb/abc"), { params: Promise.resolve({ id: "abc" }) })
    expect(res.status).toBe(500)
    const text = await res.text()
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    expect(text).toContain((JSON.parse(text) as { ref: string }).ref)
    expect(firstLoggedLine()).toContain("GET /api/kb/abc")
  })

  it("catches a synchronous throw, not only a rejected promise", async () => {
    const handler = guarded((): Response => {
      throw REAL_FAULT
    })
    expect((await handler()).status).toBe(500)
  })

  it("logs `(no request)` rather than crashing when the first argument is not one", async () => {
    const handler = guarded(async () => {
      throw REAL_FAULT
    })
    expect((await handler()).status).toBe(500)
    expect(firstLoggedLine()).toContain("(no request)")
  })
})

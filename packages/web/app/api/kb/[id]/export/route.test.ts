import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GET } from "./route"

/**
 * The one route of the four that answers something other than JSON on
 * success, which is exactly why its own header comment argues a JSON fault
 * body is still correct on failure — `findKb`'s refusal is a `Response`
 * already built, so this route returns it unchanged rather than wrapping it
 * in a zip. Untested anywhere, per `kb-lookup.test.ts`'s own comment; this
 * pins both halves — the JSON refusal on a bad id, and the zip's headers and
 * contents on a real one.
 */

const UUID = "9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704"

function sweepResult() {
  return {
    anchor: "resend.com",
    decomposition: { sells: "transactional email", buyer: "developers" },
    queries: [],
    entities: [
      {
        name: "Postmark",
        domain: "postmarkapp.com",
        kind: "company",
        relation: "competitor",
        what: "A transactional email provider.",
        why: "Sells the same thing to the same buyer.",
      },
    ],
    edges: [],
    stats: { queries: 4, results: 0, hosts: 0, kept: 0, tokIn: 0, tokOut: 0, serpCalls: 0, unlockerCalls: 0, usd: 0, seconds: 1 },
    report: {},
  }
}

function req(id: string): [Request, { params: Promise<{ id: string }> }] {
  return [new Request(`https://kb.test/api/kb/${id}/export`), { params: Promise.resolve({ id }) }]
}

let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-kb-export-route-"))
  for (const k of ["OPENKB_RUNS_DIR", "OPENKB_DEMO", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
    saved[k] = process.env[k]
  }
  process.env.OPENKB_RUNS_DIR = dir
  process.env.OPENKB_DEMO = ""
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SECRET_KEY

  await writeFile(
    path.join(dir, `run-${UUID}.json`),
    JSON.stringify({
      id: UUID,
      domain: "resend.com",
      queries: 4,
      startedAt: 0,
      endedAt: 1,
      status: "complete",
      result: sweepResult(),
    }),
    "utf8",
  )
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(dir, { recursive: true, force: true })
})

describe("GET /api/kb/[id]/export", () => {
  it("404s an id that names no run — findKb's own JSON refusal, not a corrupt zip", async () => {
    const res = await GET(...req("00000000-0000-4000-8000-000000000000"))
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).not.toBe("application/zip")
    expect(await res.json()).toEqual({ error: "no such knowledge base" })
  })

  it("answers with a zip, named after the anchor, containing the exported markdown", async () => {
    const res = await GET(...req(UUID))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/zip")
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="kb-resend-com.zip"')

    // zipOf stores rather than compresses (see zip.test.ts), so the markdown
    // this route built via exportKbFiles is readable straight out of the
    // buffer without an unzip step.
    const buf = new Uint8Array(await res.arrayBuffer())
    const text = new TextDecoder().decode(buf)
    expect(text).toContain("postmarkapp.com")
    expect(text).toContain("Postmark")
  })
})

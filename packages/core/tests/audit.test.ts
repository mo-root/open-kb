import { describe, it, expect } from "vitest"
import {
  buildAuditPacket,
  scoreAuditPacket,
  wilson,
  cohenKappa,
  AUDIT_ERROR_KINDS,
  type AuditEntityRow,
  type AuditPacket,
  type AuditPacketRow,
} from "../src/audit.js"

/** A pool of relation-labelled rows big enough that a sample is a real choice. */
const pool = (competitors: number, substitutes: number): AuditEntityRow[] => {
  const rows: AuditEntityRow[] = []
  for (let i = 0; i < competitors; i++)
    rows.push({ name: `c${i}`, domain: `c${i}.com`, kind: "company", relation: "competitor", what: `does ${i}`, why: `rivals ${i}` })
  for (let i = 0; i < substitutes; i++)
    rows.push({ name: `s${i}`, domain: `s${i}.com`, kind: "company", relation: "substitute", what: `covers ${i}`, why: `replaces ${i}` })
  return rows
}

const build = (entities: AuditEntityRow[], over: Partial<Parameters<typeof buildAuditPacket>[1]> = {}) =>
  buildAuditPacket({ entities }, { runFile: "runs/fake.json", runId: "fake", n: 30, relations: ["competitor", "substitute"], ...over })

/** Fill a built packet into a scoreable one: every verdict right, every row reviewed. */
const fill = (packet: AuditPacket, over: Partial<AuditPacket> = {}, row?: (r: AuditPacketRow, i: number) => AuditPacketRow): AuditPacket => ({
  ...packet,
  secondReview: "both",
  ...over,
  rows: packet.rows.map((r, i) => {
    const filled = { ...r, verdict: "right" as const, reviewer: "auditor-1" }
    return row ? row(filled, i) : filled
  }),
})

describe("buildAuditPacket sampling", () => {
  it("is deterministic: same run id, same N, same sample — a re-audit must hit the same entities to be comparable", () => {
    const entities = pool(40, 20)
    const a = build(entities)
    const b = build(entities)
    expect(a).toEqual(b)
  })

  it("ignores the run file's row order — identity seeds the rank, not position", () => {
    const entities = pool(40, 20)
    const shuffled = [...entities].reverse()
    expect(build(shuffled).rows.map((r) => r.key)).toEqual(build(entities).rows.map((r) => r.key))
  })

  it("draws a different sample under a different run id", () => {
    const entities = pool(40, 20)
    const a = build(entities, { runId: "run-a" }).rows.map((r) => r.key)
    const b = build(entities, { runId: "run-b" }).rows.map((r) => r.key)
    expect(a).not.toEqual(b)
  })

  it("stratifies proportionally over the requested relations", () => {
    const packet = build(pool(40, 20), { n: 30 })
    const byRelation = new Map<string, number>()
    for (const r of packet.rows) {
      const relation = r.entity.relation ?? "?"
      byRelation.set(relation, (byRelation.get(relation) ?? 0) + 1)
    }
    expect(byRelation.get("competitor")).toBe(20)
    expect(byRelation.get("substitute")).toBe(10)
    expect(packet.rows).toHaveLength(30)
  })

  it("samples only the requested relations", () => {
    const entities = [...pool(10, 10), { name: "noise", domain: "noise.com", kind: "company", relation: "unknown" }]
    const packet = build(entities, { relations: ["competitor"] })
    expect(packet.rows.length).toBeGreaterThan(0)
    expect(packet.rows.every((r) => r.entity.relation === "competitor")).toBe(true)
  })

  it("takes the whole pool when N exceeds it, and says how many it got", () => {
    const packet = build(pool(4, 2), { n: 30 })
    expect(packet.rows).toHaveLength(6)
    expect(packet.sampleSize).toBe(30)
  })

  it("nests: the N=10 sample is a subset of the N=20 sample — growing N (the κ advice) never discards filled verdicts", () => {
    const entities = pool(40, 20)
    const small = new Set(build(entities, { n: 10 }).rows.map((r) => r.key))
    const large = new Set(build(entities, { n: 20 }).rows.map((r) => r.key))
    for (const key of small) expect(large.has(key)).toBe(true)
  })

  it("folds duplicate keys — two subdomains of one host are one candidate, first row speaks", () => {
    const twice: AuditEntityRow[] = [
      { name: "Docs", domain: "docs.dup.com", kind: "company", relation: "competitor", what: "first" },
      { name: "Www", domain: "www.dup.com", kind: "company", relation: "competitor", what: "second" },
    ]
    const packet = build(twice, { n: 30 })
    expect(packet.rows).toHaveLength(1)
    expect(packet.rows[0]!.key).toBe("dup.com")
    expect(packet.rows[0]!.entity.what).toBe("first")
  })

  it("mints rows with empty verdict fields and an undeclared secondReview — the packet is what auditors fill", () => {
    const packet = build(pool(3, 1))
    for (const r of packet.rows) {
      expect(r.verdict).toBe("")
      expect(r.errorKind).toBe("")
      expect(r.evidence).toBe("")
      expect(r.reviewer).toBe("")
    }
    expect(packet.secondReview).toBe("")
    expect(packet.runId).toBe("fake")
  })

  it("carries the row's receipts when the run holds them — spans, tier, descSpans ride into the packet", () => {
    const entities: AuditEntityRow[] = [
      {
        name: "Rich",
        domain: "rich.com",
        kind: "company",
        relation: "competitor",
        what: "w",
        why: "y",
        tier: "own-page",
        descSpans: { verified: 2, claimed: 3 },
        spans: ["a verbatim quote"],
      },
    ]
    const row = build(entities).rows[0]!
    expect(row.entity.tier).toBe("own-page")
    expect(row.entity.descSpans).toEqual({ verified: 2, claimed: 3 })
    expect(row.entity.spans).toEqual(["a verbatim quote"])
  })
})

describe("wilson", () => {
  it("matches the known 1-of-30 interval — the CI the kernel audit was entitled to quote", () => {
    const w = wilson(1, 30)
    expect(w.rate.value).toBeCloseTo(0.0333, 4)
    expect(w.low).toBeCloseTo(0.005908, 5)
    expect(w.high).toBeCloseTo(0.166708, 5)
  })

  it("matches the known 0-of-30 interval, clamped — a clean sample still cannot claim less than zero", () => {
    const w = wilson(0, 30)
    expect(w.low).toBe(0)
    expect(w.high).toBeCloseTo(0.113517, 5)
  })

  it("matches the known 30-of-30 and 15-of-30 intervals", () => {
    const all = wilson(30, 30)
    expect(all.low).toBeCloseTo(0.886483, 5)
    expect(all.high).toBe(1)
    const half = wilson(15, 30)
    expect(half.low).toBeCloseTo(0.331539, 5)
    expect(half.high).toBeCloseTo(0.668461, 5)
  })

  it("returns null bounds on an empty sample — never NaN", () => {
    const w = wilson(0, 0)
    expect(w.rate.value).toBeNull()
    expect(w.low).toBeNull()
    expect(w.high).toBeNull()
  })
})

describe("cohenKappa", () => {
  it("is 1 on perfect agreement", () => {
    expect(
      cohenKappa([
        { a: "right", b: "right" },
        { a: "wrong", b: "wrong" },
      ]),
    ).toBe(1)
  })

  it("is 0 at chance-level agreement", () => {
    expect(
      cohenKappa([
        { a: "right", b: "right" },
        { a: "right", b: "wrong" },
        { a: "wrong", b: "right" },
        { a: "wrong", b: "wrong" },
      ]),
    ).toBe(0)
  })

  it("matches the known value for the 10/2/4/4 agreement table", () => {
    const pairs = [
      ...Array.from({ length: 10 }, () => ({ a: "right", b: "right" }) as const),
      ...Array.from({ length: 2 }, () => ({ a: "right", b: "wrong" }) as const),
      ...Array.from({ length: 4 }, () => ({ a: "wrong", b: "right" }) as const),
      ...Array.from({ length: 4 }, () => ({ a: "wrong", b: "wrong" }) as const),
    ]
    expect(cohenKappa(pairs)).toBeCloseTo(0.347826, 5)
  })

  it("is null when agreement is arithmetic-free — no pairs, or two constant raters", () => {
    expect(cohenKappa([])).toBeNull()
    expect(
      cohenKappa([
        { a: "right", b: "right" },
        { a: "right", b: "right" },
      ]),
    ).toBeNull()
  })
})

describe("scoreAuditPacket refusals", () => {
  const packet = () => build(pool(6, 3), { n: 6 })

  it("refuses an unfilled verdict by name", () => {
    const p = fill(packet(), {}, (r, i) => (i === 2 ? { ...r, verdict: "" } : r))
    const out = scoreAuditPacket(p)
    expect(out.scored).toBe(false)
    if (!out.scored) expect(out.refusals.some((line) => line.includes(p.rows[2]!.key) && line.includes("verdict"))).toBe(true)
  })

  it("refuses a verdict with no reviewer — a RIGHT one too; a reviewer only on wrongs is the asymmetry this instrument removes", () => {
    const p = fill(packet(), {}, (r, i) => (i === 0 ? { ...r, verdict: "wrong", errorKind: "wrong-relation", evidence: "url" } : { ...r, reviewer: "" }))
    const out = scoreAuditPacket(p)
    expect(out.scored).toBe(false)
    if (!out.scored) expect(out.refusals.length).toBe(p.rows.length - 1)
  })

  it("refuses a wrong verdict that names no errorKind or carries no evidence", () => {
    const p = fill(packet(), {}, (r, i) => (i === 1 ? { ...r, verdict: "wrong" } : r))
    const out = scoreAuditPacket(p)
    expect(out.scored).toBe(false)
    if (!out.scored) {
      expect(out.refusals.some((line) => line.includes("errorKind"))).toBe(true)
      expect(out.refusals.some((line) => line.includes("evidence"))).toBe(true)
    }
  })

  it("refuses a packet that never declared its secondReview process", () => {
    const p = fill(packet(), { secondReview: "" })
    const out = scoreAuditPacket(p)
    expect(out.scored).toBe(false)
    if (!out.scored) expect(out.refusals.some((line) => line.includes("secondReview"))).toBe(true)
  })

  it("accumulates every refusal instead of stopping at the first", () => {
    const p = fill(packet(), { secondReview: "" }, (r, i) => (i === 0 ? { ...r, verdict: "" } : r))
    const out = scoreAuditPacket(p)
    expect(out.scored).toBe(false)
    if (!out.scored) expect(out.refusals.length).toBeGreaterThanOrEqual(2)
  })
})

describe("scoreAuditPacket scoring", () => {
  /** 30 rows, one wrong — the shape of the 2026-08-05 kernel audit. */
  const oneOfThirty = (secondReview: AuditPacket["secondReview"]) =>
    fill(build(pool(40, 20), { n: 30 }), { secondReview }, (r, i) =>
      i === 0 ? { ...r, verdict: "wrong", errorKind: "invented-capability", evidence: "the site nowhere offers it" } : r,
    )

  it("prints the CI beside the rate, always — 1 of 30 is 3.3% wearing 0.6%–16.7%", () => {
    const out = scoreAuditPacket(oneOfThirty("both"))
    expect(out.scored).toBe(true)
    if (out.scored) {
      expect(out.wrongRate).toEqual({ num: 1, den: 30, value: 1 / 30 })
      const rateLine = out.sentences.find((s) => s.includes("3.3%"))
      expect(rateLine).toContain("95% CI 0.6%-16.7%")
      expect(rateLine).toContain("Wilson")
    }
  })

  it("splits wrongs per errorKind", () => {
    const out = scoreAuditPacket(oneOfThirty("both"))
    if (out.scored) {
      expect(out.byErrorKind).toEqual({ "invented-capability": 1 })
      expect(out.sentences.some((s) => s.includes("invented-capability: 1"))).toBe(true)
    }
  })

  it("wrong-only second review prints the lower-bound caveat — the correction could only lower the rate", () => {
    const out = scoreAuditPacket(oneOfThirty("wrong-only"))
    if (out.scored) expect(out.sentences.some((s) => s.includes("rate is a lower bound: the re-review could only lower it"))).toBe(true)
  })

  it("none and both print their own process line, not the lower-bound caveat", () => {
    for (const mode of ["none", "both"] as const) {
      const out = scoreAuditPacket(oneOfThirty(mode))
      if (out.scored) {
        expect(out.sentences.some((s) => s.includes("lower bound"))).toBe(false)
        expect(out.sentences.some((s) => s.includes(`second review: ${mode}`))).toBe(true)
      }
    }
  })

  it("says κ is unavailable when no row carries a gold verdict", () => {
    const out = scoreAuditPacket(oneOfThirty("both"))
    if (out.scored) {
      expect(out.kappa).toBeNull()
      expect(out.sentences.some((s) => s.includes("no gold set — κ unavailable"))).toBe(true)
    }
  })

  it("computes κ against gold when present, and under 50 gold rows says the sample is too small for it to mean much", () => {
    const p = fill(build(pool(40, 20), { n: 30 }), { secondReview: "both" }, (r, i) => ({
      ...r,
      // Verdicts split so neither rater is constant; disagree on rows 0 and 1.
      verdict: i < 4 ? "wrong" : "right",
      goldVerdict: i >= 2 && i < 6 ? "wrong" : "right",
      ...(i < 4 ? { errorKind: "wrong-relation", evidence: "url" } : {}),
    }))
    const out = scoreAuditPacket(p)
    expect(out.scored).toBe(true)
    if (out.scored) {
      expect(out.kappa?.goldN).toBe(30)
      // po = 26/30; pe = (4/30)(4/30) + (26/30)(26/30); κ = (po − pe) / (1 − pe)
      const pe = (4 / 30) * (4 / 30) + (26 / 30) * (26 / 30)
      expect(out.kappa?.value).toBeCloseTo((26 / 30 - pe) / (1 - pe), 6)
      expect(out.sentences.some((s) => s.includes("sample too small for κ to mean much; grow N first"))).toBe(true)
    }
  })

  it("drops the too-small warning at 50 gold rows and up", () => {
    const p = fill(build(pool(80, 40), { n: 60 }), { secondReview: "both" }, (r, i) => ({
      ...r,
      verdict: i < 6 ? "wrong" : "right",
      goldVerdict: i >= 3 && i < 9 ? "wrong" : "right",
      ...(i < 6 ? { errorKind: "wrong-relation", evidence: "url" } : {}),
    }))
    const out = scoreAuditPacket(p)
    if (out.scored) {
      expect(out.kappa?.goldN).toBe(60)
      expect(out.sentences.some((s) => s.includes("grow N first"))).toBe(false)
      expect(out.sentences.some((s) => s.includes("κ vs gold"))).toBe(true)
    }
  })

  it("ships the three named error kinds the audit method defined", () => {
    expect(AUDIT_ERROR_KINDS).toEqual(["aggregator-as-competitor", "wrong-relation", "invented-capability"])
  })
})

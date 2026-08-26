import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NextRequest } from "next/server"
import { middleware } from "./middleware"

/**
 * `middleware.ts` had zero test coverage anywhere, AND was unreachable by the
 * suite even if a test existed: `vitest.config.ts`'s `include` lists
 * `packages/web/{app,lib,components}/**`, but this file sits directly under
 * `packages/web/`, one level above every listed directory. A `middleware.test.ts`
 * placed here would have joined `docs/overnight-backlog.md`'s own class of bug —
 * collected by nothing, run by nothing, green by omission — which is exactly
 * what `scripts/check-test-collection.mjs` exists to catch. Confirmed by running
 * it before adding the include line below: it named this exact gap.
 *
 * This is the one password standing between an unauthenticated stranger and the
 * spend ceiling in `/api/map` (the file's own doc comment). Untested, its three
 * real failure modes were unverified: a deployment that forgot to set the
 * password is silently OPEN rather than denying by default; a wrong password
 * could silently pass if `same()` short-circuited on the wrong side; and a
 * non-base64 `Authorization` header could throw out of `atob` uncaught instead
 * of being refused.
 */

const ROUTE = "https://kb.test/kb/resend.com"

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(ROUTE, { headers })
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
}

afterEach(() => {
  delete process.env.KB_USER
  delete process.env.KB_PASSWORD
})

describe("unset credentials mean open, on purpose", () => {
  it("passes every request through when KB_USER or KB_PASSWORD is missing", () => {
    delete process.env.KB_USER
    delete process.env.KB_PASSWORD
    expect(middleware(req()).status).toBe(200)

    process.env.KB_USER = "owner"
    delete process.env.KB_PASSWORD
    expect(middleware(req()).status).toBe(200)

    delete process.env.KB_USER
    process.env.KB_PASSWORD = "secret"
    expect(middleware(req()).status).toBe(200)
  })
})

describe("both set: the door is locked", () => {
  beforeEach(() => {
    process.env.KB_USER = "owner"
    process.env.KB_PASSWORD = "secret"
  })

  it("refuses a request with no Authorization header at all", () => {
    const res = middleware(req())
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain('realm="open-kb"')
  })

  it("refuses the right user with the wrong password", () => {
    expect(middleware(req({ authorization: basic("owner", "nope") })).status).toBe(401)
  })

  it("refuses the wrong user with the right password", () => {
    expect(middleware(req({ authorization: basic("nobody", "secret") })).status).toBe(401)
  })

  it("refuses a password that is a prefix of the real one (no short-circuit leak)", () => {
    // `same()` compares full length first; a naive substring or startsWith
    // check would let "sec" through against "secret".
    expect(middleware(req({ authorization: basic("owner", "sec") })).status).toBe(401)
  })

  it("refuses a non-Basic scheme", () => {
    expect(middleware(req({ authorization: "Bearer whatever" })).status).toBe(401)
  })

  it("refuses a header that decodes with no colon", () => {
    const noColon = `Basic ${Buffer.from("ownersecret").toString("base64")}`
    expect(middleware(req({ authorization: noColon })).status).toBe(401)
  })

  it("refuses a header that is not valid base64, without throwing", () => {
    expect(() => middleware(req({ authorization: "Basic !!!not-base64!!!" }))).not.toThrow()
    expect(middleware(req({ authorization: "Basic !!!not-base64!!!" })).status).toBe(401)
  })

  it("passes the exact right credentials through", () => {
    const res = middleware(req({ authorization: basic("owner", "secret") }))
    expect(res.status).toBe(200)
  })

  it("allows an empty-string password segment only if that is what was set", () => {
    // A user with no colon-separated password at all (`decoded.indexOf(":")`
    // at position 0) must not pass: `i > 0` is false for `i === 0`.
    const emptyUser = `Basic ${Buffer.from(":secret").toString("base64")}`
    expect(middleware(req({ authorization: emptyUser })).status).toBe(401)
  })
})

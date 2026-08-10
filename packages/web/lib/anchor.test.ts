import { describe, it, expect } from "vitest"
import { normalizeDomain } from "@/lib/anchor"

/**
 * The door on `POST /api/map`.
 *
 * A domain that survives this becomes an anchor, and the sweep immediately
 * fetches `https://<anchor>/llms.txt`, `https://docs.<anchor>/llms.txt` and
 * `https://<anchor>/` — three requests from the deployment's own network, all
 * three before the first billed call, all three condensed into a run whose text
 * is readable afterwards at `GET /api/kb`. So "" from this function is not a
 * formatting opinion. It is the difference between a probe costing an attacker
 * nothing and a probe not happening.
 *
 * Every host in the first test was measured passing the validator this replaced,
 * whose entire rule was `^[a-z0-9-]+(\.[a-z0-9-]+)+$`.
 */
describe("normalizeDomain", () => {
  it("refuses the hosts that point back into the deployment", () => {
    expect(normalizeDomain("127.0.0.1")).toBe("")
    expect(normalizeDomain("10.0.0.5")).toBe("")
    expect(normalizeDomain("169.254.169.254")).toBe("")
    expect(normalizeDomain("metadata.google.internal")).toBe("")
    expect(normalizeDomain("internal-jenkins.corp")).toBe("")
  })

  it("refuses them however they are dressed up — a url, a path, a case, a notation", () => {
    // The normalisation runs BEFORE the check, so every spelling that reduces
    // to a private host has to reduce before it is judged, not after.
    expect(normalizeDomain("http://169.254.169.254/latest/meta-data/iam/security-credentials/")).toBe("")
    expect(normalizeDomain("HTTPS://127.0.0.1/")).toBe("")
    expect(normalizeDomain("https://www.10.0.0.5/x?y=1#z")).toBe("")
    expect(normalizeDomain("0177.0.0.1")).toBe("") // octal loopback
    expect(normalizeDomain("127.1")).toBe("") // short-form loopback
    expect(normalizeDomain("0x7f.0.0.1")).toBe("") // hex loopback
    expect(normalizeDomain("192.168.1.1")).toBe("")
    expect(normalizeDomain("172.16.0.1")).toBe("")
    expect(normalizeDomain("100.64.0.1")).toBe("")
  })

  it("refuses a single-label host, which is what `localhost` is", () => {
    expect(normalizeDomain("localhost")).toBe("")
    expect(normalizeDomain("http://localhost:3210/")).toBe("")
    expect(normalizeDomain("jenkins")).toBe("")
  })

  it("refuses the shapes that were never hostnames", () => {
    expect(normalizeDomain(undefined)).toBe("")
    expect(normalizeDomain("")).toBe("")
    expect(normalizeDomain("   ")).toBe("")
    expect(normalizeDomain("not a domain")).toBe("")
    expect(normalizeDomain("file:///etc/passwd")).toBe("")
    // Userinfo and ports are refused by SHAPE, not stripped: reading a host out
    // of the wrong side of an `@` is the oldest url-parsing bug there is, and
    // the safest way not to make it is never to split on one.
    expect(normalizeDomain("resend.com@127.0.0.1")).toBe("")
    expect(normalizeDomain("127.0.0.1:8080")).toBe("")
  })

  it("passes an ordinary company domain through, which is the whole point of the endpoint", () => {
    expect(normalizeDomain("resend.com")).toBe("resend.com")
    expect(normalizeDomain("https://Resend.com/pricing")).toBe("resend.com")
    expect(normalizeDomain("www.brightdata.com")).toBe("brightdata.com")
    expect(normalizeDomain("  https://WWW.Apify.com/store?x=1#y  ")).toBe("apify.com")
    expect(normalizeDomain("docs.apify.com")).toBe("docs.apify.com")
    expect(normalizeDomain("example.co.uk")).toBe("example.co.uk")
    expect(normalizeDomain("some-startup.io")).toBe("some-startup.io")
  })

  it("cannot catch a public name that resolves inward, and does not pretend to", () => {
    // `127.0.0.1.nip.io` is a public registration whose A record is loopback.
    // It passes here — deliberately, because nothing about the STRING is
    // private — and is refused at the socket by `publicOnlyFetch` in
    // @open-kb/providers, which resolves the name and re-checks every redirect
    // hop. If this line ever starts returning "" because someone added a
    // hard-coded name to a spelling check, the real defence has been made to
    // look redundant and will be the next thing deleted.
    expect(normalizeDomain("127.0.0.1.nip.io")).toBe("127.0.0.1.nip.io")
  })
})

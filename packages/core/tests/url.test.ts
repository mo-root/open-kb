import { describe, it, expect } from "vitest"
import { canonicalUrl, registrableHost } from "../src/url.js"

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

describe("registrableHost", () => {
  it("strips www and lowercases", () => {
    expect(registrableHost("WWW.Apify.com")).toBe("apify.com")
  })
  it("folds subdomains to the registrable domain", () => {
    expect(registrableHost("docs.apify.com")).toBe("apify.com")
    expect(registrableHost("deep.docs.apify.com")).toBe("apify.com")
  })
  it("keeps two-part public suffixes whole", () => {
    expect(registrableHost("shop.example.co.uk")).toBe("example.co.uk")
    expect(registrableHost("example.com.au")).toBe("example.com.au")
  })
  it("passes through bare and unparseable input", () => {
    expect(registrableHost("localhost")).toBe("localhost")
    expect(registrableHost("")).toBe("")
  })
})

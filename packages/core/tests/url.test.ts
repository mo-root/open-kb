import { describe, it, expect } from "vitest"
import { canonicalUrl, registrableHost, isReservedHost, isIpLiteral } from "../src/url.js"

describe("canonicalUrl", () => {
  it("normalises host case, www, trailing slash and fragment", () => {
    expect(canonicalUrl("HTTPS://WWW.Stripe.com/radar/")).toBe("https://stripe.com/radar")
    expect(canonicalUrl("https://stripe.com/radar#pricing")).toBe("https://stripe.com/radar")
  })

  it("drops tracking params but keeps meaningful ones", () => {
    expect(canonicalUrl("https://a.com/x?utm_source=g&id=7")).toBe("https://a.com/x?id=7")
  })

  it("drops every non-utm_ tracking key TRACKING names, individually", () => {
    // TRACKING (url.ts:1) is `/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$)/i` — five
    // exact-match alternatives beside the `utm_` prefix, none of them exercised on their own
    // (the one existing test above only drives `utm_source`). Each dropped here to pin that
    // the whole list, not just the `utm_` branch, actually fires.
    for (const key of ["fbclid", "gclid", "mc_cid", "mc_eid"]) {
      expect(canonicalUrl(`https://a.com/x?${key}=1&id=7`), key).toBe("https://a.com/x?id=7")
    }
  })

  it("drops the bare keys 'ref' and 'source', not only their utm_-prefixed spellings", () => {
    // `ref$` and `source$` are anchored on the whole key, not `utm_ref$`/`utm_source$` — so a
    // page that tags its own affiliate/referral link with the bare param name (a real, common
    // spelling this repo does not control) loses it here exactly as if it had been `utm_ref` or
    // `utm_source`. Worth pinning on its own: `ref$|source$` reads at a glance like a typo for
    // the `utm_` forms, and anchoring it that way instead would silently start keeping the two
    // most common non-utm tracking spellings — the opposite of what a URL-identity function is
    // for. Measured with the regex directly: `ref`/`source` test true, `referrer`/`sourceid` test
    // false, so the anchor is doing real, narrow work, not swallowing every param that mentions
    // either word.
    expect(canonicalUrl("https://a.com/x?ref=abc&id=7")).toBe("https://a.com/x?id=7")
    expect(canonicalUrl("https://a.com/x?source=abc&id=7")).toBe("https://a.com/x?id=7")
    // Neither is a prefix match: a longer key that merely contains the word survives.
    expect(canonicalUrl("https://a.com/x?referrer=abc&id=7")).toBe("https://a.com/x?id=7&referrer=abc")
    expect(canonicalUrl("https://a.com/x?sourceid=abc&id=7")).toBe("https://a.com/x?id=7&sourceid=abc")
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
  it("strips a trailing FQDN dot", () => {
    expect(registrableHost("apify.com.")).toBe("apify.com")
    expect(registrableHost("a.b.example.co.uk.")).toBe("example.co.uk")
  })
  it("passes IPv4 addresses through unchanged", () => {
    expect(registrableHost("192.168.1.1")).toBe("192.168.1.1")
  })
})

/**
 * The SSRF predicate, half of a two-layer defence.
 *
 * Every host in the first block below was measured passing the shipped
 * validator, whose whole rule was `^[a-z0-9-]+(\.[a-z0-9-]+)+$`. Three of them
 * reach a cloud instance's credentials.
 */
describe("isReservedHost", () => {
  it("refuses the loopback, private and link-local literals the old shape check waved through", () => {
    // The six from the audit, in the notation the audit used.
    expect(isReservedHost("127.0.0.1")).toBe(true)
    expect(isReservedHost("10.0.0.5")).toBe(true)
    expect(isReservedHost("169.254.169.254")).toBe(true) // AWS/GCP instance metadata
    expect(isReservedHost("metadata.google.internal")).toBe(true)
    expect(isReservedHost("internal-jenkins.corp")).toBe(true)
    expect(isReservedHost("localhost")).toBe(true)
  })

  it("covers every RFC1918, loopback, link-local, CGNAT and unique-local range", () => {
    for (const host of [
      "10.0.0.1",
      "10.255.255.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.1",
      "192.168.255.254",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.0.1",
      "169.254.169.254",
      "100.64.0.1", // carrier-grade NAT
      "100.127.255.254",
      "0.0.0.0", // every local interface at once
      "255.255.255.255",
      "224.0.0.1", // multicast
      "fc00::1", // unique-local
      "fd12:3456:789a::1",
      "fe80::1", // link-local
      "::1", // loopback
      "::",
    ]) {
      expect(isReservedHost(host), host).toBe(true)
    }
  })

  it("covers the IETF-reserved ranges that are neither RFC1918 nor CGNAT — documentation and relay blocks a probe would otherwise slip through untested", () => {
    for (const host of [
      "192.0.0.1", // 192.0.0.0/24 IETF protocol assignments
      "192.0.2.1", // 192.0.2.0/24 TEST-NET-1
      "192.88.99.1", // 192.88.99.0/24 6to4 relay anycast
      "198.18.0.1", // 198.18.0.0/15 benchmarking
      "198.19.255.254", // top of the same /15
      "198.51.100.1", // 198.51.100.0/24 TEST-NET-2
      "203.0.113.1", // 203.0.113.0/24 TEST-NET-3
    ]) {
      expect(isReservedHost(host), host).toBe(true)
    }
  })

  it("reads an IPv4 literal in every notation a resolver accepts, not just the dotted quad", () => {
    // All of these are 127.0.0.1 to `new URL()` and therefore to `fetch`.
    expect(isReservedHost("0177.0.0.1")).toBe(true) // octal first byte
    expect(isReservedHost("0x7f.0.0.1")).toBe(true) // hex first byte
    expect(isReservedHost("0x7f000001")).toBe(true) // one hex number
    expect(isReservedHost("2130706433")).toBe(true) // one decimal number
    expect(isReservedHost("017700000001")).toBe(true) // one octal number
    expect(isReservedHost("127.1")).toBe(true) // last part absorbs the rest
    expect(isReservedHost("127.0.1")).toBe(true)
    expect(isReservedHost("0xA9FEA9FE")).toBe(true) // 169.254.169.254, hex
    expect(isReservedHost("2852039166")).toBe(true) // 169.254.169.254, decimal
  })

  it("refuses IPv6, including the four ways an IPv6 address can carry a private IPv4 one", () => {
    expect(isReservedHost("[::1]")).toBe(true) // bracketed, the way URL.hostname reports it
    expect(isReservedHost("fe80::1%en0")).toBe(true) // a zone id belongs to the socket, not the address
    expect(isReservedHost("::ffff:127.0.0.1")).toBe(true) // v4-mapped, dotted
    expect(isReservedHost("::ffff:7f00:1")).toBe(true) // v4-mapped, hex — the same address
    expect(isReservedHost("::ffff:169.254.169.254")).toBe(true)
    expect(isReservedHost("::127.0.0.1")).toBe(true) // v4-compatible, deprecated but routed
    expect(isReservedHost("64:ff9b::127.0.0.1")).toBe(true) // NAT64
    expect(isReservedHost("2002:7f00:1::")).toBe(true) // 6to4 wrapping 127.0.0.1
    expect(isReservedHost("0:0:0:0:0:0:0:1")).toBe(true) // uncompressed loopback
    expect(isReservedHost("fec0::1")).toBe(true) // site-local
    expect(isReservedHost("ff02::1")).toBe(true) // multicast
  })

  it("refuses a single-label host and the suffixes that name a network rather than the internet", () => {
    expect(isReservedHost("intranet")).toBe(true)
    expect(isReservedHost("jenkins")).toBe(true) // a resolver completes this with a search domain
    expect(isReservedHost("")).toBe(true)
    for (const suffix of ["local", "localhost", "localdomain", "internal", "intranet", "corp", "lan", "home", "home.arpa"]) {
      expect(isReservedHost(`box.${suffix}`), suffix).toBe(true)
    }
  })

  it("normalises the spellings that would otherwise slip past: case, brackets, the FQDN dot", () => {
    expect(isReservedHost("LOCALHOST")).toBe(true)
    expect(isReservedHost("127.0.0.1.")).toBe(true)
    expect(isReservedHost("METADATA.GOOGLE.INTERNAL.")).toBe(true)
    expect(isReservedHost("  10.0.0.5  ")).toBe(true)
  })

  it("lets an ordinary public domain through — the honest case, which is most of them", () => {
    for (const host of [
      "resend.com",
      "www.resend.com",
      "docs.apify.com",
      "example.com",
      "example.co.uk",
      "brightdata.com",
      "sub.domain.with-hyphens.io",
      "8.8.8.8", // a public IP literal is still public
      "1.1.1.1",
      "93.184.216.34",
      "172.15.0.1", // one below the private block
      "172.32.0.1", // one above it
      "100.63.255.255", // one below CGNAT
      "100.128.0.0", // one above it
      "169.253.0.1", // one below link-local
      "11.0.0.1",
      "126.0.0.1",
      "128.0.0.1",
      "2606:4700::1111", // public IPv6
    ]) {
      expect(isReservedHost(host), host).toBe(false)
    }
  })

  it("does NOT catch a public name whose DNS answer is private — which is why there is a second layer", () => {
    // Stated as a test rather than only as a comment, because this is the exact
    // shape of the hole the fetch-seam guard exists to close, and a future
    // reader who "fixes" this line has moved the defence somewhere it cannot
    // work. `127.0.0.1.nip.io` is a real public name with an A record of
    // 127.0.0.1; nothing about how it is SPELLED is reserved.
    expect(isReservedHost("127.0.0.1.nip.io")).toBe(false)
    expect(isReservedHost("attacker-owned.com")).toBe(false)
  })
})

describe("isIpLiteral", () => {
  it("knows an address from a name, in every notation", () => {
    for (const host of ["127.0.0.1", "8.8.8.8", "0177.0.0.1", "0x7f000001", "2130706433", "127.1", "::1", "fe80::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isIpLiteral(host), host).toBe(true)
    }
    for (const host of ["resend.com", "127.0.0.1.nip.io", "localhost", "8.8.8.8.in-addr.arpa", ""]) {
      expect(isIpLiteral(host), host).toBe(false)
    }
  })

  it("refuses a string shaped like IPv6 but not one — every fixture above is well-formed, so ipv6Groups' own malformed-input guards had never run", () => {
    // Measured: `vitest --coverage` over packages/core/src put url.ts's ipv6Groups
    // at 3 uncovered branches (lines 142, 146, 151) — every host this file or
    // url.test.ts hands it is either a real address or has no colon at all, so
    // none of its rejection paths, only its acceptance path, had ever run.
    // `::` splits a string into two halves; with it present, the head+rest
    // group count can still run over 8 (line 142).
    expect(isIpLiteral("1:2:3:4:5::6:7:8:9")).toBe(false)
    // A group has to be 1-4 hex digits; "gggg" is the right shape and the
    // wrong alphabet, ahead of "::" (line 146) and after it (line 151).
    expect(isIpLiteral("gggg::1")).toBe(false)
    expect(isIpLiteral("1::gggg")).toBe(false)
  })

  it("rejects ipv4Value's own malformed-address guards, none of which the notation fixtures above ever hit", () => {
    // Measured: the same coverage run put ipv4Value at 4 more uncovered
    // branches (lines 104, 108, 113-114) — every "0x..." fixture above has
    // digits after the prefix, every dotted quad is in range, so the
    // rejection side of each guard had never run.
    //
    // "0x" alone is the right shape for the hex branch (`/^0x[0-9a-f]*$/`
    // allows zero digits) and takes its own `p.length === 2 ? 0` arm rather
    // than falling through to parseInt (line 104).
    expect(isIpLiteral("0x.0.0.1")).toBe(true)
    // A hex run wide enough to overflow Number.isSafeInteger fails the guard
    // right after parsing, before the range checks below it ever see it
    // (line 108).
    expect(isIpLiteral("0xfffffffffffffffffff.0.0.1")).toBe(false)
    // A non-last part over 255 is caught by `nums.some` before the last
    // part's own ceiling is even computed (line 113).
    expect(isIpLiteral("300.0.0.1")).toBe(false)
    // A well-formed last part that is too big for the slots the earlier
    // parts left it — three parts consume 24 bits, leaving the last part an
    // 8-bit ceiling of 256 — is a distinct guard from the one above (line 114).
    expect(isIpLiteral("1.2.3.99999")).toBe(false)
  })

  it("rejects ipv6Groups' remaining guards — a bad embedded IPv4 tail, a second '::', and an unelided address with the wrong group count", () => {
    // Same run, three more uncovered branches in ipv6Groups (lines 131, 138,
    // 141) that the malformed-IPv6 fixtures above do not reach: those are all
    // pure-hex shapes, none carries a dotted IPv4 tail or omits '::' entirely.
    //
    // `::ffff:a.b.c.d` folds a dotted tail into the address; a tail that
    // ipv4Value itself refuses (four dotted parts, each over 255) has to be
    // refused here too rather than silently dropped (line 131).
    expect(isIpLiteral("::ffff:999.999.999.999")).toBe(false)
    // '::' may appear at most once — a second one makes `split("::")` return
    // more than two halves (line 138).
    expect(isIpLiteral("1::2::3")).toBe(false)
    // With no '::' to elide anything, the address has to spell all 8 groups;
    // seven is the right notation with the wrong count (line 141) — eight is
    // the same notation accepted, confirming the guard is on count, not shape.
    expect(isIpLiteral("1:2:3:4:5:6:7")).toBe(false)
    expect(isIpLiteral("1:2:3:4:5:6:7:8")).toBe(true)
  })
})

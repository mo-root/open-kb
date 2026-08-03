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

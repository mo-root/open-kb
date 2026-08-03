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

  it("preserves markdown with generics like Array<string> and arrows", () => {
    // Regression: old regex corrupted code samples with < and > operators.
    // This markdown should survive byte-for-byte.
    const markdown = "# TypeScript\nUse `Array<string>` for typed arrays.\n" + "The flow is A -> B -> C.\n".repeat(20)
    const r = sniff({ url: "https://example.com/docs.md", httpStatus: 200, body: markdown })
    expect(r.status).toBe("found")
    expect(r.text).toBe(markdown) // preserved as-is, not extracted
    expect(r.text).toContain("Array<string>")
    expect(r.text).toContain("A -> B")
  })

  it("preserves code with comparison operators (no spaces) and sufficient length", () => {
    // Regression: spaces around operators masked the old bug.
    // Without spaces: if(a<b) truly triggers the old greedy regex.
    // Old pattern /<[a-z][\s\S]*>/ would match from <b to the next >, corrupting the code.
    const code = "function compare(a,b){" + "if(a<b){return x>y}\n".repeat(15) + "}"
    const r = sniff({ url: "https://example.com/code.txt", httpStatus: 200, body: code })
    expect(r.status).toBe("found")
    expect(r.text).toContain("if(a<b)")
    expect(r.text).toContain("return x>y")
  })

  it("marks thin-render when extracted text is under 200 chars despite large raw body", () => {
    // Distinguish "measures extracted text" from "measures raw bytes".
    // Large HTML body with minimal extractable content.
    const largeMarkup = "<html><body>" + "<div class='unused'>x</div>".repeat(40) + "<p>hi</p></body></html>"
    const r = sniff({ url: "https://example.com", httpStatus: 200, body: largeMarkup })
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("thin-render")
    expect(r.text).toContain("hi")
    expect(r.text.length).toBeLessThan(200)
  })

  it("extracts HTML fragment without contentType (no DOCTYPE, no <html> prefix)", () => {
    // REGRESSION FIX 2: HTML fragments without DOCTYPE often appear from WAF interstitials
    // and server-side-rendered components. Without contentType hint, old code skipped extraction
    // if body didn't start with <!doctype or <html>.
    const fragment = "<!-- generated --><div><h1>Real Company</h1><p>" + "we make things. ".repeat(30) + "</p></div>"
    const r = sniff({ url: "https://example.com", httpStatus: 200, body: fragment })
    expect(r.status).toBe("found")
    expect(r.text).toContain("Real Company")
    expect(r.text).not.toContain("<div>") // tags should be stripped
    expect(r.text).not.toContain("<!--") // comments should be gone
  })

  it("extracts HTML served with text/plain contentType", () => {
    // REGRESSION FIX 2: Genuine HTML served with wrong Content-Type (e.g., legacy servers,
    // WAF interstitials) should still be recognized and extracted as HTML.
    // Vocabulary check catches 2+ known tags regardless of contentType header.
    const html = "<html><head><title>x</title></head><body>" + "<h1>content</h1><p>more prose. ".repeat(20) + "</p></body></html>"
    const r = sniff({
      url: "https://example.com/page",
      httpStatus: 200,
      body: html,
      contentType: "text/plain; charset=utf-8",
    })
    expect(r.status).toBe("found")
    expect(r.text).toContain("content")
    expect(r.text).not.toContain("<html>") // tags should be stripped
    expect(r.text).not.toContain("<h1>")
  })

  it("preserves markdown with a single <code> inline span", () => {
    // Markdown files can have `<code>` or `<a>` HTML entities.
    // A single occurrence is not enough to trigger HTML extraction (threshold is 2).
    // This prevents false positives from occasional HTML entities in prose.
    const markdown = "# JavaScript\nUse the `<code>` HTML tag carefully.\n" + "Learn more at the library.\n".repeat(25)
    const r = sniff({ url: "https://example.com/guide.md", httpStatus: 200, body: markdown })
    expect(r.status).toBe("found")
    expect(r.text).toBe(markdown) // preserved as-is, not extracted
    expect(r.text).toContain("<code>") // the HTML entity should survive
  })

  it("does not corrupt TypeScript with multiple type parameters and generics", () => {
    // REGRESSION FIX 3: Critical defect with opening-tag matching.
    // Old pattern /<\/?[tag]\b[^>]*>/ matches `<a, b>` in `Pair<a, b>` because:
    //   - `<a` matches
    //   - `, b` matches `[^>]*`
    //   - `>` closes it
    // With 2+ "type parameters" matching as tags, extraction runs and mangles everything.
    // Closing-tag approach: `</a>` never appears, so type params don't trigger extraction.
    const typeScript =
      "type Pair<a, b> = [a, b]\n" +
      "type Other<a, b> = [a, b]\n" +
      "Array<string> types work fine. ".repeat(5) +
      "if(x<y) { return z>w }\n" +
      "The flow is A -> B. ".repeat(5)
    const r = sniff({ url: "https://example.com/types.ts", httpStatus: 200, body: typeScript })
    expect(r.status).toBe("found")
    expect(r.text).toBe(typeScript) // preserved byte-for-byte, not extracted
    expect(r.text).toContain("type Pair<a, b>")
    expect(r.text).toContain("type Other<a, b>")
    expect(r.text).toContain("Array<string>")
    expect(r.text).toContain("if(x<y)")
  })

  it("preserves short generic type parameters that never close", () => {
    // REGRESSION FIX 3: Closing-tag guarantee.
    // `type Foo<a> = a` contains `<a` but no `</a>`.
    // `type Bar<p> = p` contains `<p` but no `</p>`.
    // Opening-tag approach: both could match as tags (2+ matches threshold).
    // Closing-tag approach: no closing tags, so they don't trigger extraction.
    const types =
      "type Foo<a> = a\n" +
      "type Bar<p> = p\n" +
      "Both generic type parameters are safe. ".repeat(6)
    const r = sniff({ url: "https://example.com/types.ts", httpStatus: 200, body: types })
    expect(r.status).toBe("found")
    expect(r.text).toBe(types) // preserved as-is, not extracted
    expect(r.text).toContain("type Foo<a>")
    expect(r.text).toContain("type Bar<p>")
  })
})

describe("extractText", () => {
  it("strips script and style content, not just tags", () => {
    const html = "<html><style>.a{color:red}</style><script>var x=1</script><p>hello world</p></html>"
    expect(extractText(html)).toBe("hello world")
  })
})

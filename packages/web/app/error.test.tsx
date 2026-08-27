import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import PageError from "./error"

/**
 * `global-error.tsx` got the first test under `app/` (see its own file for
 * why `vitest.config.ts` had to widen to reach this directory at all); this
 * file's sibling boundary — the one that actually fires, since a page throw
 * hits `error.tsx` and only a ROOT LAYOUT throw ever reaches `global-error.tsx`
 * — had none. Its whole job, per its header comment, is choosing between a
 * real message, React's redacted stand-in, and a bare digest, and that
 * three-way branch had never been exercised anywhere on this disk.
 *
 * `renderToStaticMarkup` needs no `reset` — the component's own doc comment
 * says it is accepted and deliberately unused — so every case below omits it.
 */

function err(over: Partial<Error & { digest?: string }> = {}) {
  return Object.assign(new Error("MEASUREMENT"), over) as Error & { digest?: string }
}

function render(error: Error & { digest?: string }): string {
  return renderToStaticMarkup(<PageError error={error} />)
}

describe("the message", () => {
  it("shows a real message, the shape dev and a client throw both give", () => {
    const html = render(err({ message: "runsDir is not a directory" }))
    expect(html).toContain("runsDir is not a directory")
  })

  it("suppresses React's production stand-in for a message it withheld", () => {
    const html = render(
      err({
        message:
          "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.",
        digest: "2302084429",
      }),
    )
    expect(html).not.toContain("omitted in production builds")
  })

  it("renders no message block for an empty message", () => {
    const html = render(err({ message: "", digest: "2302084429" }))
    // Falsy `message` skips the `{message && (...)}` branch entirely: the
    // only `font-mono` block left is the digest's.
    expect(html.match(/font-mono/g)).toHaveLength(1)
  })
})

describe("the digest", () => {
  it("prints it with the flag that makes grep work", () => {
    const html = render(err({ digest: "2302084429" }))
    expect(html).toContain("digest 2302084429")
    expect(html).toContain("grep -B6 2302084429")
  })

  it("says so plainly when nothing about the error reached the browser", () => {
    const html = render(err({ message: "", digest: undefined }))
    expect(html).toContain("nothing about this error reached the browser")
  })

  it("prefers the digest branch over the fallback sentence when both could apply", () => {
    // A redacted message with no digest is still "nothing reached the
    // browser" from a reader's point of view — the redaction text itself is
    // not information. Confirms the two branches do not both fire.
    const html = render(
      err({ message: "omitted in production builds boilerplate", digest: undefined }),
    )
    expect(html).toContain("nothing about this error reached the browser")
    expect(html).not.toContain("digest")
  })

  it("does not show the fallback sentence once a real message survived", () => {
    const html = render(err({ message: "runsDir is not a directory", digest: undefined }))
    expect(html).not.toContain("nothing about this error reached the browser")
  })
})

describe("what is always there", () => {
  it("says the page could not render", () => {
    expect(render(err())).toContain("Could not render this page")
  })

  it("points at the run registry's own list for the full fault", () => {
    const html = render(err())
    expect(html).toContain('href="/kb"')
    expect(html).toContain("the knowledge base list")
  })

  it("offers a reload", () => {
    expect(render(err())).toContain(">Reload<")
  })
})

describe("it cannot itself throw", () => {
  it.each([
    ["a non-string digest", { digest: 42 }],
    ["a non-string message", { message: { toString: () => "x" } }],
  ])("survives %s where an Error was promised", (_label, over) => {
    expect(() => render(Object.assign(new Error(), over) as Error & { digest?: string })).not.toThrow()
  })

  it("treats a non-string digest as absent, same as global-error.tsx", () => {
    const html = render(err({ message: "", digest: 42 as unknown as string }))
    expect(html).not.toContain("digest 42")
    expect(html).toContain("nothing about this error reached the browser")
  })
})

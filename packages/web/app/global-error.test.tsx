import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import GlobalError from "./global-error"

/**
 * WHAT THIS FILE CAN AND CANNOT PROVE, first, because the gap is the point.
 *
 * The fault 3j names is a PAINT: a reader who chose dark gets a white frame on
 * an errored document. Nothing here can see a frame. The frame was measured
 * with a headless Chrome against a production `next start` whose root layout
 * threw — top-left pixel `rgb(255,255,255)` before, `rgb(18,18,18)` after, with
 * the chunks blocked so the frame is exactly what the server sent — and that
 * measurement lives in the commit message and in the comments on
 * `app/layout.tsx`'s `viewport` export, because there is no server in this
 * suite and inventing one to get a green tick would be the false green.
 *
 * The half of the fix that is a PAGE is pinned here, and pinned hard: which
 * theme this component chooses, that the colours it chooses are this app's
 * colours and not a framework's, that it owns the document Next requires it to
 * own, that its copy is this repo's sentences, and that it cannot be made to
 * throw. That is the whole of `global-error.tsx`. The part deliberately left
 * unpinned is the part that is not in this file.
 *
 * It is also the first test under `app/`. `vitest.config.ts` had left that
 * directory out of `include` on purpose while nothing lived there, with a note
 * saying the fix would be one line the day something did. This is that day.
 */

const SRC = readFileSync(
  fileURLToPath(new URL("./global-error.tsx", import.meta.url)),
  "utf8",
)
const GLOBALS_CSS = readFileSync(
  fileURLToPath(new URL("./globals.css", import.meta.url)),
  "utf8",
)

/**
 * `SRC` with its comments removed, for the assertions about what the file DOES.
 * That file is mostly prose — the measurements behind it are written down there
 * — and the prose names the things the code is forbidden to use. Scanning the
 * raw source for `var(--` found the paragraph explaining why there is no
 * `var(--bg)` here. Crude on purpose: the file has no regex literals and no
 * string containing `//`, so a two-pattern strip is exact for it, and the test
 * below asserts the strip actually removed something.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

function err(over: Partial<Error & { digest?: string }> = {}) {
  return Object.assign(new Error("MEASUREMENT"), over) as Error & { digest?: string }
}

/** Enough of Storage for the one call `readStoredTheme` makes. */
function stubStorage(getItem: (key: string) => string | null): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem },
  })
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

function render(error = err({ digest: "2315581360" })): string {
  return renderToStaticMarkup(<GlobalError error={error} />)
}

describe("the document it owns", () => {
  // Next requires a global-error boundary to render <html> and <body> itself,
  // because it replaces the root layout rather than sitting inside it. Get this
  // wrong and the page is blank, which is worse than the white it replaces.
  it("renders its own <html> and <body>", () => {
    const html = render()
    expect(html).toMatch(/^<html\b/)
    expect(html).toContain("<body")
    expect(html).toContain("</html>")
  })

  it("names itself in the tab, since React clears the head it inherits", () => {
    expect(render()).toContain("<title>open-kb — this page could not render</title>")
  })
})

describe("the theme it chooses", () => {
  it("is light when there is no storage at all", () => {
    // The default, and the case that matters: `kb-theme` unset is a light
    // reader in this app (lib/theme.ts). The measured fault this file exists
    // for was a reader getting the OTHER theme on the one page that cannot
    // read the stylesheet, and it is the same fault whichever way the default
    // points.
    expect("localStorage" in globalThis).toBe(false)
    const html = render()
    expect(html).toContain('data-theme="light"')
    expect(html).toContain("background:#ffffff")
    expect(html).not.toContain("#0e1b34,")
  })

  it("is dark when the reader chose dark", () => {
    stubStorage(() => "dark")
    const html = render()
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain("background:#0e1b34")
    expect(html).not.toContain("#ffffff")
  })

  it("is light when the reader chose light", () => {
    stubStorage(() => "light")
    const html = render()
    expect(html).toContain('data-theme="light"')
    expect(html).toContain("background:#ffffff")
    // #0e1b34 is in this markup, and correctly: it is the app's ink on paper.
    // What must not happen is it being a SURFACE, which is the dark palette
    // leaking into a light reader's page.
    expect(html).toContain("color:#0e1b34")
    expect(html).not.toContain("background:#0e1b34")
  })

  it("is light for anything storage holds that is not exactly dark", () => {
    for (const raw of ["", "Dark", "DARK", " dark", "system", "null"]) {
      stubStorage(() => raw)
      expect(render()).toContain('data-theme="light"')
    }
  })

  it("declares color-scheme, so the scrollbar and controls follow", () => {
    stubStorage(() => "light")
    expect(render()).toContain("color-scheme:light")
    stubStorage(() => "dark")
    expect(render()).toContain("color-scheme:dark")
  })
})

describe("the colours are this app's, and this test is why they can be trusted", () => {
  /**
   * The palette is duplicated out of globals.css as literals, because this
   * document has no stylesheet — measured, zero `<link rel=stylesheet>` — so a
   * class or a `var(--bg)` resolves to nothing. A duplicate drifts, and the
   * drift is invisible until someone opens the one page nobody wants to open.
   * So every literal in the file has to still exist in the stylesheet it was
   * copied from.
   */
  const hexes = [...SRC.matchAll(/#[0-9a-f]{6}\b/g)].map((m) => m[0])

  it("copies enough colours to be worth checking", () => {
    // Guards the guard: a regex that matched nothing would pass the next test
    // forever. Sixteen entries across two palettes today.
    expect(new Set(hexes).size).toBeGreaterThanOrEqual(10)
  })

  it.each([...new Set(hexes)])("%s is still a value in globals.css", (hex) => {
    expect(GLOBALS_CSS).toContain(hex)
  })

  it("takes each background from the right side of the theme switch", () => {
    // Not just "exists in the file" — on the correct side of it. The two
    // surfaces are the whole fault: swap them and a dark reader gets white
    // again, with every other assertion here still green.
    // The SELECTOR at the start of a line, not the first mention of it: the
    // stylesheet's own header comment names `:root[data-theme="dark"]` while
    // explaining the scheme, well above the light block, and splitting there
    // put every light token on the dark side. The first draft of this test
    // failed for that reason, which is the only reason it is spelled out.
    const split = GLOBALS_CSS.search(/^:root\[data-theme="dark"\]\s*\{/m)
    expect(split).toBeGreaterThan(0)
    const light = GLOBALS_CSS.slice(0, split)
    const dark = GLOBALS_CSS.slice(split)
    expect(light).toContain("--bg: #ffffff")
    expect(dark).toContain("--bg: #0e1b34")
  })
})

describe("the frame this file does not own", () => {
  /**
   * The first paint of an errored document belongs to `app/layout.tsx`'s
   * `viewport` export, because this component is not in the bytes the server
   * sends — it arrives as a client reference and renders after the chunk lands.
   * The two halves are one fix and only one of them is in this file, so the
   * other half is pinned here: delete that export and a dark reader is back to
   * a white frame, with every other test in this file still green.
   *
   * A source scan rather than an import: `layout.tsx` calls `next/font/google`
   * at module scope, and pulling that into the suite to read one string would
   * be a heavier dependency than the thing being checked.
   */
  const LAYOUT = readFileSync(
    fileURLToPath(new URL("./layout.tsx", import.meta.url)),
    "utf8",
  )

  it("is declared light by layout.tsx's viewport export", () => {
    const decl = /export const viewport: Viewport = \{([\s\S]*?)\}/.exec(LAYOUT)
    expect(decl, "no `export const viewport` found in app/layout.tsx").toBeTruthy()
    expect(decl![1]).toContain('colorScheme: "light"')
  })

  it("is a single value, not the operating system's choice", () => {
    // "dark light" would defer to prefers-color-scheme, and this app's theme is
    // not the OS's: a reader on a light OS who chose dark here would keep the
    // white frame. Measured before the fix at rgb(255,255,255) under BOTH
    // emulated preferences, which is what rules the OS out as the signal.
    expect(LAYOUT).not.toMatch(/colorScheme:\s*"(dark light|light dark|dark)"/)
  })
})

describe("the copy is this repo's", () => {
  it("says what happened, in this app's voice", () => {
    const html = render()
    expect(html).toContain("Could not render this page, or the app around it")
    expect(html).toContain("The root layout threw")
  })

  it("does not fall back to a framework's sentences", () => {
    const html = render()
    for (const stock of [
      "Something went wrong",
      "This page couldn’t load",
      "This page couldn't load",
      "A server error occurred",
      "Application error",
    ]) {
      expect(html).not.toContain(stock)
    }
  })

  it("offers a reload and nothing that pretends to navigate", () => {
    const html = render()
    expect(html).toContain(">Reload<")
    // Every route renders through the layout that threw, so a link elsewhere
    // would be a lie. app/error.tsx can offer one; this file cannot.
    expect(html).not.toContain("<a ")
  })
})

describe("the digest, which is the only useful thing that survives", () => {
  it("prints it with the flag that makes grep work", () => {
    const html = render(err({ digest: "2315581360" }))
    expect(html).toContain("digest 2315581360")
    expect(html).toContain("grep -B6 2315581360")
  })

  it("says so plainly when nothing about the error reached the browser", () => {
    const html = render(err({ message: "", digest: undefined }))
    expect(html).toContain("nothing about this error reached the browser")
  })

  it("suppresses React's production stand-in for a message it withheld", () => {
    // Same guard, same reason as app/error.tsx: printing the boilerplate would
    // replace a short card with a longer generic one.
    const html = render(
      err({
        message:
          "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.",
        digest: "2315581360",
      }),
    )
    expect(html).not.toContain("omitted in production builds")
    expect(html).toContain("digest 2315581360")
  })

  it("keeps a real message, which is what dev and a client throw both give", () => {
    expect(render(err({ message: "runsDir is not a directory" }))).toContain(
      "runsDir is not a directory",
    )
  })
})

describe("it cannot itself throw", () => {
  // This is the last page in the app. A boundary that crashes leaves the reader
  // with the browser's own error, and no digest at all.
  it("survives storage that throws, the way private mode does", () => {
    stubStorage(() => {
      throw new DOMException("The operation is insecure.", "SecurityError")
    })
    expect(() => render()).not.toThrow()
    expect(render()).toContain('data-theme="light"')
  })

  it.each([
    ["undefined", undefined],
    ["an empty object", {}],
    ["a non-string digest", { digest: 42 }],
    ["a non-string message", { message: { toString: () => "x" } }],
    ["a null prototype bag", Object.create(null)],
  ])("survives %s where an Error was promised", (_label, value) => {
    expect(() =>
      renderToStaticMarkup(
        <GlobalError error={value as unknown as Error & { digest?: string }} />,
      ),
    ).not.toThrow()
  })
})

describe("what it is allowed to depend on", () => {
  /**
   * The brief for this file was "keep it dependency-free". That is a property
   * of the source, not of a render, so it is asserted against the source — the
   * same shape of guard `tests/testing-doubles-stay-out-of-src.test.ts` uses,
   * and for the same reason: the failure it prevents has no exception in it.
   * An import of the header, the palette, a font loader or anything that reads
   * a store does not error here. It errors on a reader's screen, on the page
   * that exists because something already errored.
   */
  const imports = [...CODE.matchAll(/^import\s[^\n]*?from\s+"([^"]+)"/gm)].map((m) => m[1])

  it("imports exactly one module, and it is the theme rule", () => {
    expect(imports).toEqual(["@/lib/theme"])
  })

  it("has comments to strip, so the two scans below are not scanning prose", () => {
    // Guards CODE the way "copies enough colours" guards the palette scan: if
    // the strip ever removed the whole file, or nothing at all, the assertions
    // built on it would pass without reading any code.
    expect(CODE.length).toBeLessThan(SRC.length)
    expect(CODE).toContain("export default function GlobalError")
  })

  it("depends on a module that itself imports nothing", () => {
    const theme = readFileSync(
      fileURLToPath(new URL("../lib/theme.ts", import.meta.url)),
      "utf8",
    )
    expect(theme).not.toMatch(/^import\s/m)
  })

  it("uses no class names and no custom properties", () => {
    // globals.css is not applied to this document, so `className` would style
    // nothing and `var(--bg)` would resolve to nothing — both fail silently,
    // which is the only way this page fails.
    //
    // Against CODE rather than SRC: the file's header comment discusses
    // `var(--bg)` by name, in the paragraph explaining why it is not used, and
    // the first draft of this test failed on its own documentation.
    expect(CODE).not.toMatch(/className=/)
    expect(CODE).not.toMatch(/var\(--/)
  })
})

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { readStoredTheme, THEME_KEY, themeFromStored, type Theme } from "./theme"

/**
 * The theme rule, and the one copy of it that cannot import.
 *
 * The rule itself is four tokens long, which is exactly why it kept getting
 * retyped: `app/layout.tsx`'s inline no-FOUC script had it, `ThemeToggle` had
 * it, and `app/global-error.tsx` was about to make three. Two of the three now
 * share `themeFromStored`. The script cannot — it has to be a literal in the
 * served markup or it does not run before paint — so it is the one copy left,
 * and the last describe block below evaluates the REAL script text out of
 * layout.tsx and holds it to the same answers.
 *
 * That block is the reason this file exists. A unit test of a four-token
 * function proves nothing anyone doubted; a test that the two surviving copies
 * still agree is the one that catches the change nobody notices, because the
 * page where the script's answer differs from the function's is an errored one
 * that no reviewer opens.
 */

/* The table reads the other way round since light became the default. Every
   spelling that is not exactly "dark" resolves to light, including the ones a
   careless writer produces: a capital, a stray space, a JSON blob, the string
   "null". The two real values sit at the top so the inversion is visible. */
const EVERY_INPUT: Array<[string | null | undefined, Theme]> = [
  ["dark", "dark"],
  ["light", "light"],
  [null, "light"],
  [undefined, "light"],
  ["", "light"],
  ["Dark", "light"],
  ["DARK", "light"],
  [" dark", "light"],
  ["dark ", "light"],
  ["system", "light"],
  ["auto", "light"],
  ["null", "light"],
  ["undefined", "light"],
  ['{"theme":"dark"}', "light"],
]

describe("themeFromStored", () => {
  it.each(EVERY_INPUT)("%o resolves to %s", (raw, expected) => {
    expect(themeFromStored(raw)).toBe(expected)
  })

  it("treats every non-dark value as light, which is the app default", () => {
    // Stated once as a property rather than only as a table, so the intent
    // survives someone adding a third theme: the day "sepia" is real, this line
    // is the one that fails and asks whether the fallback is still right.
    const notDark = EVERY_INPUT.filter(([raw]) => raw !== "dark")
    expect(notDark.every(([raw]) => themeFromStored(raw) === "light")).toBe(true)
  })
})

describe("readStoredTheme", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  /** Enough of the Storage surface for the one call the module makes. */
  function stubStorage(getItem: (key: string) => string | null): void {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem },
    })
  }

  it("answers light when there is no storage at all", () => {
    // Node is this environment, and so is a `global-error.tsx` render in a
    // context that has been torn down. Both must produce an answer rather than
    // a second error on the page whose whole job is to survive the first one.
    expect("localStorage" in globalThis).toBe(false)
    expect(readStoredTheme()).toBe("light")
  })

  it("answers light when storage throws, which is what private mode does", () => {
    stubStorage(() => {
      throw new DOMException("The operation is insecure.", "SecurityError")
    })
    expect(readStoredTheme()).toBe("light")
  })

  it("reads the key the toggle writes", () => {
    const seen: string[] = []
    stubStorage((key) => {
      seen.push(key)
      return "light"
    })
    expect(readStoredTheme()).toBe("light")
    expect(seen).toEqual([THEME_KEY])
  })

  it("passes storage's answer through the same rule", () => {
    for (const [raw, expected] of EVERY_INPUT) {
      if (raw === undefined) continue // getItem returns string | null, never undefined
      stubStorage(() => raw)
      expect(readStoredTheme()).toBe(expected)
    }
  })
})

/**
 * The inline script in layout.tsx, run for real.
 *
 * Extracted from the source rather than restated, because a restated copy would
 * be a fourth copy and would agree with itself forever. If the extraction stops
 * matching — the script moves, is renamed, is templated — the first test here
 * fails loudly instead of the rest quietly asserting about nothing.
 */
const LAYOUT = readFileSync(
  fileURLToPath(new URL("../app/layout.tsx", import.meta.url)),
  "utf8",
)

/** The `__html:` string literal handed to dangerouslySetInnerHTML. */
function noFoucScript(): string {
  const m = /__html:\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(LAYOUT)
  if (!m) throw new Error("no __html string literal found in app/layout.tsx")
  return JSON.parse(`"${m[1]}"`) as string
}

/**
 * Runs the script against a fake document and a fake localStorage, and returns
 * what it stamped. Deliberately not jsdom: the script touches exactly two
 * objects, and a two-property stand-in makes it obvious when it starts touching
 * a third — at which point this throws rather than silently passing.
 */
function runScript(getItem: (key: string) => string | null): string | undefined {
  const dataset: Record<string, string> = {}
  const fakeDocument = { documentElement: { dataset } }
  const fakeStorage = { getItem }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("document", "localStorage", noFoucScript())(fakeDocument, fakeStorage)
  return dataset.theme
}

describe("the no-FOUC script in app/layout.tsx", () => {
  it("is still there, and is still a self-contained expression", () => {
    const src = noFoucScript()
    expect(src).toContain(THEME_KEY)
    expect(src).toContain("documentElement")
    // No imports, no bundler syntax: it is pasted into markup as-is and has to
    // run in a bare parser context.
    expect(src).not.toMatch(/\bimport\b|\brequire\(/)
  })

  it("agrees with themeFromStored on every value storage can hold", () => {
    for (const [raw, expected] of EVERY_INPUT) {
      if (raw === undefined) continue
      expect(runScript(() => raw)).toBe(expected)
      expect(runScript(() => raw)).toBe(themeFromStored(raw))
    }
  })

  it("stamps light when storage throws, like readStoredTheme does", () => {
    expect(
      runScript(() => {
        throw new DOMException("The operation is insecure.", "SecurityError")
      }),
    ).toBe("light")
  })
})

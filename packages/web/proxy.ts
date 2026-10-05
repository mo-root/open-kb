import { NextResponse, type NextRequest } from "next/server"

/**
 * One password in front of everything.
 *
 * A run costs about fifty cents of somebody's real money and the start endpoint
 * takes a domain and nothing else, so an unauthenticated deployment is a
 * stranger's script pointed at the account balance. v1 shipped the same guard
 * for the same reason.
 *
 * Basic auth deliberately, not a login: there are no users, no sessions and
 * nothing to reset. There is one password, it is handed out by hand, and it can
 * be rotated by changing an environment variable. Anything more is a feature
 * nobody asked for standing between an invited person and a map.
 *
 * WHAT THIS DOES NOT DO. It stops a stranger, not an invited person running two
 * hundred maps. The spend ceiling in the map route is what stops that, and the
 * two are independent on purpose: one is about who, the other about how much.
 *
 * Named and exported `proxy`, not `middleware`: Next 16.3.8 (this repo's
 * installed version) deprecates the `middleware.ts`/`export function middleware`
 * convention in favour of `proxy.ts`/`export function proxy` — building under
 * the old name now prints "The middleware file convention is deprecated.
 * Please use proxy instead" on every build. Behaviourally identical; a proxy
 * file always runs on the Node.js runtime rather than Edge, which this file
 * never opted out of anyway (no `runtime` in `config` below, and nothing here
 * uses an Edge-only API).
 *
 * Also the one place to put a response header that every matched route should
 * carry: `X-Content-Type-Options: nosniff`. SECURITY.md's own scope section
 * names the reason by hand — "the engine fetches arbitrary third-party web
 * pages" and "injection into a fetched page... that escapes into something it
 * shouldn't" is explicitly in scope. Every entity name and description an
 * `/api/kb/*` route answers with is text a swept SITE chose, not this app, and
 * ships as `application/json`; `nosniff` is the one-line guarantee that a
 * browser hitting that URL directly never re-sniffs the body as HTML on the
 * strength of its content rather than its declared type. Checked before
 * adding: no route in this app sets this header itself (grepped the whole of
 * `packages/web` for "X-Content-Type-Options" and "nosniff" — zero hits), so
 * nothing here is overridden or duplicated.
 *
 * `Referrer-Policy: no-referrer` rides alongside it for the same SECURITY.md
 * reason, one level up: the page URL itself — `/kb/[id]` and `/runs/[id]` both
 * carry a run id, and the anchor domain a run is investigating sits in the KB
 * route's own path — is the sensitive thing here, not just a fetched body.
 * Every modern browser already defaults to `strict-origin-when-cross-origin`
 * (Chrome 85+/Firefox 87+/Safari, the same "living standard" default
 * `SearchesPanel.tsx`'s own `noreferrer` fix cites), which already strips the
 * path on a cross-origin click-through — but that default still sends this
 * origin's bare hostname, and a same-origin request still carries the full
 * URL, including the run id, as `Referer`. `no-referrer` closes both: it
 * matches the per-image `referrerPolicy="no-referrer"` `graphIcons.ts` and
 * `SiteIcon.tsx` already set by hand for the exact same reason (favicon
 * fetches hitting a third-party host), extended here to every navigation and
 * fetch this app's own pages make, not just image loads. Checked that nothing
 * depends on `Referer` before adding: no route in this app reads
 * `req.headers.get("referer")` (grepped, zero hits), and no external resource
 * this app loads needs one back — `next/font/google` self-hosts at build
 * time (no runtime request to Google's servers at all), and the one iframe
 * (`ScrollFilm.tsx`'s `/launch-rig.html`) is a same-origin navigation a
 * missing `Referer` cannot break.
 *
 * `X-Frame-Options: SAMEORIGIN` closes the gap the comment that first added
 * this file's header allowlist named and deliberately left open: `DENY` was
 * rejected there because `ScrollFilm.tsx` frames `/launch-rig.html` (a
 * same-origin static file) in its own `<iframe>`, and `DENY` blocks framing
 * from every origin, same-origin included. `SAMEORIGIN` blocks only a
 * cross-origin page from framing this app (the clickjacking case the header
 * exists for) while leaving that one same-origin embed untouched — confirmed
 * by re-reading `ScrollFilm.tsx`: its `src="/launch-rig.html?t=0"` is a bare
 * relative path, so the framed document is always served from this app's own
 * origin, never another one. Grepped the rest of `packages/web` for
 * `<iframe` first (one hit, `ScrollFilm.tsx`) so this is not a guess about
 * what the app embeds.
 *
 * `Strict-Transport-Security: max-age=31536000` is the one header here that
 * guards SECURITY.md's own named scope item directly — "auth bypass on the
 * hosted app's basic-auth gate" — rather than the fetched-third-party-content
 * class the four headers above all answer to. Basic auth sends the password
 * on every single request, base64-encoded, which is as good as plaintext to
 * anyone on the wire; without HSTS, a visitor's very first request (or any
 * request after a cleared cache) can be silently downgraded to `http://` by
 * an on-path attacker — a captive portal, a hostile AP — and that request
 * carries the real credential. The header itself has no failure mode a
 * fixture could miss, unlike the stricter options `docs/overnight-backlog.md`
 * records this file's history already rejecting for exactly that reason
 * (`DENY` over `SAMEORIGIN`, a `Permissions-Policy` breaking
 * `navigator.clipboard`, a CSP broad enough to need a real browser to
 * check): a spec-compliant browser ignores `Strict-Transport-Security`
 * entirely on a plain `http://` response, so it cannot break local dev
 * (`next dev` over `http://localhost`) or a host that for some reason never
 * terminates TLS. One year, no `includeSubDomains`: a
 * clone of this repo can land on any custom domain, and this app has no way
 * of knowing whether every subdomain under that domain is itself served over
 * HTTPS — `includeSubDomains` would force that even where this deployment
 * cannot confirm it is true, the same narrower-than-the-obvious-choice
 * reasoning `SAMEORIGIN` over `DENY` used two paragraphs up. No `preload`
 * either: that list is permanent-ish (removal takes months) and this file
 * has no way to know a given clone's domain is meant to be HTTPS-only
 * forever.
 *
 * `Cross-Origin-Resource-Policy: same-origin` closes a different gap than the
 * four headers above: none of them stop another origin's PAGE from loading
 * this origin's response as a subresource (an `<img>`, a `<script>`, a
 * `fetch(..., {mode:"no-cors"})`) and reading something about it back —
 * timing, size, whether it loaded at all — the side-channel class `nosniff`
 * does not touch, since that header only governs how THIS origin's own bytes
 * get interpreted, never who else may load them. `nosniff`'s own paragraph
 * names the reason this app has anything worth that protection: every
 * `/api/kb/*` response is JSON built from text a swept SITE chose, not this
 * app, so a page that got a stranger to open a map and then issued exactly
 * this kind of cross-origin probe against `/api/kb/<id>` would be reading
 * that site's own classified data back through a side channel instead of
 * asking this app for it directly. `same-origin` is CORP's strictest value
 * and the right one here: this app is not a widget or an API meant to be
 * embedded by another origin's page (it sends no CORS headers anywhere, by
 * design), so there is no legitimate cross-origin load of its own output to
 * preserve.
 *
 * Checked the one direction this could break before adding it: CORP governs
 * responses FROM this server, never requests this server or its pages make
 * OUTWARD, so `graphIcons.ts`/`SiteIcon.tsx` fetching third-party favicons
 * FROM swept sites is the opposite direction and unaffected (those sites' own
 * CORP, if any, is their business, not this file's). Also grepped the whole
 * of `packages/web` for `window.open`, `postMessage` and `crossOrigin` — zero
 * hits on all three — so no popup or iframe flow of this app's own depends on
 * being readable as a subresource from elsewhere.
 *
 * Deliberately NOT `Permissions-Policy` alongside it, though it was
 * considered again: a version worth shipping would need to carry
 * `autoplay=(self)` for the landing page's muted hero `<video autoPlay>`
 * (`app/film/page.tsx`, `DemoHome.tsx`) on top of the `clipboard-write=(self)`
 * SELF-648 already flagged for `BuildWorkflow.tsx`'s copy button — two
 * browser features to get exactly right, not one, in a repo with no
 * jsdom/RTL harness and no way for this routine to load the page in a real
 * browser and see whether either one silently broke. `Cross-Origin-Resource-
 * Policy` carries no such risk: it has exactly one value that matters
 * (`same-origin`) and no per-feature allowlist to get wrong.
 */

const REALM = 'Basic realm="open-kb", charset="UTF-8"'

/** Constant-time-ish compare. Not a meaningful attack surface behind a shared
 *  password, but a length-independent compare costs nothing to write. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** `NextResponse.next()` plus the one header every matched route should carry
 *  (see this file's own doc comment for why). A single exit point so the
 *  three return sites below cannot drift out of step with each other. */
function allow(): NextResponse {
  const res = NextResponse.next()
  res.headers.set("X-Content-Type-Options", "nosniff")
  res.headers.set("Referrer-Policy", "no-referrer")
  res.headers.set("X-Frame-Options", "SAMEORIGIN")
  res.headers.set("Strict-Transport-Security", "max-age=31536000")
  res.headers.set("Cross-Origin-Resource-Policy", "same-origin")
  return res
}

export function proxy(req: NextRequest) {
  const user = process.env.KB_USER
  const password = process.env.KB_PASSWORD

  // Unset means open, which is what local development wants. A deployment that
  // forgets to set them is open too, so the deploy checklist says so out loud
  // rather than this file pretending to a safety it does not have.
  if (!user || !password) return allow()

  const header = req.headers.get("authorization") ?? ""
  if (header.startsWith("Basic ")) {
    let decoded = ""
    try {
      decoded = atob(header.slice(6))
    } catch {
      decoded = ""
    }
    const i = decoded.indexOf(":")
    if (i > 0 && same(decoded.slice(0, i), user) && same(decoded.slice(i + 1), password)) {
      return allow()
    }
  }

  return new NextResponse("Not authorised", {
    status: 401,
    headers: {
      "WWW-Authenticate": REALM,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "SAMEORIGIN",
      "Strict-Transport-Security": "max-age=31536000",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  })
}

export const config = {
  // Everything except Next's own static output. The API routes matter most:
  // /api/map is the one that spends money, and leaving it uncovered while
  // guarding the pages would be a lock on a door beside an open window.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}

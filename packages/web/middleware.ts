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

export function middleware(req: NextRequest) {
  const user = process.env.KB_USER
  const password = process.env.KB_PASSWORD

  // Unset means open, which is what local development wants. A deployment that
  // forgets to set them is open too, so the deploy checklist says so out loud
  // rather than this file pretending to a safety it does not have.
  if (!user || !password) return NextResponse.next()

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
      return NextResponse.next()
    }
  }

  return new NextResponse("Not authorised", {
    status: 401,
    headers: { "WWW-Authenticate": REALM },
  })
}

export const config = {
  // Everything except Next's own static output. The API routes matter most:
  // /api/map is the one that spends money, and leaving it uncovered while
  // guarding the pages would be a lock on a door beside an open window.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}

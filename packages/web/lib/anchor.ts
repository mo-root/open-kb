import { isReservedHost } from "@open-kb/core"

/**
 * `https://Resend.com/pricing` → `resend.com`. Returns "" for anything that is
 * not a hostname a public map can be built from, which is what `POST /api/map`
 * keys its 400 off.
 *
 * WHY THIS LIVES IN `lib/` AND NOT IN THE ROUTE. It used to be a private
 * function at the bottom of `app/api/map/route.ts`, where the only way to
 * exercise it was to stand up the handler — which reads four credentials, calls
 * OpenRouter to check a spend ceiling, and starts a background sweep. A
 * validator whose test costs a live run is a validator with no tests, and this
 * one shipped with a hole in it for exactly that long. A route file may export
 * HTTP methods and route config and little else; a module beside it may export
 * anything, and `lib/**` is already where this app keeps the logic its routes
 * are thin over.
 *
 * THE REFUSAL IS ONE OF TWO. The server fetches this host's own pages before any
 * paid call — `https://<host>/llms.txt`, `https://docs.<host>/llms.txt`,
 * `https://<host>/` — so a domain that resolves inward is a request to read the
 * deployment's own network, free of charge, with the result readable afterwards
 * at `GET /api/kb`. The shape check below is what used to be the whole
 * validation, and it accepted `127.0.0.1`, `10.0.0.5`, `169.254.169.254`,
 * `metadata.google.internal`, `internal-jenkins.corp` and `127.0.0.1.nip.io`.
 *
 * `isReservedHost` closes five of those six. It cannot close `127.0.0.1.nip.io`
 * and nothing spelled can: that is a public name with a public suffix whose `A`
 * record happens to be 127.0.0.1, and the same is true of any domain an attacker
 * registers and points inward. Those are refused a layer down, at the socket, by
 * `publicOnlyFetch` in `@open-kb/providers` — which also re-checks every
 * redirect hop, the other thing a validator on one input string can never do.
 *
 * This layer is kept anyway, and not as belt-and-braces. It is the only layer
 * that can answer a person: someone who types `localhost` gets a 400 and a
 * sentence, rather than a run that is created, recorded, streamed, and reports
 * every surface unreadable for reasons it will not explain. And it refuses
 * BEFORE `createRun`, so a probe never becomes a row.
 */
export function normalizeDomain(input: string | undefined): string {
  if (typeof input !== "string") return ""
  let d = input.trim().toLowerCase()
  if (!d) return ""
  d = d.replace(/^[a-z][\w+.-]*:\/\//, "")
  d = d.split(/[/?#]/)[0] ?? ""
  d = d.replace(/^www\./, "")
  // Unchanged, and deliberately not widened. It already refuses everything with
  // a `@`, a `:` or a bracket in it, so the userinfo and port bypasses that
  // usually have to be stripped by hand cannot arrive here in the first place —
  // `resend.com@127.0.0.1` and `127.0.0.1:8080` are both rejected by shape. What
  // it never refused is a host that is perfectly well formed and points inward,
  // which is the line below.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return ""
  if (isReservedHost(d)) return ""
  return d
}

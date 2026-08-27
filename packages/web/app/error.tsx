"use client";

import Link from "next/link";

/**
 * The one error boundary, and it is for PAGES.
 *
 * WHAT IT REPLACES. Without this file a server error under /kb/[id] or
 * /runs/[id] renders Next's own card — "This page couldn't load", a Reload
 * button, and a bare `ERROR 2302084429` — in its own document, outside this
 * app's layout: no header, no nav, no way back but the browser's own. The
 * digest is the useful half of that card and it arrives unexplained, which for
 * a reader who does not know the word is the same dead end as no digest.
 *
 * WHAT IT CANNOT DO, and why the copy is careful. It cannot show the real
 * message of a server error in a production build. React redacts the message
 * before any boundary sees it and substitutes a fixed sentence plus the digest
 * — measured against OPENKB_RUNS_DIR=/ on a `next start`: `error.message` was
 * React's "…omitted in production builds…" boilerplate, `error.digest` was
 * "2302084429", and stderr carried `digest: '2302084429'` on the same throw.
 * So the digest is shown as what it actually is — the token that finds the
 * server log line — instead of a paragraph pretending to explain the failure.
 *
 * WHERE THE MESSAGE DOES SURVIVE, and is therefore shown. Under `next dev`
 * nothing is redacted; and an error thrown in the browser by a client
 * component is not redacted in any build. The test below is on the redaction
 * text rather than on NODE_ENV precisely so that second case keeps its voice
 * in production.
 *
 * That test is cosmetic, not a safety control, and the difference matters to
 * whoever edits it next. A server message never crosses the wire in a
 * production build at all — the flight payload for a Server Component throw is
 * `E{"digest":"…"}` and nothing else, and the boilerplate sentence is
 * manufactured client-side by React. So loosening this condition cannot leak
 * anything, and if React ever rewords the sentence the worst that happens is
 * the boilerplate prints. The guard is here to keep noise off the screen.
 *
 * NOT ROUTE HANDLERS. Nothing under app/api renders this file — measured with
 * this boundary in place, /api/kb, /api/kb/[id], /api/kb/[id]/graph and
 * /api/run/[id] all still answer 500 with a zero-byte body and no digest
 * anywhere, in the response or the log. That is a separate fault with a
 * separate fix and this file is not it.
 */

// React's stand-in for a message it refuses to send. Matching the text, rather
// than the build mode, is what lets a genuine client-side message through in
// production while keeping the boilerplate out.
const REDACTED = "omitted in production builds";

/**
 * Next hands this boundary a `reset`, and it is the wrong control here.
 *
 * `reset()` re-renders the boundary's children from the client tree; it issues
 * no request, so a Server Component render can never re-run and a server fault
 * cannot clear. Measured: four clicks across two page loads produced zero
 * additional throws in the server log and no network activity — a button that
 * is indistinguishable from a broken one. Next's own card, which this file
 * replaces, offers a Reload that genuinely recovers, so wiring this to `reset`
 * would have made the page worse than having no boundary at all.
 *
 * A document load re-runs everything, which is the only thing that helps a
 * server fault and also covers the client-side case `reset` was meant for. So
 * `reset` is accepted and deliberately unused.
 */
export default function PageError({ error }: { error: Error & { digest?: string } }) {
  // `typeof` rather than truthiness on `error.message` directly: React's own
  // contract for what a boundary receives is looser than the type says (see
  // global-error.tsx, which carries the identical guard for the identical
  // reason), and `.includes` on a non-string throws — turning this boundary
  // into exactly the crash it exists to catch. Caught here first: this file's
  // own test asserted a non-string `message` on the promised `Error` and
  // `error.message.includes is not a function` came back instead of a render.
  const message =
    typeof error.message === "string" && !error.message.includes(REDACTED)
      ? error.message
      : null;
  const digest = typeof error.digest === "string" ? error.digest : null;

  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-sm text-rose-300">
        Could not render this page
        {message && (
          <div className="mt-1 font-mono text-xs text-slate-500">{message}</div>
        )}
        {digest ? (
          // `grep <digest>` alone prints the digest line and nothing else — the
          // message sits five lines above it in the entry. Naming the flag is
          // the difference between the operator's first command working and it
          // returning a bare number.
          <div className="mt-1 font-mono text-xs text-slate-500">
            digest {digest} — the server log entry carries the same value
            (grep -B6 {digest})
          </div>
        ) : (
          !message && (
            <div className="mt-1 font-mono text-xs text-slate-500">
              nothing about this error reached the browser; the server log has it
            </div>
          )
        )}
        {/* The shortest route to the real cause is usually a click, not a grep:
            both list pages catch a registry refusal in the server component and
            render it in full at 200, no log access required. In full because
            that refusal is a NAMED fault — lib/api-error.ts wrote the sentence,
            so a page is allowed to repeat it. Anything else those pages catch
            answers with a ref, exactly like this card does. */}
        <div className="mt-1 text-xs text-slate-500">
          If this is the run registry,{" "}
          <Link href="/kb" className="text-sky-400 hover:text-sky-300">
            the knowledge base list
          </Link>{" "}
          reports those faults in full.
        </div>
        <div className="mt-4">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-800/60"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

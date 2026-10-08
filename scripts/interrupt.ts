import { EXIT } from "./fatal.js"

/**
 * CTRL+C ON A RUNNING SWEEP TODAY IS NODE'S OWN DEFAULT: the process dies on
 * the signal with no listener installed, and nothing is printed — even
 * though every other way this file's run can end (a spend-cap trip,
 * `fatal()`) prints what was spent before it exits. Confirmed by grep:
 * `process.on("SIGINT"` / `"SIGTERM"` return zero hits anywhere in
 * `packages/` or `scripts/` before this file (2026-10-08 overnight fire). A
 * user who starts a ~28-minute first run (see `--quick`'s own comment above
 * in `scripts/sweep.ts`) and stops it partway through currently learns
 * nothing about what that cost them.
 *
 * This wires SIGINT and SIGTERM to the run's own `AbortController` instead —
 * the exact mechanism `withSpendCap`'s watchdog already uses for a
 * cost-triggered stop, and the one every checkpoint in
 * `packages/sweep/src/sweep.ts` (`signal?.aborted`) already decodes as "stop,
 * cleanly, now". One signal aborts and reports what was spent so far; a
 * second means the first did not unwind fast enough — a call stuck past its
 * own checkpoint — and leaves at once, the same double-Ctrl+C escape hatch
 * most long-running CLIs give an impatient operator.
 *
 * Returns an unregister function for a caller — or a test — to remove the
 * listeners; `scripts/sweep.ts` never calls it, since the process is about to
 * exit either way once this fires.
 */
export function installInterruptHandler(
  abort: AbortController,
  totalUsd: () => number,
  holder: { interrupted: boolean },
): () => void {
  const handler = () => {
    if (holder.interrupted) {
      console.error("\nsecond Ctrl+C — leaving now, whatever was still in flight is lost.")
      process.exit(EXIT.interrupted)
    }
    holder.interrupted = true
    console.error(`\nstopped by Ctrl+C — $${totalUsd().toFixed(4)} spent so far, nothing further bought.`)
    abort.abort()
  }
  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)
  return () => {
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
  }
}

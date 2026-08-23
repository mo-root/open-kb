/**
 * A per-call deadline that survives garbage collection.
 *
 * `AbortSignal.timeout(ms)` composed through `AbortSignal.any([run, timeout])`
 * is held only WEAKLY by the composite on Node 20 (20.19.5 is what this repo
 * runs; Node 22 holds it). A garbage collection during the call frees the
 * timeout signal, the timer then has nothing to abort, and the call runs
 * until the socket gives up on its own — measured at ~355 seconds on one
 * classify call in runs/sweep-cursor-com-20260823064255.json, against a
 * ceiling of 120. Reproduced with --expose-gc: the bare composite never
 * fires after a gc(); with a listener on the source it fires every time,
 * because a timeout signal with a listener is strongly held by its timer.
 *
 * The listener is the pin. `once`, so it frees itself when it fires. The run's
 * own signal, when given, is composed in unchanged: either source may abort the
 * call, and a timeout leaves `signal.aborted` false so the caller can still
 * tell a host that stopped answering from a visitor who left.
 *
 * Its own module so the regression test can load it in a child process with
 * --expose-gc without importing the whole engine.
 */
export function heldDeadline(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  timeout.addEventListener("abort", () => {}, { once: true });
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

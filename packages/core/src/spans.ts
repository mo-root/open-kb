export type SpanKind = "model" | "search" | "fetch" | "read" | "remember" | "spawn"

export interface Span {
  seq: number
  ts: string
  runId: string
  agentId: string
  parentId: string | null
  kind: SpanKind
  /** model id, or tool name */
  name: string
  /** the real query or URL — the only place a viewer sees which question was bought */
  argsDigest: string
  ms: number
  ok: boolean
  error?: string
  tokensIn?: number
  tokensOut?: number
  usd: number
  runningUsd: number
}

export type SpanInput = Omit<Span, "seq" | "ts" | "runningUsd" | "usd"> & { usd?: number }

/** One `stream()` call's read position over the shared log, plus its wake-up if it's parked. */
interface Subscriber {
  cursor: number
  wake: ((more: boolean) => void) | null
}

/**
 * One append-only log of everything the run did, successes and failures alike.
 * A failed call that emits nothing is indistinguishable from work never attempted.
 *
 * Several surfaces read the same run at once — a web view, a CLI renderer, a cost tracker.
 * `stream()` is a genuine fan-out: every call gets its own cursor over the shared log, so every
 * consumer sees every span in `seq` order, independent of how many other consumers are attached
 * or when each one started. A single shared waiter queue that handed each span to only one
 * consumer would silently split the audit trail between readers — the same failure shape as a
 * non-finite cost rendering as a healthy $0.00.
 *
 * The log itself is unbounded for the lifetime of the stream — nothing here evicts old spans, so
 * a long-running, never-closed run grows this array without limit. Callers own `close()`.
 */
export class SpanStream {
  #seq = 0
  #total = 0
  #now: () => string
  #log: Span[] = []
  #subscribers = new Set<Subscriber>()
  #closed = false

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now
  }

  emit(input: SpanInput): Span {
    let usd = input.usd ?? 0
    let ok = input.ok
    let error = input.error

    if (!Number.isFinite(usd)) {
      // Never let a missing number render as a healthy $0.00.
      usd = 0
      ok = false
      error = [error, "non-finite cost reported"].filter(Boolean).join("; ")
    }

    this.#total += usd
    const span: Span = {
      ...input,
      usd,
      ok,
      error,
      seq: ++this.#seq,
      ts: this.#now(),
      runningUsd: this.#total,
    }

    this.#log.push(span)
    for (const sub of this.#subscribers) {
      if (sub.wake) {
        const wake = sub.wake
        sub.wake = null
        wake(true)
      }
    }
    return span
  }

  totalUsd(): number {
    return this.#total
  }

  close(): void {
    this.#closed = true
    for (const sub of this.#subscribers) {
      if (sub.wake) {
        const wake = sub.wake
        sub.wake = null
        wake(false)
      }
    }
  }

  async *stream(): AsyncGenerator<Span> {
    const sub: Subscriber = { cursor: 0, wake: null }
    this.#subscribers.add(sub)
    try {
      while (true) {
        const next = this.#log.at(sub.cursor)
        if (next !== undefined) {
          sub.cursor++
          yield next
          continue
        }
        if (this.#closed) return
        const more = await new Promise<boolean>((res) => {
          sub.wake = res
        })
        if (!more) return
      }
    } finally {
      // Unsubscribe on every exit path — normal close, and a consumer that `break`s early —
      // so a reader that stops watching does not keep accumulating spans it will never read.
      this.#subscribers.delete(sub)
    }
  }
}

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

export type SpanInput = Omit<Span, "seq" | "ts" | "runningUsd"> & { usd?: number }

/**
 * One append-only log of everything the run did, successes and failures alike.
 * A failed call that emits nothing is indistinguishable from work never attempted.
 */
export class SpanStream {
  #seq = 0
  #total = 0
  #now: () => string
  #buffer: Span[] = []
  #waiters: Array<(s: Span | null) => void> = []
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

    const waiter = this.#waiters.shift()
    if (waiter) waiter(span)
    else this.#buffer.push(span)
    return span
  }

  totalUsd(): number {
    return this.#total
  }

  close(): void {
    this.#closed = true
    for (const w of this.#waiters.splice(0)) w(null)
  }

  async *stream(): AsyncGenerator<Span> {
    while (true) {
      const next = this.#buffer.shift()
      if (next) {
        yield next
        continue
      }
      if (this.#closed) return
      const span = await new Promise<Span | null>((res) => this.#waiters.push(res))
      if (span === null) return
      yield span
    }
  }
}

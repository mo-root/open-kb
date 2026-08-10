/**
 * Run-local circuit breakers, two strikes per {host, mode} pair.
 *
 * The table ships with zero entries and persists nothing: nothing is asserted
 * about any site until this run watches it fail twice. Keying on {host, mode}
 * rather than {host} is what reproduces the measured asymmetry where one
 * fetch mode is refused while a plain GET from the same host still serves
 * real bytes — opening one mode must never close the others.
 *
 * Reasons are opaque text repeated back to a reader; the table imports no
 * vocabulary. An open breaker answers with a sentence naming the host, the
 * mode, and the most recent reason (e.g. "example.com refuses the unlock tier
 * this run: two empty-200 responses"), because a model told that adapts, and
 * a model handed a bare boolean retries.
 */

export interface StrikeCount {
  strikes: number
  open: boolean
}

export type BreakerState = { open: false; because?: undefined } | { open: true; because: string }

const OPEN_AT = 2

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six"] as const

interface Entry {
  reasons: string[]
}

export class BreakerTable {
  #entries = new Map<string, Entry>()

  /** NUL as separator: no hostname or mode can contain it, so pairs never collide. */
  #key(host: string, mode: string): string {
    return host + "\u0000" + mode
  }

  /** Record one watched failure of `mode` against `host`. The second opens the pair. */
  strike(host: string, mode: string, reason: string): StrikeCount {
    const key = this.#key(host, mode)
    const entry = this.#entries.get(key) ?? { reasons: [] }
    entry.reasons.push(reason)
    this.#entries.set(key, entry)
    return { strikes: entry.reasons.length, open: entry.reasons.length >= OPEN_AT }
  }

  /** Is this {host, mode} pair refused for the rest of the run — and, if so, why, as a sentence. */
  open(host: string, mode: string): BreakerState {
    const entry = this.#entries.get(this.#key(host, mode))
    if (!entry || entry.reasons.length < OPEN_AT) return { open: false }
    return { open: true, because: `${host} refuses the ${mode} tier this run: ${this.#history(entry.reasons)}` }
  }

  #history(reasons: string[]): string {
    const last = reasons[reasons.length - 1]!
    if (reasons.every((r) => r === last)) {
      const word = COUNT_WORDS[reasons.length] ?? String(reasons.length)
      return `${word} ${last} responses`
    }
    return `${reasons.length} strikes, most recently ${last}`
  }
}

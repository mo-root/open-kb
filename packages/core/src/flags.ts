/**
 * The default-on stage flags (`triage`/`secondLook`/`listicleHarvest`) read
 * an env var as an explicit disable, never an explicit enable — the flag
 * defaults on, so there is no "1" to check for. Was hand-copied byte-for-byte
 * in `scripts/sweep.ts` (the CLI) and `packages/web/app/api/map/route.ts`
 * (the web route), each carrying a comment pointing at the other copy as the
 * reason the shape must not drift — the same "two callers, one rule" case
 * `OPENKB_TRIAGE`/`OPENKB_SECOND_LOOK`/`OPENKB_LISTICLE_HARVEST` all lean on:
 * a local clone and the hosted "Try the beta" path must turn a stage off the
 * same way, or they are not running the same product. One copy here, both
 * callers import it, so a widened or narrowed disable shape can no longer
 * land in one caller and not the other.
 */
export function disablesFlag(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase()
  return v === "0" || v === "false"
}

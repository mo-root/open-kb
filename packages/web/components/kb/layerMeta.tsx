import type { KbManifest } from "@/lib/viewTypes";

/* ---------------------------------------------------------------------------
   PORT NOTE — what came across, and what did not.

   v1's layerMeta.tsx was the shared vocabulary of TWO signal tabs (Listening =
   brain -> senses, Signals = senses -> brain): an intent-tone map, a layer
   order, layer titles, an ordering helper and an empty state. This engine runs
   no listening stage and writes no signal catalog, so none of that has a writer
   here — and the house rule this port is following is the one KbBrowser states
   in its own comment: "an empty tab is a promise the product cannot keep, and
   the house rule is to name a surface only once something writes to it."

   So the listening half is not ported. What IS ported is the half that has a
   writer on day one and that KbCard, KbBrowser and KbOverview all need — the
   manifest accessors, verbatim.
--------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   Manifest accessors.

   `KbManifest` is deliberately loose — every field optional, unknown keys
   preserved (lib/viewTypes.ts: "a run recorded before a field existed is a real
   run"). That looseness is right for the reader and wrong at the point of use:
   `manifest.players` is typed `unknown`, and a surface that renders it raw
   prints "[object Object]" the first time a run writes something unexpected.

   So every read of a manifest field on a KB surface goes through these three,
   which is also the one place to delete from when the engine starts writing a
   typed manifest. They live here because this is the KB folder's shared
   vocabulary module and KbCard (outside the folder) needs the same rules — one
   definition beats three copies drifting apart.
--------------------------------------------------------------------------- */

/** First key that holds a finite number, else undefined. Never coerces a
 *  string: a manifest that wrote `"44"` is a manifest bug worth seeing. */
export function manifestNum(
  m: KbManifest | null | undefined,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = m?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** First key that holds a non-empty string, else undefined. */
export function manifestStr(
  m: KbManifest | null | undefined,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = m?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** The build timestamp. v1's reference engine wrote snake_case and this one
 *  writes camelCase; both are the same fact, so both are accepted. */
export function builtAtOf(m: KbManifest | null | undefined): string | undefined {
  return manifestStr(m, "built_at", "builtAt");
}

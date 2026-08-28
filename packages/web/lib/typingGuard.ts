/**
 * Is the reader already typing somewhere, so a bare-key shortcut must not
 * hijack the keystroke out from under them?
 *
 * `CommandPalette.tsx` (its own `/` and Cmd/Ctrl+K) and `GraphSearch.tsx`
 * (its own `/`) each carried this exact check inline, hand-copied
 * byte-for-byte — `tagName === "INPUT" || tagName === "TEXTAREA" ||
 * isContentEditable` — with neither pinned to the other. Same shape of gap
 * as core's judge/sweep classify vocabularies (SELF-*, c38e8a3/0257cd1):
 * two independent copies of one rule, free to drift apart with nothing to
 * catch it — a fix or a widened guard (e.g. adding SELECT) landing in one
 * copy and not the other would silently reopen the hijack in whichever
 * component was missed.
 *
 * Takes primitives rather than an `Element` so it can be tested under
 * vitest's Node environment — this repo has no jsdom/RTL harness (noted on
 * every DOM-adjacent SELF item, e.g. SELF-101, SELF-102, SELF-123).
 */
export function isTypingTarget(tagName: string, isContentEditable: boolean): boolean {
  return tagName === "INPUT" || tagName === "TEXTAREA" || isContentEditable;
}

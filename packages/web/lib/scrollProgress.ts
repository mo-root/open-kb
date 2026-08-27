/**
 * ScrollFilm's scroll → film-clock mapping, pulled out of the component so it
 * can be tested without a DOM: `top` is the scroll track's `getBoundingClientRect().top`
 * (negative once scrolled into it) and `span` is `track.offsetHeight - innerHeight`,
 * the pixel distance the track can still scroll. Clamped to [0, 1] because the
 * reader can scroll past either end of the track (rubber-banding, a resize
 * mid-scroll, a hash landing past the end) and the rig's `SEEK` has no defined
 * behaviour outside that range.
 */
export function scrollProgress(top: number, span: number): number {
  return span > 0 ? Math.min(1, Math.max(0, -top / span)) : 0;
}

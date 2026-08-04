/* Skip to content.
   The header is sticky and carries five focusable things before the page
   itself; a keyboard reader moving between KBs had to walk all of them on
   every load. This is the standard escape hatch: invisible until focused,
   first in the tab order, and it lands focus on <main> rather than merely
   scrolling to it, so the next Tab continues inside the page. */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only rounded-md border border-sky-500/50 bg-slate-900 px-3 py-2 text-sm text-sky-300 focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
    >
      Skip to content
    </a>
  );
}

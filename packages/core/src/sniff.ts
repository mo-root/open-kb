export type FetchStatus = "found" | "not_found" | "blocked"

export interface RawResponse {
  url: string
  httpStatus: number
  body: string
  contentType?: string
  /**
   * Why this response looks like this, STATED rather than inferred — set only
   * when something actually said so.
   *
   * Unlockers answer 200 and put the refusal in a header (`x-brd-error`), so
   * the one measured hard-block shape, a 200 with zero bytes, arrives carrying
   * its own explanation while the status line and the body both say nothing.
   * The sniffer had to guess at that; a guess is all `empty-body` ever was.
   *
   * A port may also fill this in for itself when no response arrived at all —
   * "we stopped waiting" and "the connection died" are different facts and
   * httpStatus 0 spells them the same.
   *
   * It never overrides the sniffer. The verdict is still read off the response;
   * this only says, in someone's own words, why the response is what it is.
   */
  providerError?: string
}

/**
 * WHY a page could not be read, as a stable code — the dead-end taxonomy.
 *
 * These strings are API: persisted runs count their unreadable hosts by them,
 * so a rename is a breaking change to every stored report. The taxonomy exists
 * because "127 unreadable" is a bug report while "61 bot-walled, 40 JS-only,
 * 26 parked" is a finding, and the sniffer had already derived the distinction
 * before anything downstream flattened it.
 *
 *   - `no-response`: the transport failed before any bytes arrived — the
 *     shipped port spells that httpStatus 0. A network problem, not a verdict
 *     on the site.
 *   - `server-error`: the origin answered 5xx — its own failure, maybe a bad
 *     minute, maybe a dead host.
 *   - `http-XXX`: the origin answered a 4xx status — the page is not at this
 *     address (or refuses this caller: http-403 is the polite bot wall).
 *   - `empty-body`: success on the status line, zero bytes behind it — the
 *     measured hard-block shape (Bright Data Unlocker on stripe.com: 200,
 *     Content-Length 0).
 *   - `soft-404`: a text URL answered with an HTML page — the file is not
 *     there, however healthy the response looks.
 *   - `thin-render`: under 200 characters of readable text — an app shell,
 *     assembled in the browser the fetch never ran.
 */
export type SniffReason =
  | "no-response"
  | "server-error"
  | `http-${number}`
  | "empty-body"
  | "soft-404"
  | "thin-render"

/**
 * The full taxonomy a caller can stamp on an unreadable host: everything the
 * sniffer derives, plus the one failure the sniffer can never see —
 * `fetch-failed`, a fetch that THREW before any response landed, known only to
 * the caller holding the throw.
 */
export type UnreadableReason = SniffReason | "fetch-failed"

/**
 * A non-found verdict always carries its reason; `found` never does.
 *
 * `detail` is the response's own account of itself (`RawResponse.providerError`)
 * carried through, and it is deliberately a SECOND field rather than a richer
 * `reason`. The reason codes are API — persisted runs count their unreadable
 * hosts by them — so "blocked, empty-body" stays exactly that whether or not
 * the provider also said "requested site was blocked". One field a reader
 * counts, one field a reader reads.
 */
export type SniffResult =
  | { status: "found"; reason?: undefined; detail?: undefined; text: string }
  | { status: "not_found" | "blocked"; reason: SniffReason; detail?: string; text: string }

/** Minimum extractable characters before we call a page substantive. */
const THIN_TEXT = 200

export function extractText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype html|<html\b)/i.test(body)
}

function expectsPlainText(url: string): boolean {
  return /\.(txt|md|json)(\?|$)/i.test(url)
}

/**
 * Is this body HTML?
 *
 * Exported because callers need it for a question `sniff` cannot answer: whether
 * the server returned the KIND of file that was asked for. A `.txt` URL that
 * answers with HTML did not have the file, however healthy the response looks,
 * and one measured case returns 200, `text/html`, and 608KB of another
 * company's "Page not found" page.
 */
export function isHtml(body: string, contentType?: string): boolean {
  return isHtmlContentType(contentType) || looksLikeHtml(body) || countHtmlSignals(body) >= 2
}

function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  return /^(text\/html|application\/(xhtml\+xml|xml))/i.test(contentType)
}

/**
 * Element names allowed to vote. The vocabulary keeps component and XML markup
 * (`<Widget prop="x">`, `<price currency="usd">`) from being read as HTML.
 * Void elements are in the list: an earlier revision counted only closing tags
 * and so dropped them, which is precisely why void-heavy markup went undetected.
 */
const ELEMENT =
  "(?:html|head|body|title|div|p|span|a|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|caption|" +
  "h[1-6]|script|style|meta|link|br|hr|img|input|source|track|area|col|embed|param|base|wbr|" +
  "section|article|nav|header|footer|main|aside|figure|figcaption|form|label|button|select|option|" +
  "textarea|iframe|video|audio|picture|canvas|svg|strong|em|b|i|u|small|mark|code|pre|blockquote|" +
  "abbr|cite|time|sup|sub|del|ins|kbd|details|summary|noscript|center|font)"

/**
 * One attribute: a name, then `=`, then a quoted or bare value.
 *
 * Every part of this is load-bearing, and each part is a past failure:
 *   - the caller demands whitespace before it, so `<a, b>` in `Pair<a, b>` is
 *     not an attributed tag. An earlier revision used `[^>]*` here, which ate
 *     the `, b` and read two generics as two tags.
 *   - the name must start with a letter, so a spaced `Pair<a , b>` also fails.
 *   - the `=` is required, so a bound (`type Foo<a extends Base>`) is not an
 *     attribute either. Boolean attributes are given up to buy that.
 * A default parameter (`type Foo<a = string>`) fails on the name: `=` cannot
 * open one.
 */
const ATTR = "[a-z_:][a-z0-9_:.-]*\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s\"'=<>`]+)"

/** `</p>`, a type parameter never closes. */
const CLOSING_TAG = new RegExp(`</${ELEMENT}\\b\\s*>`, "gi")
/** `<br/>`, a type parameter never carries the slash. */
const SELF_CLOSING_TAG = new RegExp(`<${ELEMENT}\\b\\s*/>`, "gi")
/** `<img src="x">`, a type parameter never carries attributes. */
const ATTRIBUTED_TAG = new RegExp(`<${ELEMENT}\\b(?:\\s+${ATTR})+\\s*/?>`, "gi")

/**
 * Count tag shapes that prose cannot imitate.
 *
 * A *bare* opening tag is deliberately never counted. `<p>` and `<a>` are
 * indistinguishable from `type Foo<p>` and `type Bar<a>` by shape alone, and
 * counting them once ran extraction over a whole file of TypeScript and deleted
 * everything between the angle brackets. The three shapes here cannot be
 * produced by a generic parameter, so they can be counted safely.
 */
function countHtmlSignals(body: string): number {
  const closing = body.match(CLOSING_TAG)?.length ?? 0
  const selfClosing = body.match(SELF_CLOSING_TAG)?.length ?? 0
  const attributed = body.match(ATTRIBUTED_TAG)?.length ?? 0
  return closing + selfClosing + attributed
}

/**
 * Decide what actually happened, ignoring what the status line claims.
 * Three measured failures this exists to catch:
 *   - 200 with a zero-byte body (a hard block that looks like success)
 *   - 200 with an app shell and no text (a JS-rendered page)
 *   - 200 with HTML where a text file was requested (a soft 404)
 *
 * The hard decision here is "is this body HTML?", because a wrong answer is
 * damaging either way: extracting from prose deletes everything between angle
 * brackets, and not extracting from markup stores tag soup as the evidence a
 * quote is later verified against. It is settled by counting tag shapes that
 * prose cannot imitate, closing, self-closing, and attributed tags, and never
 * bare openers, which are ambiguous with generic type parameters.
 */
export function sniff(r: RawResponse): SniffResult {
  // Whatever the verdict turns out to be, the response's own account of itself
  // rides along with it. Carried, never consulted: the checks below read the
  // response exactly as they always did, so a provider that starts sending a
  // header cannot change a single verdict — it can only stop a reader from
  // having to guess at one. `empty-body` on a stated refusal is still
  // `empty-body`, and the sniffer still owns that call.
  const detail = r.providerError

  // Before any body question: httpStatus 0 is the shipped port's spelling of
  // "the transport failed before any bytes arrived". Letting it fall through
  // to the empty-body check filed network blips under the bot-wall code —
  // same verdict (blocked), wrong finding.
  if (r.httpStatus === 0) return { status: "blocked", reason: "no-response", detail, text: "" }
  if (r.httpStatus >= 500) return { status: "blocked", reason: "server-error", detail, text: "" }
  if (r.httpStatus >= 400) return { status: "not_found", reason: `http-${r.httpStatus}`, detail, text: "" }

  if (r.body.length === 0) return { status: "blocked", reason: "empty-body", detail, text: "" }

  if (expectsPlainText(r.url) && looksLikeHtml(r.body)) {
    return { status: "not_found", reason: "soft-404", detail, text: "" }
  }

  // Decide whether to extract or keep the body as-is. The declared type is a
  // hint and never a veto: real HTML arrives labelled text/plain, so the shape
  // of the body has the last word.
  //
  // Two signals, not one. One is reachable by prose that merely mentions a tag
  //, a page about HTML, a changelog quoting `</div>`, and over-detection
  // corrupts the whole body silently, so the threshold buys asymmetric safety.
  // The cost is a known gap: a lone attribute-free pair, `<p>text</p>`, has one
  // signal and is stored raw. That failure is visible (two tags in the text)
  // rather than silent, and real fragments nest or carry attributes.
  const shouldExtract = isHtml(r.body, r.contentType)

  const text = shouldExtract ? extractText(r.body) : r.body

  if (text.length < THIN_TEXT) {
    return { status: "blocked", reason: "thin-render", detail, text }
  }

  return { status: "found", text }
}

/**
 * Shrink a page to the part that names things.
 *
 * Measured on one company's two site indexes: 159,000 chars of source, of which
 * a 14,000-char prefix admitted 14%. Four products appeared only past the cut,
 * so five runs over the same pages returned 5, 6, 9, 9 and 11 products.
 *
 * These indexes are link lists. One had 821 links under 3 headings, so headings
 * alone say nothing; the sections live in the URL paths. Folding paths two
 * segments deep turns 99,000 chars into 6,600 that name every section.
 *
 * Prose pages get cut instead, since there the prefix is the content.
 */
export function condense(text: string, budget = 24_000): string {
  if (text.length <= budget) return text

  const links = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!)
  // Below this a page is prose that happens to cite things, and folding its few
  // links would discard the argument while keeping the footnotes.
  if (links.length < 40) return text.slice(0, budget)

  const heads = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^#{1,4}\s/.test(l))

  const tree = new Map<string, number>()
  for (const href of links) {
    let path: string
    try {
      path = new URL(href).pathname
    } catch {
      continue
    }
    const key = path.split("/").filter(Boolean).slice(0, 2).join("/")
    if (key) tree.set(key, (tree.get(key) ?? 0) + 1)
  }
  if (!tree.size) return text.slice(0, budget)

  const sectionLines = [...tree.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  ${k} (${n})`)

  /**
   * BOTH LISTS ARE CAPPED, or `budget` is a suggestion rather than a bound.
   *
   * `structure` used to be built from EVERY heading and EVERY section and only
   * then subtracted from the budget. A page with thousands of headings
   * therefore produced a structure larger than the whole budget, `room` went
   * negative, the prose was dropped — and the oversized structure was returned
   * anyway. MEASURED on datadoghq.com/llms.txt (566,047 chars): this function
   * returned 96,760 chars at budget 24,000 and the SAME 96,760 at budget
   * 8,000, so the argument did nothing. Downstream that blew the understand
   * prompt past what the model would answer: the call was refused twice on a
   * truncated body and the run ended before it bought a single search. An
   * anchor that publishes a large enough index could not be mapped at all.
   *
   * Sections are taken first because they are the denser summary and are
   * already ordered by page count, so a truncation keeps the biggest parts of
   * the site. Each list says how many rows it dropped: a reader who sees
   * "+1,842 more" knows the map was built off a sample, where a silently
   * shortened list reads as the whole thing.
   */
  const take = (lines: string[], room: number) => {
    const kept: string[] = []
    let used = 0
    for (const l of lines) {
      if (used + l.length + 1 > room) break
      kept.push(l)
      used += l.length + 1
    }
    const dropped = lines.length - kept.length
    // "en-US" pinned, not the box's locale: this string goes into the
    // understand prompt, and a de_DE machine would write "+1.892 more"
    // — a thousands separator a reader takes for a decimal point.
    if (dropped > 0) kept.push(`  +${dropped.toLocaleString("en-US")} more`)
    return kept
  }

  const structureRoom = Math.max(0, budget - 32)
  const keptSections = take(sectionLines, Math.floor(structureRoom * 0.6))
  const keptHeads = take(heads, structureRoom - keptSections.join("\n").length - 64)

  // Prose still gets whatever budget the structure did not need: the structure
  // says what exists, the prose says what it is for, and the first answer is
  // useless without some of the second.
  const structure = [...keptHeads, "", "sections, by page count:", ...keptSections].join("\n")
  const room = budget - structure.length - 32
  const prose =
    room > 500
      ? `\n\nfrom the page text:\n${text.replace(/^\s*[-*]\s*\[.+$/gm, "").replace(/\n{3,}/g, "\n\n").slice(0, room)}`
      : ""
  // The bound this function has always promised, now actually held.
  return (structure + prose).slice(0, budget)
}

export type FetchStatus = "found" | "not_found" | "blocked"

export interface RawResponse {
  url: string
  httpStatus: number
  body: string
  contentType?: string
}

export interface SniffResult {
  status: FetchStatus
  reason?: string
  text: string
}

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

/** `</p>` — a type parameter never closes. */
const CLOSING_TAG = new RegExp(`</${ELEMENT}\\b\\s*>`, "gi")
/** `<br/>` — a type parameter never carries the slash. */
const SELF_CLOSING_TAG = new RegExp(`<${ELEMENT}\\b\\s*/>`, "gi")
/** `<img src="x">` — a type parameter never carries attributes. */
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
 * prose cannot imitate — closing, self-closing, and attributed tags — and never
 * bare openers, which are ambiguous with generic type parameters.
 */
export function sniff(r: RawResponse): SniffResult {
  if (r.httpStatus >= 500) return { status: "blocked", reason: "server-error", text: "" }
  if (r.httpStatus >= 400) return { status: "not_found", reason: `http-${r.httpStatus}`, text: "" }

  if (r.body.length === 0) return { status: "blocked", reason: "empty-body", text: "" }

  if (expectsPlainText(r.url) && looksLikeHtml(r.body)) {
    return { status: "not_found", reason: "soft-404", text: "" }
  }

  // Decide whether to extract or keep the body as-is. The declared type is a
  // hint and never a veto: real HTML arrives labelled text/plain, so the shape
  // of the body has the last word.
  //
  // Two signals, not one. One is reachable by prose that merely mentions a tag
  // — a page about HTML, a changelog quoting `</div>` — and over-detection
  // corrupts the whole body silently, so the threshold buys asymmetric safety.
  // The cost is a known gap: a lone attribute-free pair, `<p>text</p>`, has one
  // signal and is stored raw. That failure is visible (two tags in the text)
  // rather than silent, and real fragments nest or carry attributes.
  const shouldExtract =
    isHtmlContentType(r.contentType) || looksLikeHtml(r.body) || countHtmlSignals(r.body) >= 2

  const text = shouldExtract ? extractText(r.body) : r.body

  if (text.length < THIN_TEXT) {
    return { status: "blocked", reason: "thin-render", text }
  }

  return { status: "found", text }
}

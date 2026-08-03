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

function countClosingHtmlTags(body: string): number {
  // Count occurrences of known HTML element closing tags only.
  // Closing tags are the reliable signal: generics never produce `</a>` or `</p>`.
  // This avoids false positives from short type parameters like `Pair<a, b>` which
  // looks like `<a ... >` followed by `, b` but never has a closing tag.
  const closingTagPattern = /<\/(?:html|head|body|div|p|span|a|ul|ol|li|table|tr|td|th|h[1-6]|script|style|section|article|nav|header|footer|form|button|strong|em|blockquote|pre|code)\s*>/gi
  const matches = body.match(closingTagPattern)
  return matches ? matches.length : 0
}

/**
 * Decide what actually happened, ignoring what the status line claims.
 * Three measured failures this exists to catch:
 *   - 200 with a zero-byte body (a hard block that looks like success)
 *   - 200 with an app shell and no text (a JS-rendered page)
 *   - 200 with HTML where a text file was requested (a soft 404)
 *
 * Detects HTML by counting closing tags of known HTML elements. Closing tags are
 * the reliable signal: generics and other prose never produce `</div>` or `</p>`.
 * This prevents both:
 *   - Corrupting code/markdown with generics (Array<T>), type params (Foo<a, b>),
 *     or comparison operators (a<b)
 *   - Failing to extract HTML fragments or mislabeled content served as text/plain
 */
export function sniff(r: RawResponse): SniffResult {
  if (r.httpStatus >= 500) return { status: "blocked", reason: "server-error", text: "" }
  if (r.httpStatus >= 400) return { status: "not_found", reason: `http-${r.httpStatus}`, text: "" }

  if (r.body.length === 0) return { status: "blocked", reason: "empty-body", text: "" }

  if (expectsPlainText(r.url) && looksLikeHtml(r.body)) {
    return { status: "not_found", reason: "soft-404", text: "" }
  }

  // Decide whether to extract HTML or keep as-is.
  // Strategy: contentType is a hint, but structure is the evidence.
  // Extract if: contentType says HTML, OR body has DOCTYPE/html prefix, OR contains 2+ closing tags
  let shouldExtract = false

  if (isHtmlContentType(r.contentType)) {
    // contentType explicitly says HTML
    shouldExtract = true
  } else if (looksLikeHtml(r.body)) {
    // Fast path: body starts with DOCTYPE or <html> tag
    shouldExtract = true
  } else if (countClosingHtmlTags(r.body) >= 2) {
    // Body contains 2+ closing tags of known HTML elements: almost certainly HTML.
    // Generics, type parameters, and comparison operators never produce closing tags.
    // (one closing tag could be a lone markdown code span; two is structural signal)
    shouldExtract = true
  }

  const text = shouldExtract ? extractText(r.body) : r.body

  if (text.length < THIN_TEXT) {
    return { status: "blocked", reason: "thin-render", text }
  }

  return { status: "found", text }
}

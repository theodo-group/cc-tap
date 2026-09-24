/**
 * The one grammar of a text search in cc-tap, and the one way a term is
 * matched against a text.
 *
 * Two searches read a query: the tool filter of the Agents tab, answered on
 * the server over every transcript of a session, and the find bar of the
 * Replay and the drawers, answered in the browser over the transcript on
 * screen. They must agree: the same query has to name the same things in both,
 * or the reader learns two languages for one page. So the split into terms,
 * the folding of the text and the loose fallback live here alone, and each
 * search only decides what text to hand over.
 */

/** How a query is read */
export interface SearchOptions {
  /** match the case of the query; off, the query and the text are lowercased */
  caseSensitive?: boolean
  /** take the query as one piece of text, as quoting it does: no split into
   *  words, no loose match — only what was typed, exactly */
  exact?: boolean
}

/** Beyond this, a term is only looked for as a substring: fuzzy scans get too slow */
export const FUZZY_MAX_TEXT = 200_000

/**
 * Split a query into terms, lowercased unless the search is case-sensitive.
 * A quoted part, "no such file", is one term that must appear as that phrase;
 * unquoted words are separate terms that may appear anywhere, in any order.
 * Every term must match. In exact mode the whole query is the one term.
 */
export function searchTerms(query: string, { caseSensitive = false, exact = false }: SearchOptions = {}): string[] {
  const cased = caseSensitive ? query : query.toLowerCase()
  if (exact) {
    const term = fold(cased).trim()
    return term ? [term] : []
  }
  const terms: string[] = []
  for (const m of cased.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = fold(m[1] ?? m[2]).trim()
    if (term) terms.push(term)
  }
  return terms
}

/** Whitespace runs to a single space: the shape every search matches against,
 *  so a phrase is found whether the text broke the line or not */
export function fold(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/** A text in the shape the terms of `options` are matched against */
export function foldText(text: string, { caseSensitive = false }: SearchOptions = {}): string {
  const folded = fold(text)
  return caseSensitive ? folded : folded.toLowerCase()
}

/**
 * How many characters a fuzzy match may skip: enough for a typo or two, and
 * small enough that the term stays one word. Without this bound the letters of
 * a short term are found in order in almost any long text.
 */
export function maxGap(term: string): number {
  return Math.min(6, Math.max(2, Math.ceil(term.length / 2)))
}

/**
 * Position of `term` in `text` as a fuzzy (subsequence) match: the characters
 * of the term appear in order, with at most `maxGap(term)` characters skipped
 * in between. Returns the start of the tightest run found, and its cost — the
 * number of skipped characters. Returns null when there is no such run.
 */
export function fuzzyFind(text: string, term: string): { start: number; cost: number } | null {
  const gap = maxGap(term)
  let best: { start: number; cost: number } | null = null
  // Every occurrence of the first character is a candidate start
  for (let s = text.indexOf(term[0]); s >= 0; s = text.indexOf(term[0], s + 1)) {
    let i = s + 1
    let ok = true
    for (let k = 1; k < term.length; k++) {
      const at = text.indexOf(term[k], i)
      if (at < 0) { ok = false; break }
      i = at + 1
    }
    if (!ok) break   // a later start cannot do better than a failed one
    const cost = (i - s) - term.length
    if (cost <= gap && (!best || cost < best.cost)) best = { start: s, cost }
    if (cost === 0) break
  }
  return best
}

/**
 * Where one term sits in a text that is already folded and cased like the
 * term, and what it cost: 0 for a literal occurrence, the skipped characters
 * for a loose one. null when the term is absent.
 *
 * A phrase, a long text or an exact search is matched literally only:
 * subsequences would be noise there.
 */
export function findTerm(text: string, term: string, exact = false): { start: number; cost: number } | null {
  const at = text.indexOf(term)
  if (at >= 0) return { start: at, cost: 0 }
  if (exact || term.includes(' ') || text.length > FUZZY_MAX_TEXT) return null
  return fuzzyFind(text, term)
}

/** True when every term is in the text. The text is folded here; no terms match nothing. */
export function matchesAll(text: string, terms: readonly string[], options: SearchOptions = {}): boolean {
  if (terms.length === 0) return false
  const hay = foldText(text, options)
  return terms.every(term => findTerm(hay, term, options.exact) !== null)
}

/** True when at least one term is in the text. The text is folded here. */
export function matchesAny(text: string, terms: readonly string[], options: SearchOptions = {}): boolean {
  if (terms.length === 0) return false
  const hay = foldText(text, options)
  return terms.some(term => findTerm(hay, term, options.exact) !== null)
}

/** The string values of a tool input, joined, so JSON keys never match */
export function inputText(input: unknown): string {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (v == null) return
    if (typeof v === 'string') out.push(v)
    else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk)
  }
  walk(input)
  return out.join('\n')
}

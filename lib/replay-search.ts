/**
 * Searching the text of one conversation, in the browser.
 *
 * The page already downloads the whole replay to render it, so a local scan
 * costs no transfer. Measured on a 9 530-turn session, 7.6 M searchable
 * characters: the scan is 2-4 ms, the index it works on is 24 MB and takes
 * 120 ms to build, ripgrep over the same log is 13-21 ms a query before any
 * round trip, and SQLite FTS5 with a trigram tokenizer answers in 0.2-2.6 ms
 * but costs 0.7 s to build, 32 MB on disk, and an index to invalidate on every
 * line a live session appends.
 *
 * Five times that size — 38 M characters — is where the scan reaches a frame
 * (9-19 ms). Past it, the next step is a worker, so typing stays smooth; a
 * server-side index only pays once the page stops loading whole replays.
 */
import type { ReplayTurn } from '@/types/claude'

/** One turn of the replay that matches the query */
export interface ReplayHit {
  /** position of the turn in the full turn list */
  index: number
  uuid: string
}

/** Beyond this, a term is only looked for as a substring: fuzzy scans get too slow */
const FUZZY_MAX_TEXT = 200_000

/** How a query is read */
export interface SearchOptions {
  /** match the case of the query */
  caseSensitive?: boolean
  /** take the query as one piece of text, as quoting it does: no split into
   *  words, no loose match — only what was typed, exactly */
  exact?: boolean
}

/**
 * Split a query into terms, lowercased unless the search is case-sensitive. A
 * quoted part, "no such file", is one term that must appear as that phrase;
 * unquoted words are separate terms that may appear anywhere, in any order.
 * Every term must match. In exact mode the whole query is the one term.
 */
export function searchTerms(query: string, { caseSensitive = false, exact = false }: SearchOptions = {}): string[] {
  const cased = caseSensitive ? query : query.toLowerCase()
  if (exact) {
    const term = cased.replace(/\s+/g, ' ').trim()
    return term ? [term] : []
  }
  const terms: string[] = []
  for (const m of cased.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (m[1] ?? m[2]).replace(/\s+/g, ' ').trim()
    if (term) terms.push(term)
  }
  return terms
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

/** Cost of one term against a text, and where it matched. null when it is absent. */
function findTerm(text: string, term: string, exact: boolean): { start: number; cost: number } | null {
  const at = text.indexOf(term)
  if (at >= 0) return { start: at, cost: 0 }
  // A phrase or a long text is matched literally only; subsequences would be noise
  if (exact || term.includes(' ') || text.length > FUZZY_MAX_TEXT) return null
  return fuzzyFind(text, term)
}

/** Everything a reader sees in a turn: its text, its thinking, its tool calls and their results */
export function turnSearchText(
  turn: ReplayTurn,
  toolResults?: Map<string, { content: string; is_error: boolean }>,
): string {
  const parts: string[] = [turn.text ?? '']
  if (turn.thinking_text) parts.push(turn.thinking_text)
  for (const c of turn.tool_calls ?? []) {
    parts.push(c.name)
    parts.push(inputText(c.input))
    const res = toolResults?.get(c.id)
    if (res) parts.push(res.content)
  }
  for (const r of turn.tool_results ?? []) parts.push(r.content)
  return parts.filter(Boolean).join('\n')
}

/** String values of a tool input, so JSON keys never match */
function inputText(input: unknown): string {
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

/**
 * The searchable text of a session, built once.
 *
 * Rebuilding it on every keystroke was the cost: on a 9 530-turn session that
 * is 8 M characters of joining and lowercasing per letter typed, 110-240 ms in
 * the browser. Built once and kept, the same search runs in a few milliseconds.
 * The lowercased and whitespace-collapsed copies are made on first use, so a
 * session nobody searches costs one pass and nothing more.
 */
export interface ReplayIndex {
  uuids: readonly string[]
  /** the searchable text of each turn, folded and lowercased: every whitespace
   *  run is one space, so a term is found whether the text broke the line or
   *  not, and the default search needs no other copy */
  lowered: readonly string[]
  /** the folded text with its case, folded again only while the case toggle is
   *  on and dropped after: holding both copies doubles the memory of a long
   *  session, and the default search never reads this one */
  cased?: readonly string[]
  /** folds the text again, with its case, for `cased` */
  refold: () => string[]
  /** what the last search over this index found, to narrow the next one */
  last?: PreviousSearch
}

/** Whitespace runs to a single space: the shape every search matches against */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/**
 * Fold a session once, at load. The folding is the expensive part — a regex
 * pass costs about 25 ms per 4 MB, against 0.08 ms for a search over the same
 * text — so doing it per keystroke, or worse per render, is what made the bar
 * slow. Done here, a query is a plain `indexOf` over text that is already in
 * the right shape.
 */
export function buildReplayIndex(
  turns: readonly ReplayTurn[],
  toolResults?: Map<string, { content: string; is_error: boolean }>,
): ReplayIndex {
  const refold = () => turns.map(t => fold(turnSearchText(t, toolResults)))
  return {
    uuids: turns.map(t => t.uuid),
    lowered: refold().map(t => t.toLowerCase()),
    refold,
  }
}

/** The texts a term is matched against */
function haystack(index: ReplayIndex, caseSensitive: boolean): readonly string[] {
  if (!caseSensitive) { index.cased = undefined; return index.lowered }
  return (index.cased ??= index.refold())
}

/**
 * Search every turn of a session, paginated or not. All terms must match, as a
 * substring or — for a single word out of exact mode — as a fuzzy subsequence.
 * Hits come back in conversation order, which is the order the arrows step
 * through.
 */
/** What the last search found, to narrow the next one */
export interface PreviousSearch {
  query: string
  options: SearchOptions
  hits: readonly ReplayHit[]
}

/**
 * True when the hits of `query` can only be a subset of the previous ones, so
 * the new search has to look at those turns alone.
 *
 * It holds while the reader types on: a longer exact query matches fewer turns.
 * It does not hold out of exact mode, where a term with no literal match falls
 * back to a subsequence and can widen the set, nor when a toggle changed under
 * the same text.
 */
export function narrowsFrom(previous: PreviousSearch | undefined, query: string, options: SearchOptions): boolean {
  if (!previous || !options.exact || !previous.options.exact) return false
  if ((options.caseSensitive ?? false) !== (previous.options.caseSensitive ?? false)) return false
  if (!previous.query || !query.startsWith(previous.query)) return false
  return true
}

export function searchIndex(
  index: ReplayIndex,
  query: string,
  options: SearchOptions = {},
  previous: PreviousSearch | undefined = index.last,
): ReplayHit[] {
  const { caseSensitive = false, exact = false } = options
  const terms = searchTerms(query, options)
  if (terms.length === 0) return []

  const texts = haystack(index, caseSensitive)
  const hits: ReplayHit[] = []
  const look = (i: number) => {
    const text = texts[i]
    if (!text) return
    for (const term of terms) if (!findTerm(text, term, exact)) return
    hits.push({ index: i, uuid: index.uuids[i] })
  }

  if (narrowsFrom(previous, query, options)) for (const h of previous!.hits) look(h.index)
  else for (let i = 0; i < texts.length; i++) look(i)

  // The next query is usually this one plus a letter, and it will start here
  index.last = { query, options, hits }
  return hits
}

/** Which parts of a turn hold a term. The search pass knows this; the cards
 *  must never scan their own text again to find out. */
export interface TurnMatch {
  text: boolean
  thinking: boolean
  /** ids of the tool calls whose input holds a term */
  inputs: Set<string>
  /** ids of the tool calls whose result holds a term, and of the tool results
   *  of a user turn */
  results: Set<string>
}

/** True when a term is in the text. The text is folded here too, so a part
 *  holding a hit is found whatever its line breaks. */
function holds(text: string | undefined, terms: readonly string[], caseSensitive: boolean, exact: boolean): boolean {
  if (!text) return false
  const folded = fold(text)
  const hay = caseSensitive ? folded : folded.toLowerCase()
  return terms.some(term => findTerm(hay, term, exact) !== null)
}

/**
 * Where the terms sit inside one turn. Called for the turn the reader is on,
 * so what holds a hit can open itself.
 */
export function matchTurnParts(
  turn: ReplayTurn,
  query: string,
  toolResults?: Map<string, { content: string; is_error: boolean }>,
  options: SearchOptions = {},
): TurnMatch {
  const terms = searchTerms(query, options)
  const { caseSensitive = false, exact = false } = options
  const match: TurnMatch = { text: false, thinking: false, inputs: new Set(), results: new Set() }
  if (terms.length === 0) return match
  match.text = holds(turn.text, terms, caseSensitive, exact)
  match.thinking = holds(turn.thinking_text, terms, caseSensitive, exact)
  for (const call of turn.tool_calls ?? []) {
    if (holds(`${call.name}\n${inputText(call.input)}`, terms, caseSensitive, exact)) match.inputs.add(call.id)
    const res = toolResults?.get(call.id)
    if (res && holds(res.content, terms, caseSensitive, exact)) match.results.add(call.id)
  }
  for (const r of turn.tool_results ?? []) {
    if (holds(r.content, terms, caseSensitive, exact)) match.results.add(r.tool_use_id)
  }
  return match
}

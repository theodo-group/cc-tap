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
 *
 * How a query is read, and how a term is matched, is not decided here: it is
 * the grammar of `lib/search-query.ts`, shared with the tool filter of the
 * Agents tab, so the same query names the same things on the whole page.
 */
import type { ReplayTurn } from '@/types/claude'
import { findTerm, fold, foldText, inputText, matchesAny, searchTerms, type SearchOptions } from '@/lib/search-query'

export type { SearchOptions } from '@/lib/search-query'

/** One turn of the replay that matches the query */
export interface ReplayHit {
  /** position of the turn in the full turn list */
  index: number
  uuid: string
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
    lowered: turns.map(t => foldText(turnSearchText(t, toolResults))),
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

/** True when a term is in the text. The text is folded there too, so a part
 *  holding a hit is found whatever its line breaks. */
function holds(text: string | undefined, terms: readonly string[], options: SearchOptions): boolean {
  return !!text && matchesAny(text, terms, options)
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
  const match: TurnMatch = { text: false, thinking: false, inputs: new Set(), results: new Set() }
  if (terms.length === 0) return match
  match.text = holds(turn.text, terms, options)
  match.thinking = holds(turn.thinking_text, terms, options)
  for (const call of turn.tool_calls ?? []) {
    if (holds(`${call.name}\n${inputText(call.input)}`, terms, options)) match.inputs.add(call.id)
    const res = toolResults?.get(call.id)
    if (res && holds(res.content, terms, options)) match.results.add(call.id)
  }
  for (const r of turn.tool_results ?? []) {
    if (holds(r.content, terms, options)) match.results.add(r.tool_use_id)
  }
  return match
}

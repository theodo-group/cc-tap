/**
 * Highlighting of the search hits in the rendered replay.
 *
 * The text comes from markdown, from `pre` blocks and from tool cards that
 * React owns, so nothing is wrapped in the DOM: the ranges are handed to the
 * CSS custom highlight registry instead, which paints them without touching
 * the tree. A browser without the registry simply shows no highlight.
 */

/** Registry names of the hits and of the hit the reader is on. The drawers get
 *  their own pair, so a transcript and the Replay behind it never wipe each
 *  other's paint. */
export const REPLAY_HIGHLIGHTS = { hit: 'replay-hit', current: 'replay-hit-current' } as const
export const DRAWER_HIGHLIGHTS = { hit: 'drawer-hit', current: 'drawer-hit-current' } as const

export interface HighlightNames { hit: string; current: string }

/** Where to look for a turn, and how to paint it */
export interface PaintOptions {
  caseSensitive?: boolean
  names?: HighlightNames
  /** default: the element whose id is `turn-<uuid>`, anywhere on the page */
  find?: (uuid: string) => HTMLElement | null
}

/** Enough to paint a screenful many times over; a guard against a one-letter query */
const MAX_RANGES = 4000

type Registry = Map<string, Highlight> | undefined

function registry(): Registry {
  return typeof CSS !== 'undefined' && 'highlights' in CSS
    ? (CSS.highlights as unknown as Map<string, Highlight>)
    : undefined
}

export function clearHighlights(names: HighlightNames = REPLAY_HIGHLIGHTS): void {
  const reg = registry()
  if (!reg) return
  reg.delete(names.hit)
  reg.delete(names.current)
}

/** Where one piece of raw text landed in the flattened text */
export interface FlatPiece {
  /** position of the piece in the list it came from */
  index: number
  /** flat index of its first character */
  from: number
  /** flat index just past its last character */
  to: number
  /** whether the character before it was a space, which the piece's own
   *  leading whitespace then folds into */
  afterSpace: boolean
}

const SPACE = /\s/

/**
 * Join raw texts into one string with every whitespace run collapsed to a
 * single space — the shape the search matched against — and keep the bounds of
 * each piece, enough to map a flat position back to it.
 *
 * The collapse runs across pieces, so a term is found whether the line wrapped,
 * broke, or crossed a `code` element in the middle. Only the bounds are kept:
 * a turn holding a megabyte of tool output would otherwise cost an array entry
 * per character.
 */
export function flattenPieces(raws: readonly string[]): { flat: string; pieces: FlatPiece[] } {
  const pieces: FlatPiece[] = []
  let flat = ''
  let lastWasSpace = true   // leading whitespace is dropped
  for (let index = 0; index < raws.length; index++) {
    const raw = raws[index]
    if (!raw) continue
    const from = flat.length
    const afterSpace = lastWasSpace
    let out = ''
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (SPACE.test(c)) {
        if (lastWasSpace) continue
        out += ' '
        lastWasSpace = true
        continue
      }
      out += c
      lastWasSpace = false
    }
    if (!out) continue
    flat += out
    pieces.push({ index, from, to: flat.length, afterSpace })
  }
  return { flat, pieces }
}

/** The piece and raw offset holding the flat character at `index` */
export function locateFlat(pieces: readonly FlatPiece[], raws: readonly string[], index: number): { piece: number; offset: number } | null {
  let lo = 0
  let hi = pieces.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const p = pieces[mid]
    if (index < p.from) { hi = mid - 1; continue }
    if (index >= p.to) { lo = mid + 1; continue }
    // Replay the collapse inside this piece alone until the wanted character
    const raw = raws[p.index]
    let seen = p.from
    let lastWasSpace = p.afterSpace
    for (let i = 0; i < raw.length; i++) {
      const isSpace = SPACE.test(raw[i])
      if (isSpace && lastWasSpace) continue
      if (seen === index) return { piece: p.index, offset: i }
      seen++
      lastWasSpace = isSpace
    }
    return null
  }
  return null
}

/** Every place a term appears in the flattened text, as flat start and end */
export function flatMatches(flat: string, terms: readonly string[], budget: number, caseSensitive = false): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  const hay = caseSensitive ? flat : flat.toLowerCase()
  for (const term of terms) {
    if (!term) continue
    for (let i = hay.indexOf(term); i >= 0; i = hay.indexOf(term, i + term.length)) {
      out.push({ start: i, end: i + term.length })
      if (out.length >= budget) return out
    }
  }
  return out
}

/**
 * Every range where a term appears under `root`. Terms are matched against the
 * flattened text, so one that spans a line break or several elements comes back
 * as a single range over them.
 */
export function termRanges(root: HTMLElement, terms: readonly string[], budget: number, caseSensitive = false): Range[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)

  const raws = nodes.map(n => n.nodeValue ?? '')
  const { flat, pieces } = flattenPieces(raws)
  const ranges: Range[] = []
  for (const { start, end } of flatMatches(flat, terms, budget, caseSensitive)) {
    const from = locateFlat(pieces, raws, start)
    const last = locateFlat(pieces, raws, end - 1)
    if (!from || !last) continue
    const range = document.createRange()
    range.setStart(nodes[from.piece], from.offset)
    range.setEnd(nodes[last.piece], last.offset + 1)
    ranges.push(range)
  }
  return ranges
}

/**
 * Paint every literal occurrence of the terms in the turns that are on the
 * page. The turn the reader is on gets the stronger highlight. Returns the
 * first occurrence in that turn, to scroll to.
 */
export function paintHighlights(
  uuids: readonly string[],
  currentUuid: string | undefined,
  terms: readonly string[],
  { caseSensitive = false, names = REPLAY_HIGHLIGHTS, find }: PaintOptions = {},
): Range | undefined {
  const reg = registry()
  if (terms.length === 0) { clearHighlights(names); return undefined }
  const locate = find ?? ((uuid: string) => document.getElementById(`turn-${uuid}`))

  const hit = new Highlight()
  const current = new Highlight()
  let first: Range | undefined
  let budget = MAX_RANGES
  for (const uuid of uuids) {
    const el = locate(uuid)
    if (!el || budget <= 0) continue
    const isCurrent = uuid === currentUuid
    const ranges = termRanges(el, terms, budget, caseSensitive)
    if (isCurrent) first = ranges[0]
    if (!reg) { if (first) break; else continue }
    const into = isCurrent ? current : hit
    for (const range of ranges) into.add(range)
    budget = MAX_RANGES - (hit.size + current.size)
  }
  reg?.set(names.hit, hit)
  reg?.set(names.current, current)
  return first
}

/**
 * Bring `range` to the middle of the screen, scrolling every box it sits in —
 * a match can be deep inside a tool result that scrolls on its own.
 */
export function scrollRangeIntoView(range: Range): void {
  const boxes: HTMLElement[] = []
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 1) boxes.push(el)
  }
  // Innermost first: each scroll moves the range, so the rect is read again
  for (const box of boxes) {
    const mark = range.getBoundingClientRect()
    const frame = box.getBoundingClientRect()
    box.scrollTop += (mark.top - frame.top) - Math.max(0, (frame.height - mark.height) / 2)
  }
  // The boxes may already have brought it on screen; the window moves only if not
  const mark = range.getBoundingClientRect()
  if (mark.top < 0 || mark.bottom > window.innerHeight) {
    window.scrollBy({ top: mark.top - window.innerHeight / 2 })
  }
}

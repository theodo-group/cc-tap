'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buildReplayIndex, matchTurnParts, searchIndex, searchTerms,
  type ReplayHit, type SearchOptions, type TurnMatch,
} from '@/lib/replay-search'
import {
  clearHighlights, paintHighlights, scrollRangeIntoView, termRanges,
  type HighlightNames,
} from '@/lib/replay-highlight'
import type { ReplayTurn } from '@/types/claude'

/** Time given to the list to render before the hits are painted */
const PAINT_DELAY_MS = 60
/** How long the scroll waits for the virtual list to mount the turn it wants */
const MOUNT_DEADLINE_MS = 2000
/** Corrections made while the cards under the hit are still being measured */
const SETTLE_TRIES = 6
/** Pause between two corrections */
const SETTLE_DELAY_MS = 80

export interface ReplaySearchOptions {
  /** registry names to paint into, so two lists never wipe each other */
  names: HighlightNames
  /** the element holding the turns; a turn is looked for inside it alone */
  root: HTMLElement | null
  /** false while the list is out of sight: the search then does nothing */
  enabled?: boolean
}

export interface ReplaySearchState {
  /** the bar is folded to its loupe until the reader opens it */
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  exact: boolean
  onExactChange: (on: boolean) => void
  caseSensitive: boolean
  onCaseSensitiveChange: (on: boolean) => void
  hits: ReplayHit[]
  /** position in `hits` the reader is on; -1 when there is none */
  position: number
  onStep: (delta: number) => void
  /** lowercase terms, for whoever paints or matches */
  terms: string[]
  hitUuids: ReadonlySet<string>
  /** the turn the arrows are on, and where its terms sit */
  current?: { uuid: string; index: number; match: TurnMatch }
  /** the list tells the search which turns it has mounted, so only those are painted */
  onRenderedChange: (first: number, last: number) => void
}

/**
 * The search over one conversation: the Replay, a sub-agent transcript, the
 * orchestrator log. It owns the query and the toggles, holds the index the
 * turns were folded into, finds the hits, paints what the list has mounted and
 * brings the matched text on screen when the hit changes.
 */
export function useReplaySearch(
  turns: readonly ReplayTurn[] | undefined,
  toolResults: Map<string, { content: string; is_error: boolean }>,
  { names, root, enabled = true }: ReplaySearchOptions,
): ReplaySearchState {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState(0)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [exact, setExact] = useState(true)
  /** what the list has mounted; painting follows it */
  const [rendered, setRendered] = useState<[number, number]>([0, 0])

  const options: SearchOptions = useMemo(() => ({ caseSensitive, exact }), [caseSensitive, exact])
  // Folded once per conversation, never per keystroke
  const index = useMemo(() => (turns ? buildReplayIndex(turns, toolResults) : null), [turns, toolResults])

  // A folded bar searches nothing: no count, no ring, no highlight. The query
  // itself is kept, so opening the bar again brings its hits back.
  const live = open && enabled ? query : ''
  const hits = useMemo(() => (index ? searchIndex(index, live, options) : []), [index, live, options])
  const terms = useMemo(() => searchTerms(live, options), [live, options])
  const hitUuids = useMemo(() => new Set(hits.map(h => h.uuid)), [hits])

  const at = hits.length > 0 ? Math.min(position, hits.length - 1) : -1
  const hit = at >= 0 ? hits[at] : undefined
  // Only the turn the arrows are on is scanned for where its terms sit, and
  // only it opens what holds them: scanning every hit turn on screen cost
  // twelve seconds a keystroke on a 9 530-turn session.
  const current = useMemo(() => {
    if (!hit || !turns) return undefined
    return { uuid: hit.uuid, index: hit.index, match: matchTurnParts(turns[hit.index], live, toolResults, options) }
  }, [hit, turns, live, toolResults, options])

  const onQueryChange = useCallback((q: string) => { setQuery(q); setPosition(0) }, [])
  const onCaseSensitiveChange = useCallback((on: boolean) => { setCaseSensitive(on); setPosition(0) }, [])
  const onExactChange = useCallback((on: boolean) => { setExact(on); setPosition(0) }, [])
  const onStep = useCallback((delta: number) => {
    setPosition(p => {
      const n = hits.length
      return n === 0 ? 0 : (((p + delta) % n) + n) % n
    })
  }, [hits.length])
  const onRenderedChange = useCallback((first: number, last: number) => setRendered([first, last]), [])

  const find = useCallback(
    (uuid: string) => root?.querySelector<HTMLElement>(`[data-turn="${uuid}"]`) ?? null,
    [root],
  )

  // Paint what the list has mounted, and again as it mounts more. Nothing off
  // screen is mounted, so nothing off screen is painted.
  useEffect(() => {
    if (!enabled) { clearHighlights(names); return }
    const t = setTimeout(
      () => paintHighlights(hits.map(h => h.uuid), hit?.uuid, terms, { caseSensitive, names, find }),
      PAINT_DELAY_MS,
    )
    return () => clearTimeout(t)
  }, [hits, hit, terms, caseSensitive, enabled, names, find, rendered])
  useEffect(() => () => clearHighlights(names), [names])

  // Bring the matched text on screen when the hit changes, and only then:
  // scrolling mounts other turns, and repainting those must not pull the reader
  // back to the hit they scrolled away from.
  const currentUuid = hit?.uuid
  useEffect(() => {
    if (!enabled || !currentUuid) return
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    const deadline = performance.now() + MOUNT_DEADLINE_MS
    const settle = () => {
      const el = find(currentUuid)
      // A virtual list may not have mounted that turn yet
      if (!el) { if (performance.now() < deadline) frame = requestAnimationFrame(settle); return }
      const [mark] = termRanges(el, terms, 1, caseSensitive)
      const box = (mark ?? el).getBoundingClientRect()
      if (box.top >= 0 && box.bottom <= window.innerHeight) return
      if (mark) scrollRangeIntoView(mark)
      else el.scrollIntoView({ block: 'center' })
      // A card is measured after it mounts, which moves everything below it;
      // the scroll is corrected until it holds, or a few tries at most.
      if (++tries < SETTLE_TRIES) timer = setTimeout(() => { frame = requestAnimationFrame(settle) }, SETTLE_DELAY_MS)
    }
    frame = requestAnimationFrame(settle)
    return () => { cancelAnimationFrame(frame); if (timer) clearTimeout(timer) }
  }, [currentUuid, terms, caseSensitive, enabled, find])

  return {
    open, onOpenChange: setOpen,
    query, onQueryChange,
    exact, onExactChange,
    caseSensitive, onCaseSensitiveChange,
    hits, position: at, onStep,
    terms, hitUuids, current,
    onRenderedChange,
  }
}

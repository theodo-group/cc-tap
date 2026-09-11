'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useVirtualizer, useWindowVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { UserTurnCard, AssistantTurnCard } from './turn-cards'
import { inWindow, type TimeWindow } from '@/lib/time-window'
import type { CompactionEvent, ReplayTurn } from '@/types/claude'
import type { TurnMatch } from '@/lib/replay-search'
import { Undo2 } from 'lucide-react'

/** Height a turn is assumed to have until it is measured. Measured over a
 *  9 530-turn session: median 123-166 px, mean 143-189 px. Too high an estimate
 *  makes the list shrink as the cards above are measured, which the reader
 *  feels as a jump when going back up. */
const ESTIMATED_TURN_HEIGHT = 160
/** Turns kept mounted on each side of the screen, so scrolling shows no gap */
const OVERSCAN = 6

/** Measure a card on the next frame, and let React batch the re-render: the
 *  virtualiser otherwise flushes it synchronously, which React refuses from
 *  inside a lifecycle and logs on every jump. */
const SHARED_OPTIONS = {
  useAnimationFrameWithResizeObserver: true,
  useFlushSync: false,
}

interface TurnListProps {
  turns: readonly ReplayTurn[]
  toolResults: Map<string, { content: string; is_error: boolean }>
  compactions: readonly CompactionEvent[]
  /** turns outside the selected window are dimmed, never hidden */
  window?: TimeWindow | null
  /** uuids of every turn the search matched */
  hitUuids?: ReadonlySet<string>
  /** the turn the search arrows are on, and where its terms sit */
  current?: { uuid: string; match: TurnMatch }
  /** index to bring on screen; the list scrolls to it when the token changes */
  focus?: { index: number; token: number } | null
  /** the turns that are mounted, so the caller can paint what is on screen */
  onRenderedChange?: (first: number, last: number) => void
}

/**
 * The conversation, virtualised against the window scroll.
 *
 * A session can hold ten thousand turns, and a jump can land on any of them.
 * Rendering a prefix up to the target mounted every card before it — 9 530
 * cards and 14 s for a hit near the end. Only what is on screen is mounted, so
 * a jump costs the same wherever it lands, and a keystroke re-renders a
 * screenful rather than a session.
 */
export function TurnList(props: TurnListProps) {
  // The list starts below the header and the stat cards, and the window scroll
  // has to account for that offset.
  const [listTop, setListTop] = useState(0)
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const takeList = useCallback((el: HTMLDivElement | null) => {
    setElement(el)
    if (el) setListTop(el.offsetTop)
  }, [])
  useEffect(() => {
    if (!element) return
    const measure = () => setListTop(element.offsetTop)
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [element])

  const virtualizer = useWindowVirtualizer({
    count: props.turns.length,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    overscan: OVERSCAN,
    scrollMargin: listTop,
    getItemKey: i => props.turns[i].uuid || i,
    ...SHARED_OPTIONS,
  })

  return <Rows {...props} virtualizer={virtualizer} offset={listTop} takeList={takeList} />
}

/** The same list inside a panel that scrolls on its own, such as a drawer */
export function PanelTurnList({ scroller, ...props }: TurnListProps & { scroller: HTMLElement | null }) {
  const virtualizer = useVirtualizer({
    count: props.turns.length,
    getScrollElement: () => scroller,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: i => props.turns[i].uuid || i,
    ...SHARED_OPTIONS,
  })

  return <Rows {...props} virtualizer={virtualizer} offset={0} />
}

interface RowsProps extends TurnListProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  virtualizer: Virtualizer<any, Element>
  /** distance from the scroller's origin to the first card */
  offset: number
  takeList?: (el: HTMLDivElement | null) => void
}

function Rows({
  turns, toolResults, compactions, window: win, hitUuids, current, focus, onRenderedChange,
  virtualizer, offset, takeList,
}: RowsProps) {
  // Keep the scroll where the reader put it when a card above the fold is
  // measured. The virtualiser skips that correction while the reader scrolls
  // up, which is exactly when it is needed: the cards coming into view above
  // have never been measured, and every correction moves the text under the eye.
  useEffect(() => {
    // The virtualiser reads this off the instance; it takes no such option.
    // eslint-disable-next-line react-hooks/immutability
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      item.start + item.size <= (instance.scrollOffset ?? 0)
  }, [virtualizer])

  const compactionByIndex = useMemo(() => new Map(compactions.map(c => [c.turn_index, c])), [compactions])
  /** The Replay numbers assistant turns among themselves, so the count cannot
   *  be kept while mapping: any turn can be the first one rendered. */
  const assistantNumbers = useMemo(() => {
    const numbers = new Array<number>(turns.length)
    let n = 0
    for (let i = 0; i < turns.length; i++) numbers[i] = turns[i].type === 'assistant' ? ++n : 0
    return numbers
  }, [turns])

  // A new token means the caller wants that turn on screen, even when it is the
  // same index as the time before.
  const token = focus?.token
  const index = focus?.index
  useEffect(() => {
    if (index === undefined || index < 0) return
    // Out of the lifecycle: the virtualiser flushes the scroll adjustment
    // synchronously, which React refuses from inside an effect.
    const frame = requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: 'center' }))
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, index])

  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? 0
  useEffect(() => { onRenderedChange?.(first, last) }, [first, last, onRenderedChange])

  return (
    <div ref={takeList} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {items.map(item => {
        const i = item.index
        const turn = turns[i]
        const startsDiscarded = turn.discarded && !turns[i - 1]?.discarded
        const isHit = hitUuids?.has(turn.uuid) ?? false
        const isCurrent = turn.uuid === current?.uuid
        const wrapClass = [
          turn.discarded && 'opacity-50 saturate-50',
          !inWindow(turn.timestamp, win ?? null) && 'opacity-40',
          isHit && 'rounded-xl ring-1 ring-primary/40',
          isHit && isCurrent && 'ring-2 ring-primary',
        ].filter(Boolean).join(' ') || undefined

        return (
          <div
            key={item.key}
            data-index={i}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 top-0"
            style={{ transform: `translateY(${item.start - offset}px)` }}
          >
            {/* `data-turn` is how the search finds a turn: two lists can be on
                the page at once, and an id would then be there twice. */}
            <div id={`turn-${turn.uuid}`} data-turn={turn.uuid} className={wrapClass}>
              {startsDiscarded && (
                <div className="my-3 flex items-center gap-2 rounded-lg border border-purple-400/40 bg-purple-500/10 px-4 py-2 text-sm text-purple-300">
                  <Undo2 className="h-4 w-4" />
                  <span className="font-semibold">REWIND</span>
                  <span className="text-purple-300/80">the turns below were discarded. Their tokens still count.</span>
                </div>
              )}
              {turn.type === 'user' ? (
                <UserTurnCard
                  turn={turn}
                  turnNumber={i + 1}
                  compactionBefore={compactionByIndex.get(i)}
                  toolResults={toolResults}
                  match={isCurrent ? current?.match : undefined}
                />
              ) : (
                <AssistantTurnCard
                  turn={turn}
                  turnNumber={assistantNumbers[i]}
                  compactionBefore={compactionByIndex.get(i)}
                  toolResults={toolResults}
                  match={isCurrent ? current?.match : undefined}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

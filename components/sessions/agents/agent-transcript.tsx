'use client'

import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import type { ReplayData } from '@/types/claude'
import { PanelTurnList } from '@/components/sessions/replay/turn-list'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertTriangle } from 'lucide-react'
import { turnAtTime, flashTurn } from '@/lib/turn-at-time'
import { ReplaySearch } from '@/components/sessions/replay/replay-search'
import { useReplaySearch } from '@/components/sessions/replay/use-replay-search'
import { DRAWER_HIGHLIGHTS } from '@/lib/replay-highlight'

const fetcher = (url: string) =>
  fetch(url).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

/** How long the flash waits for the virtual list to mount the turn it wants */
const MOUNT_DEADLINE_MS = 2000

interface Props {
  sessionId: string
  /** Sub-agent to show; absent shows the orchestrator log itself */
  agentId?: string
  /** Once loaded, scroll to the turn in progress at this time and flash it */
  scrollToMs?: number
}

/** The conversation of one sub-agent, or of the orchestrator, rendered with the
 *  Replay turn cards and searched with the Replay find bar */
export function AgentTranscript({ sessionId, agentId, scrollToMs }: Props) {
  // The orchestrator url is the one the page already holds, so SWR serves it from cache
  const url = agentId ? `/api/sessions/${sessionId}/agents/${agentId}` : `/api/sessions/${sessionId}/replay`
  const { data, error, isLoading } = useSWR<ReplayData>(url, fetcher, {
    revalidateOnFocus: false,
  })
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  // The drawer panel is what scrolls here, not the window
  const scroller = useMemo(() => root?.closest<HTMLElement>('[data-slot="sheet-content"]') ?? null, [root])

  const toolResults = useMemo(() => {
    const map = new Map<string, { content: string; is_error: boolean }>()
    for (const t of data?.turns ?? []) {
      for (const r of t.tool_results ?? []) map.set(r.tool_use_id, { content: r.content, is_error: r.is_error })
    }
    return map
  }, [data])

  const search = useReplaySearch(data?.turns, toolResults, { names: DRAWER_HIGHLIGHTS, root })

  // The turn in progress at the clicked time: the list scrolls to it, and it
  // flashes once the card is mounted.
  const target = useMemo(() => {
    if (scrollToMs === undefined || !data) return null
    const t = turnAtTime(data.turns, scrollToMs)
    return t ? { uuid: t.uuid, index: data.turns.indexOf(t) } : null
  }, [data, scrollToMs])
  useEffect(() => {
    if (!target || !root) return
    let frame = 0
    let undo: (() => void) | undefined
    const deadline = performance.now() + MOUNT_DEADLINE_MS
    const look = () => {
      const el = root.querySelector<HTMLElement>(`[data-turn="${target.uuid}"]`)
      if (el) { undo = flashTurn(el); return }
      if (performance.now() < deadline) frame = requestAnimationFrame(look)
    }
    frame = requestAnimationFrame(look)
    return () => { cancelAnimationFrame(frame); undo?.() }
  }, [target, root])

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>Could not load the transcript: {String(error)}</AlertDescription>
      </Alert>
    )
  }
  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className={`h-${i % 2 === 0 ? '14' : '24'} rounded-xl`} />)}
      </div>
    )
  }

  if (data.turns.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Empty transcript.</p>
  }

  return (
    <div ref={setRoot}>
      <ReplaySearch
        placement="sticky"
        open={search.open}
        onOpenChange={search.onOpenChange}
        query={search.query}
        onQueryChange={search.onQueryChange}
        caseSensitive={search.caseSensitive}
        onCaseSensitiveChange={search.onCaseSensitiveChange}
        exact={search.exact}
        onExactChange={search.onExactChange}
        hits={search.hits}
        current={search.position}
        onStep={search.onStep}
      />
      <PanelTurnList
        scroller={scroller}
        turns={data.turns}
        toolResults={toolResults}
        compactions={data.compactions}
        hitUuids={search.hitUuids}
        current={search.current}
        focus={
          search.current
            ? { index: search.current.index, token: search.current.index }
            : target
              ? { index: target.index, token: target.index }
              : null
        }
        onRenderedChange={search.onRenderedChange}
      />
    </div>
  )
}

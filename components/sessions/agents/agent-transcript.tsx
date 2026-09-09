'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import type { ReplayData } from '@/types/claude'
import { UserTurnCard, AssistantTurnCard } from '@/components/sessions/replay/turn-cards'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'
import { turnAtTime, flashTurn } from '@/lib/turn-at-time'

const fetcher = (url: string) =>
  fetch(url).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

const PAGE = 60

interface Props {
  sessionId: string
  /** Sub-agent to show; absent shows the orchestrator log itself */
  agentId?: string
  /** Once loaded, scroll to the turn in progress at this time and flash it */
  scrollToMs?: number
}

/** The conversation of one sub-agent, or of the orchestrator, rendered with the Replay turn cards */
export function AgentTranscript({ sessionId, agentId, scrollToMs }: Props) {
  // The orchestrator url is the one the page already holds, so SWR serves it from cache
  const url = agentId ? `/api/sessions/${sessionId}/agents/${agentId}` : `/api/sessions/${sessionId}/replay`
  const { data, error, isLoading } = useSWR<ReplayData>(url, fetcher, {
    revalidateOnFocus: false,
  })
  const [limit, setLimit] = useState(PAGE)
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll to the clicked time once the turns are in the DOM
  const target = useMemo(() => {
    if (scrollToMs === undefined || !data) return null
    const t = turnAtTime(data.turns, scrollToMs)
    return t ? { uuid: t.uuid, index: data.turns.indexOf(t) } : null
  }, [data, scrollToMs])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (target) setLimit(n => Math.max(n, target.index + 20)) }, [target])
  useEffect(() => {
    if (!target || limit < target.index + 1) return
    let undo: (() => void) | undefined
    // Wait for the sheet's open animation, so the scroll lands where it should
    const t1 = setTimeout(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-turn="${target.uuid}"]`)
      if (el) undo = flashTurn(el)
    }, 350)
    return () => { clearTimeout(t1); undo?.() }
    // A new limit re-renders the same target; only a new target must scroll again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, limit >= (target?.index ?? 0) + 1])

  const toolResults = useMemo(() => {
    const map = new Map<string, { content: string; is_error: boolean }>()
    for (const t of data?.turns ?? []) {
      if (t.type === 'user' && t.tool_results) {
        for (const r of t.tool_results) map.set(r.tool_use_id, { content: r.content, is_error: r.is_error })
      }
    }
    return map
  }, [data])

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

  const turns = data.turns
  const compactionByTurnIndex = new Map(data.compactions.map(c => [c.turn_index, c]))
  let assistantTurnNum = 0

  return (
    <div ref={listRef}>
      {turns.slice(0, limit).map((turn, i) => {
        const compactionBefore = compactionByTurnIndex.get(i)
        if (turn.type === 'user') {
          return (
            <div key={turn.uuid || i} data-turn={turn.uuid}>
              <UserTurnCard turn={turn} turnNumber={i + 1} compactionBefore={compactionBefore} toolResults={toolResults} />
            </div>
          )
        }
        assistantTurnNum++
        return (
          <div key={turn.uuid || i} data-turn={turn.uuid}>
            <AssistantTurnCard turn={turn} turnNumber={assistantTurnNum} compactionBefore={compactionBefore} toolResults={toolResults} />
          </div>
        )
      })}
      {turns.length > limit && (
        <div className="py-3 text-center">
          <Button variant="outline" size="sm" onClick={() => setLimit(n => n + PAGE)}>
            Show {Math.min(PAGE, turns.length - limit)} more turns · {turns.length - limit} left
          </Button>
        </div>
      )}
      {turns.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Empty transcript.</p>}
    </div>
  )
}

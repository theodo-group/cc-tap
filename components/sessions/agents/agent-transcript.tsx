'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import type { ReplayData } from '@/types/claude'
import { UserTurnCard, AssistantTurnCard } from '@/components/sessions/replay/turn-cards'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

const fetcher = (url: string) =>
  fetch(url).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

const PAGE = 60

interface Props {
  sessionId: string
  agentId: string
}

/** The conversation of one sub-agent, rendered with the Replay turn cards */
export function AgentTranscript({ sessionId, agentId }: Props) {
  const { data, error, isLoading } = useSWR<ReplayData>(`/api/sessions/${sessionId}/agents/${agentId}`, fetcher, {
    revalidateOnFocus: false,
  })
  const [limit, setLimit] = useState(PAGE)

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
    <div>
      {turns.slice(0, limit).map((turn, i) => {
        const compactionBefore = compactionByTurnIndex.get(i)
        if (turn.type === 'user') {
          return (
            <UserTurnCard key={turn.uuid || i} turn={turn} turnNumber={i + 1} compactionBefore={compactionBefore} toolResults={toolResults} />
          )
        }
        assistantTurnNum++
        return (
          <AssistantTurnCard key={turn.uuid || i} turn={turn} turnNumber={assistantTurnNum} compactionBefore={compactionBefore} toolResults={toolResults} />
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

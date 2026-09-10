'use client'

import { useState } from 'react'
import useSWR from 'swr'
import type { ReplayData } from '@/types/claude'
import { ContextChart, type ContextMode } from './context-chart'
import { autocompactBand, buildContextMarks, buildContextSeries } from '@/lib/context-series'
import type { ContextLimits } from '@/lib/context-limits'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'

const fetcher = (url: string) =>
  fetch(url).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

interface Props {
  sessionId: string
  agentId: string
  color?: string
  /** A click on the curve reports the moment, so the drawer can scroll its transcript there */
  onPointClick?(timeMs: number): void
}

/** The context curve of one sub-agent, inside its drawer. Closed until asked for,
 *  so a drawer never pays for a chart the reader did not open. */
export function AgentContextPanel({ sessionId, agentId, color = 'var(--viz-sky)', onPointClick }: Props) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ContextMode>('tokens')

  // The same key the transcript uses, so SWR serves it from cache
  const { data, isLoading } = useSWR<ReplayData>(open ? `/api/sessions/${sessionId}/agents/${agentId}` : null, fetcher, { revalidateOnFocus: false })
  const { data: limitData } = useSWR<{ limits: ContextLimits }>(open ? '/api/context-limits' : null, fetcher, { revalidateOnFocus: false })

  const points = data ? buildContextSeries(data.turns, limitData?.limits ?? {}) : []
  const marks = data ? buildContextMarks(data.compactions) : []
  const band = autocompactBand(marks, points)

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
        >
          <span className="text-muted-foreground">{open ? '▾' : '▸'}</span> Context size
        </button>
        {open && (
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <Button variant={mode === 'tokens' ? 'secondary' : 'ghost'} size="sm" className="h-6 px-2 text-xs" onClick={() => setMode('tokens')}>Tokens</Button>
            <Button variant={mode === 'pct' ? 'secondary' : 'ghost'} size="sm" className="h-6 px-2 text-xs" onClick={() => setMode('pct')}>% of max</Button>
            <Button variant={mode === 'diff' ? 'secondary' : 'ghost'} size="sm" className="h-6 px-2 text-xs" onClick={() => setMode('diff')}>Diff</Button>
          </div>
        )}
      </div>
      {open && (
        <div className="px-2 pb-2">
          {isLoading && <Skeleton className="h-40 rounded-lg" />}
          {!isLoading && data && (
            <ContextChart
              series={[{ key: agentId, label: 'This agent', color, points }]}
              marks={marks}
              band={band}
              mode={mode}
              xAxis="turn"
              height={180}
              onPointClick={onPointClick ? (_key, p) => onPointClick(p.time) : undefined}
            />
          )}
        </div>
      )}
    </div>
  )
}

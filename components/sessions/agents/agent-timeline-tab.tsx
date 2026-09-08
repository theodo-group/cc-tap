'use client'

import { useCallback, useMemo, useState } from 'react'
import type { AgentRun, AgentTimeline } from '@/types/claude'
import { AgentFlameChart, OUTCOME_COLORS, BUSY_COLOR, TICK_COLOR, NUDGE_COLOR } from './agent-flame-chart'
import { AgentDetailsSheet } from './agent-details-sheet'
import { Button } from '@/components/ui/button'
import { formatDayClock, formatClock } from '@/lib/time-scale'
import { formatCost } from '@/lib/decode'
import { Bot } from 'lucide-react'

interface Props {
  timeline: AgentTimeline
  onJumpToTurn?(uuid: string): void
}

function Legend() {
  const items: Array<[string, string]> = [
    ['Orchestrator active', BUSY_COLOR],
    ['Completed', OUTCOME_COLORS.completed],
    ['Failed / killed', OUTCOME_COLORS.failed],
    ['Running', OUTCOME_COLORS.running],
    ['Unknown', OUTCOME_COLORS.unknown],
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: color }} /> {label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3.5 w-[3px]" style={{ background: TICK_COLOR }} /> Human prompt (orchestrator row)
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3.5 w-[3px]" style={{ background: NUDGE_COLOR }} /> Message sent to the agent by its launcher
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-border bg-muted-foreground/10" /> Idle gap &gt; 30 min
      </span>
    </div>
  )
}

export function AgentTimelineTab({ timeline, onJumpToTurn }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<AgentRun | null>(null)

  const onToggle = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const onSelect = useCallback((a: AgentRun) => setSelected(a), [])

  const parents = useMemo(() => new Map(timeline.agents.map(a => [a.id, a])), [timeline])
  const expandable = useMemo(() => timeline.agents.filter(a => a.children_count > 0).map(a => a.id), [timeline])

  const stats = useMemo(() => {
    const top = timeline.agents.filter(a => !a.parent_id)
    const cost = timeline.agents.reduce((s, a) => s + a.estimated_cost, 0)
    const failed = timeline.agents.filter(a => a.outcome === 'failed' || a.outcome === 'killed').length
    const running = timeline.agents.filter(a => a.outcome === 'running').length
    return { top: top.length, total: timeline.agents.length, cost, failed, running }
  }, [timeline])

  if (timeline.agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-20 text-center text-muted-foreground">
        <Bot className="h-8 w-8" />
        <p className="text-sm">No sub-agent transcripts were found for this session.</p>
      </div>
    )
  }

  const start = new Date(timeline.start).getTime()
  const end = new Date(timeline.end).getTime()

  return (
    <div className="flex flex-col gap-4 px-4 py-5 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-medium">{stats.top} agents</span>
          {stats.total > stats.top && <span className="text-muted-foreground"> · {stats.total - stats.top} sub-agents</span>}
          {stats.failed > 0 && <span style={{ color: OUTCOME_COLORS.failed }}> · {stats.failed} failed</span>}
          {stats.running > 0 && <span style={{ color: OUTCOME_COLORS.running }}> · {stats.running} running</span>}
          <span className="text-muted-foreground"> · agents cost {formatCost(stats.cost)}</span>
          <span className="ml-3 font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {formatDayClock(start)} → {formatDayClock(end).startsWith(formatDayClock(start).split(' ')[0]) ? formatClock(end) : formatDayClock(end)}
          </span>
        </div>
        {expandable.length > 0 && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setExpanded(new Set(expandable))}>Expand all</Button>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(new Set())}>Collapse all</Button>
          </div>
        )}
      </div>

      <Legend />

      <div className="overflow-x-auto rounded-xl border border-border bg-card p-2">
        <div className="min-w-[720px]">
          <AgentFlameChart timeline={timeline} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
        </div>
      </div>

      <AgentDetailsSheet
        agent={selected}
        parent={selected?.parent_id ? parents.get(selected.parent_id) : undefined}
        onClose={() => setSelected(null)}
        onJumpToTurn={onJumpToTurn ? uuid => { setSelected(null); onJumpToTurn(uuid) } : undefined}
      />
    </div>
  )
}

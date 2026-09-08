'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentRun, AgentTimeline } from '@/types/claude'
import { AgentFlameChart, OUTCOME_COLORS, BUSY_COLOR, TICK_COLOR, NUDGE_COLOR, CONTEXT_EVENT_STYLE, describeContextEvent, type MarkLayer } from './agent-flame-chart'
import { AgentDetailsSheet } from './agent-details-sheet'
import { ToolFilterBar } from './tool-filter-bar'
import { filterColor, filterKey, filtersFromSearch, filtersToSearch, useToolSearches, type ToolFilter } from '@/lib/tool-filters'
import type { ToolMatch } from '@/lib/tool-search'
import { Button } from '@/components/ui/button'
import { formatDayClock, formatClock } from '@/lib/time-scale'
import { inWindow, intersectsWindow, type TimeWindow } from '@/lib/time-window'
import { formatCost, formatDurationMs } from '@/lib/decode'
import { Bot, ZoomIn, ZoomOut, ExternalLink } from 'lucide-react'

interface Props {
  sessionId: string
  timeline: AgentTimeline
  window: TimeWindow | null
  onWindowChange(w: TimeWindow | null): void
  onJumpToTurn?(uuid: string): void
}

function Legend({ hasEvents }: { hasEvents: boolean }) {
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
      {hasEvents && (Object.keys(CONTEXT_EVENT_STYLE) as Array<keyof typeof CONTEXT_EVENT_STYLE>).map(k => (
        <span key={k} className="flex items-center gap-1.5" style={{ color: CONTEXT_EVENT_STYLE[k].color }}>
          <span className="inline-block h-3.5 w-0 border-l border-dashed" style={{ borderColor: CONTEXT_EVENT_STYLE[k].color }} />
          {CONTEXT_EVENT_STYLE[k].glyph} {CONTEXT_EVENT_STYLE[k].label}
        </span>
      ))}
    </div>
  )
}

const MATCH_LIST_PAGE = 100

export function AgentTimelineTab({ sessionId, timeline, window: win, onWindowChange, onJumpToTurn }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<AgentRun | null>(null)
  // Zoom shows only the selected window on a linear scale
  const [zoom, setZoom] = useState(true)

  // ─── Tool call filters, kept in the URL (?f= / ?fr=)
  const [filters, setFilters] = useState<ToolFilter[]>([])
  // Read the URL once after mount; the server render has no access to the query string
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setFilters(filtersFromSearch(window.location.search)) }, [])
  const onFiltersChange = useCallback((next: ToolFilter[]) => {
    setFilters(next)
    const url = `${window.location.pathname}${filtersToSearch(window.location.search, next)}${window.location.hash}`
    window.history.replaceState(null, '', url)
  }, [])
  const searches = useToolSearches(sessionId, filters)
  const [listOpen, setListOpen] = useState(true)
  const [listLimit, setListLimit] = useState(MATCH_LIST_PAGE)

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

  // Everything below respects the selected window: an agent counts when its lifetime overlaps it
  const visibleAgents = useMemo(() => timeline.agents.filter(a => intersectsWindow(a.start, a.end, win)), [timeline, win])
  const events = useMemo(() => timeline.context_events.filter(e => inWindow(e.timestamp, win)), [timeline, win])

  // One layer per filter: match times per agent, restricted to the window
  const layers = useMemo<MarkLayer[]>(() => filters.map((f, i) => {
    const key = filterKey(f)
    const st = searches.get(key)
    const byAgent = new Map<string, Array<[number, number]>>()
    if (st?.status === 'ok') {
      for (const m of st.result.matches) {
        if (!inWindow(m.timestamp, win)) continue
        const k = m.agent_id ?? '__orchestrator'
        const start = new Date(m.timestamp).getTime()
        const end = m.end_timestamp ? Math.max(start, new Date(m.end_timestamp).getTime()) : start
        byAgent.set(k, [...(byAgent.get(k) ?? []), [start, end]])
      }
    }
    return { key, color: filterColor(i), byAgent }
  }), [filters, searches, win])

  const countsInWindow = useMemo(() => new Map(layers.map(l => [l.key, [...l.byAgent.values()].reduce((s, xs) => s + xs.length, 0)])), [layers])

  // Combined match list, sorted by time, restricted to the window
  const matchList = useMemo(() => {
    const out: Array<ToolMatch & { color: string }> = []
    filters.forEach((f, i) => {
      const st = searches.get(filterKey(f))
      if (st?.status !== 'ok') return
      for (const m of st.result.matches) if (inWindow(m.timestamp, win)) out.push({ ...m, color: filterColor(i) })
    })
    return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }, [filters, searches, win])

  const stats = useMemo(() => {
    const top = visibleAgents.filter(a => !a.parent_id)
    const cost = visibleAgents.reduce((s, a) => s + a.estimated_cost, 0)
    const failed = visibleAgents.filter(a => a.outcome === 'failed' || a.outcome === 'killed').length
    const running = visibleAgents.filter(a => a.outcome === 'running').length
    return { top: top.length, total: visibleAgents.length, cost, failed, running }
  }, [visibleAgents])

  if (timeline.agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-20 text-center text-muted-foreground">
        <Bot className="h-8 w-8" />
        <p className="text-sm">No sub-agent transcripts were found for this session.</p>
      </div>
    )
  }

  const start = win?.from ?? new Date(timeline.start).getTime()
  const end = win?.to ?? new Date(timeline.end).getTime()
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString()

  return (
    <div className="flex flex-col gap-4 px-4 py-5 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-medium">{stats.top} agents</span>
          {stats.total > stats.top && <span className="text-muted-foreground"> · {stats.total - stats.top} sub-agents</span>}
          {stats.failed > 0 && <span style={{ color: OUTCOME_COLORS.failed }}> · {stats.failed} failed</span>}
          {stats.running > 0 && <span style={{ color: OUTCOME_COLORS.running }}> · {stats.running} running</span>}
          <span className="text-muted-foreground"> · agents cost {formatCost(stats.cost)}</span>
          {win && <span className="text-muted-foreground"> · in the selected window</span>}
          <span className="ml-3 font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {formatDayClock(start)} → {sameDay ? formatClock(end) : formatDayClock(end)}
          </span>
        </div>
        <div className="flex gap-2">
          {win && (
            <Button variant={zoom ? 'secondary' : 'ghost'} size="sm" className="gap-1.5" onClick={() => setZoom(z => !z)}>
              {zoom ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
              {zoom ? 'Show whole session' : 'Zoom to window'}
            </Button>
          )}
          {expandable.length > 0 && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setExpanded(new Set(expandable))}>Expand all</Button>
              <Button variant="ghost" size="sm" onClick={() => setExpanded(new Set())}>Collapse all</Button>
            </>
          )}
        </div>
      </div>

      <Legend hasEvents={timeline.context_events.length > 0} />

      <ToolFilterBar filters={filters} states={searches} countsInWindow={countsInWindow} hasWindow={!!win} onChange={onFiltersChange} />

      <div className="overflow-x-auto rounded-xl border border-border bg-card p-2">
        <div className="min-w-[720px]">
          <AgentFlameChart
            timeline={timeline}
            expanded={expanded}
            window={win}
            zoom={zoom}
            layers={layers}
            onToggle={onToggle}
            onSelect={onSelect}
            onWindowChange={onWindowChange}
          />
        </div>
      </div>

      {filters.length > 0 && (
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <button
            type="button"
            className="flex w-full items-center justify-between text-left text-xs font-semibold uppercase tracking-widest text-muted-foreground"
            onClick={() => setListOpen(o => !o)}
          >
            <span>Matches · {matchList.length}{win ? ' in the selected window' : ''}</span>
            <span>{listOpen ? '▾' : '▸'}</span>
          </button>
          {listOpen && (
            <ul className="mt-2 divide-y divide-border/60 text-sm">
              {matchList.length === 0 && <li className="py-2 text-muted-foreground">No matching tool call.</li>}
              {matchList.slice(0, listLimit).map(m => {
                const agent = m.agent_id ? parents.get(m.agent_id) : undefined
                const open = () => {
                  if (!m.agent_id) onJumpToTurn?.(m.turn_uuid)
                  else if (agent) setSelected(agent)
                }
                return (
                  <li key={`${m.tool_use_id}-${m.color}`} className="flex items-baseline gap-3 py-1.5">
                    <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: m.color }} />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      {formatDayClock(new Date(m.timestamp).getTime())}
                      {m.end_timestamp && <span className="text-muted-foreground/60"> · {formatDurationMs(Math.max(0, new Date(m.end_timestamp).getTime() - new Date(m.timestamp).getTime()))}</span>}
                    </span>
                    <button type="button" onClick={open} className="shrink-0 max-w-48 truncate text-left text-xs hover:underline" title={agent?.description ?? 'Orchestrator'}>
                      {agent?.description ?? m.agent_description ?? 'Orchestrator'}
                    </button>
                    <span className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">{m.tool}{m.in_result ? ' · result' : ''}{m.is_error ? ' · error' : ''}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={m.snippet}>{m.snippet}</span>
                    <button type="button" onClick={open} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Open">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </li>
                )
              })}
              {matchList.length > listLimit && (
                <li className="py-2">
                  <Button variant="ghost" size="sm" onClick={() => setListLimit(n => n + MATCH_LIST_PAGE)}>
                    Show {Math.min(MATCH_LIST_PAGE, matchList.length - listLimit)} more of {matchList.length - listLimit}
                  </Button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {events.length > 0 && (
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Context management{win ? ' · in the selected window' : ''}
          </h3>
          <ul className="space-y-1 text-sm">
            {events.map(e => {
              const st = CONTEXT_EVENT_STYLE[e.type]
              return (
                <li key={e.uuid || e.timestamp} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{formatDayClock(new Date(e.timestamp).getTime())}</span>
                  <span className="font-medium" style={{ color: st.color }}>{st.glyph} {st.label}</span>
                  <span className="text-muted-foreground">{describeContextEvent(e)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <AgentDetailsSheet
        agent={selected}
        parent={selected?.parent_id ? parents.get(selected.parent_id) : undefined}
        onClose={() => setSelected(null)}
        onJumpToTurn={onJumpToTurn ? uuid => { setSelected(null); onJumpToTurn(uuid) } : undefined}
      />
    </div>
  )
}

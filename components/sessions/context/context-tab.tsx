'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import type { AgentRun, AgentTimeline, ReplayData } from '@/types/claude'
import { ContextChart, type ContextAxis, type ContextMode, type ContextSeries } from './context-chart'
import { autocompactBand, buildContextMarks, buildContextSeries, deltaPoints, pointsInWindow } from '@/lib/context-series'
import { FALLBACK_CONTEXT_LIMIT, type ContextLimits } from '@/lib/context-limits'
import { intersectsWindow, type TimeWindow } from '@/lib/time-window'
import { FILTER_COLORS } from '@/lib/tool-filters'
import { formatTokens } from '@/lib/decode'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Bot, Check, ChevronDown, ExternalLink, X } from 'lucide-react'

const ORCHESTRATOR = '__orchestrator'
const ORCHESTRATOR_COLOR = 'var(--viz-sky)'

const fetcher = (url: string) =>
  fetch(url).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

interface Props {
  sessionId: string
  /** The whole session, not the windowed view: the chart does its own filtering */
  replay: ReplayData
  timeline?: AgentTimeline
  window: TimeWindow | null
  onWindowChange(w: TimeWindow | null): void
  /** Open the orchestrator drawer at this time */
  onOpenOrchestratorAt(timeMs: number): void
  /** Open the agent drawer at this time */
  onOpenAgentAt(agent: AgentRun, timeMs: number): void
  /** Open the Replay at the orchestrator turn in progress at this time */
  onJumpToTime(timeMs: number): void
  /** Open the Replay at one exact turn */
  onJumpToTurn(uuid: string): void
}

/** Mode and axis live in the URL, so a shared link opens on the same view */
function readParam<T extends string>(search: string, key: string, allowed: readonly T[], fallback: T): T {
  const v = new URLSearchParams(search).get(key)
  return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback
}

function writeParam(key: string, value: string, isDefault: boolean) {
  const p = new URLSearchParams(window.location.search)
  if (isDefault) p.delete(key)
  else p.set(key, value)
  const s = p.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${s ? `?${s}` : ''}${window.location.hash}`)
}

function Toggle({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Button variant={active ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2.5 text-xs" onClick={onClick}>
      {children}
    </Button>
  )
}

export function ContextTab({ sessionId, replay, timeline, window: win, onWindowChange, onOpenOrchestratorAt, onOpenAgentAt, onJumpToTime, onJumpToTurn }: Props) {
  const { data: limitData } = useSWR<{ limits: ContextLimits; fallback: number }>('/api/context-limits', fetcher, { revalidateOnFocus: false })
  // Stable identity, so the series memos do not rebuild on every render
  const limits = useMemo(() => limitData?.limits ?? {}, [limitData])

  const [mode, setMode] = useState<ContextMode>('tokens')
  const [xAxis, setXAxis] = useState<ContextAxis>('turn')
  // Read the URL once after mount; the server render has no access to the query string
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setMode(readParam(window.location.search, 'ctx', ['tokens', 'pct', 'diff'] as const, 'tokens'))
    setXAxis(readParam(window.location.search, 'cx', ['turn', 'time'] as const, 'turn'))
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */
  const changeMode = useCallback((m: ContextMode) => { setMode(m); writeParam('ctx', m, m === 'tokens') }, [])
  const changeAxis = useCallback((x: ContextAxis) => { setXAxis(x); writeParam('cx', x, x === 'turn') }, [])

  // ─── Agent curves, fetched only once picked
  const [picked, setPicked] = useState<string[]>([])
  const agents = useMemo(
    () => (timeline?.agents ?? []).filter(a => intersectsWindow(a.start, a.end, win)),
    [timeline, win],
  )
  const agentById = useMemo(() => new Map((timeline?.agents ?? []).map(a => [a.id, a])), [timeline])
  // Drop a pick that the window has hidden, so its curve does not linger
  const active = useMemo(() => picked.filter(id => agents.some(a => a.id === id)), [picked, agents])

  const key = active.length ? `agent-replays:${sessionId}:${[...active].sort().join(',')}` : null
  const { data: agentReplays, isLoading: agentsLoading } = useSWR<Record<string, ReplayData>>(
    key,
    async () => {
      const pairs = await Promise.all(active.map(async id => {
        const r = await fetch(`/api/sessions/${sessionId}/agents/${id}`)
        return [id, r.ok ? ((await r.json()) as ReplayData) : null] as const
      }))
      return Object.fromEntries(pairs.filter(([, v]) => v)) as Record<string, ReplayData>
    },
    { revalidateOnFocus: false, keepPreviousData: true },
  )

  // ─── Series, filtered to the window
  const orchestratorPoints = useMemo(() => buildContextSeries(replay.turns, limits), [replay, limits])
  const marks = useMemo(() => buildContextMarks(replay.compactions, replay.turns), [replay])
  // The band describes the whole session's threshold, so it ignores the window
  const band = useMemo(() => autocompactBand(marks, orchestratorPoints), [marks, orchestratorPoints])

  const series = useMemo(() => {
    const out: ContextSeries[] = [{
      key: ORCHESTRATOR,
      label: 'Orchestrator',
      color: ORCHESTRATOR_COLOR,
      points: pointsInWindow(orchestratorPoints, win?.from, win?.to),
      emphasis: true,
    }]
    active.forEach((id, i) => {
      const data = agentReplays?.[id]
      if (!data) return
      out.push({
        key: id,
        label: agentById.get(id)?.description ?? id.slice(0, 8),
        color: FILTER_COLORS[i % FILTER_COLORS.length],
        points: pointsInWindow(buildContextSeries(data.turns, limits), win?.from, win?.to),
      })
    })
    return out
  }, [orchestratorPoints, active, agentReplays, agentById, limits, win])

  const visibleMarks = useMemo(
    () => marks.filter(m => !win || (m.time >= win.from && m.time <= win.to)),
    [marks, win],
  )

  const peak = useMemo(() => {
    const all = series.flatMap(s => s.points)
    return all.reduce<{ tokens: number; pct: number; limit: number } | null>(
      (best, p) => (!best || p.tokens > best.tokens ? { tokens: p.tokens, pct: p.pct, limit: p.limit } : best),
      null,
    )
  }, [series])

  /** The turn that added the most, and the one that gave the most back */
  const jumps = useMemo(() => {
    const all = series.flatMap(s => deltaPoints(s.points))
    if (all.length === 0) return null
    const up = all.reduce((b, p) => (p.delta > b.delta ? p : b))
    const down = all.reduce((b, p) => (p.delta < b.delta ? p : b))
    return { up, down }
  }, [series])

  const onPointClick = useCallback((seriesKey: string, point: { time: number }) => {
    if (seriesKey === ORCHESTRATOR) onOpenOrchestratorAt(point.time)
    else {
      const a = agentById.get(seriesKey)
      if (a) onOpenAgentAt(a, point.time)
    }
  }, [agentById, onOpenAgentAt, onOpenOrchestratorAt])

  const togglePick = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
  /** Controlled, so a jump can shut the list behind it */
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <div className="flex flex-col gap-4 px-4 py-5 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-medium">Context size per turn</span>
          {mode !== 'diff' && peak && (
            <span className="text-muted-foreground">
              {' '}· peak {formatTokens(peak.tokens)} ({peak.pct.toFixed(1)}% of {formatTokens(peak.limit)})
            </span>
          )}
          {mode === 'diff' && jumps && (
            <span className="text-muted-foreground">
              {' '}· biggest rise +{formatTokens(jumps.up.delta)} at turn {jumps.up.turn}
              {jumps.down.delta < 0 && <> · biggest drop −{formatTokens(-jumps.down.delta)} at turn {jumps.down.turn}</>}
            </span>
          )}
          {visibleMarks.length > 0 && <span className="text-amber-500"> · {visibleMarks.length} compaction{visibleMarks.length === 1 ? '' : 's'}</span>}
          {win && <span className="text-muted-foreground"> · in the selected window</span>}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <Toggle active={mode === 'tokens'} onClick={() => changeMode('tokens')}>Tokens</Toggle>
            <Toggle active={mode === 'pct'} onClick={() => changeMode('pct')}>% of max</Toggle>
            <Toggle active={mode === 'diff'} onClick={() => changeMode('diff')}>Diff</Toggle>
          </div>
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <Toggle active={xAxis === 'turn'} onClick={() => changeAxis('turn')}>Turn</Toggle>
            <Toggle active={xAxis === 'time'} onClick={() => changeAxis('time')}>Time</Toggle>
          </div>

          {agents.length > 0 && (
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5">
                  <Bot className="h-3.5 w-3.5" />
                  {active.length === 0 ? 'Add agent curve' : `${active.length} agent${active.length === 1 ? '' : 's'}`}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="max-h-80 w-80 overflow-y-auto p-1">
                {active.length > 0 && (
                  <button
                    type="button"
                    className="mb-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
                    onClick={() => setPicked([])}
                  >
                    Clear all
                  </button>
                )}
                {agents.map(a => {
                  const on = active.includes(a.id)
                  return (
                    <div key={a.id} className="flex items-center gap-1 rounded hover:bg-muted">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
                        style={{ paddingLeft: 8 + a.depth * 12 }}
                        onClick={() => togglePick(a.id)}
                      >
                        <Check className={`h-3.5 w-3.5 shrink-0 ${on ? 'opacity-100' : 'opacity-0'}`} />
                        <span className="min-w-0 flex-1 truncate">{a.description}</span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{a.turns}t</span>
                      </button>
                      {/* The launching turn when the log records it, else the turn that was
                          in progress when the agent started */}
                      <button
                        type="button"
                        className="mr-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                        title="Open the conversation at this agent"
                        aria-label={`Open the conversation at ${a.description}`}
                        onClick={() => {
                          setPickerOpen(false)
                          if (a.launch_turn_uuid) onJumpToTurn(a.launch_turn_uuid)
                          else onJumpToTime(new Date(a.start).getTime())
                        }}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </PopoverContent>
            </Popover>
          )}

          {win && (
            <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => onWindowChange(null)}>
              <X className="h-3.5 w-3.5" /> Reset window
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Drag across the chart to select a time window. Click a point to open the conversation at that moment.
        {mode === 'pct' && band && ' The amber band is where this session actually compacted.'}
        {mode === 'pct' && !band && ' This session never compacted, so no threshold is drawn.'}
        {mode === 'diff' && ' Diff shows what each turn added to the context, against the turn before it. Below the line the context shrank.'}
      </p>

      <div className="rounded-xl border border-border bg-card p-3">
        <ContextChart
          series={series}
          marks={visibleMarks}
          band={band}
          mode={mode}
          xAxis={xAxis}
          height={320}
          onWindowChange={onWindowChange}
          onPointClick={onPointClick}
        />
      </div>

      {agentsLoading && <p className="text-xs text-muted-foreground">Loading the agent transcripts…</p>}

      {series.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {series.map(s => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block rounded-sm" style={{ background: s.color, height: s.emphasis ? 4 : 2.5, width: 16 }} />
              <span className={`max-w-64 truncate ${s.emphasis ? 'font-semibold' : 'text-muted-foreground'}`}>{s.label}</span>
            </span>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Context size is the whole prompt of each turn: input, cache read and cache write. The maximum comes from the model of that turn
        ({formatTokens(FALLBACK_CONTEXT_LIMIT)} when the model is unknown). Override a model in <code>~/.cc-lens/context.json</code>.
      </p>
    </div>
  )
}

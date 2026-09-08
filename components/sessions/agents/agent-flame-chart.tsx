'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import type { AgentRun, AgentOutcome, AgentTimeline, ContextEvent, ContextEventType } from '@/types/claude'
import { buildCompressedScale, clockTicks, formatClock, formatDayClock, type CompressedScale } from '@/lib/time-scale'
import { intersectsWindow, normalizeWindow, timelineIntervals, type TimeWindow } from '@/lib/time-window'
import { formatDurationMs, formatTokens } from '@/lib/decode'

export const OUTCOME_COLORS: Record<AgentOutcome, string> = {
  completed: '#5fb89a',
  failed:    '#e0824b',
  killed:    '#e0824b',
  running:   '#6b8be6',
  unknown:   '#8a93a3',
}
export const BUSY_COLOR = '#6b8be6'
export const TICK_COLOR = '#e0824b'
/** SendMessage calls received by an agent from its launcher */
export const NUDGE_COLOR = '#a78bfa'
export const BASE_COLOR = 'var(--muted)'
export const WINDOW_COLOR = 'var(--primary)'

export const CONTEXT_EVENT_STYLE: Record<ContextEventType, { color: string; glyph: string; label: string }> = {
  compact: { color: '#f59e0b', glyph: '⚡', label: 'Compaction' },
  clear:   { color: '#f87171', glyph: '⌫', label: 'Clear' },
  rewind:  { color: '#c084fc', glyph: '↶', label: 'Rewind' },
}

const ROW_HEIGHT = 32
export const GAP_THRESHOLD_MS = 30 * 60_000
const LABEL_WIDTH = 300
const DURATION_WIDTH = 72
const MARGIN = { top: 4, right: 8, bottom: 4, left: 8 }
/** Horizontal extent of the plot area inside the wrapper, derived from the fixed axis widths */
const PLOT_LEFT = MARGIN.left + LABEL_WIDTH
const PLOT_RIGHT = MARGIN.right + DURATION_WIDTH
const DRAG_MIN_PX = 5

export interface ChartRow {
  key: string
  label: string
  depth: number
  kind: 'orchestrator' | 'agent'
  agent?: AgentRun
  expandable: boolean
  expanded: boolean
  /** compressed x range of the bar */
  range: [number, number]
  /** compressed x pairs drawn on top of the base bar (orchestrator only) */
  segments: Array<[number, number]>
  /** compressed x of tick marks (prompts on the orchestrator, nudges on agents) */
  ticks: number[]
  color: string
  durationLabel: string
  startMs: number
  endMs: number
  /** outside the selected window */
  dim: boolean
}

interface Props {
  timeline: AgentTimeline
  expanded: Set<string>
  window: TimeWindow | null
  onToggle(agentId: string): void
  onSelect(agent: AgentRun): void
  onWindowChange(w: TimeWindow | null): void
}

const ms = (iso: string) => new Date(iso).getTime()

export function buildRows(
  timeline: AgentTimeline,
  expanded: Set<string>,
  scale: CompressedScale,
  win: TimeWindow | null,
): ChartRow[] {
  const rows: ChartRow[] = []
  const start = ms(timeline.start)
  const end = ms(timeline.end)

  const children = new Map<string, AgentRun[]>()
  for (const a of timeline.agents) {
    if (a.parent_id) children.set(a.parent_id, [...(children.get(a.parent_id) ?? []), a])
  }

  rows.push({
    key: '__orchestrator',
    label: 'Orchestrator',
    depth: 0,
    kind: 'orchestrator',
    expandable: false,
    expanded: false,
    range: [scale.toX(start), scale.toX(end)],
    segments: timeline.orchestrator.busy.map(s => [scale.toX(ms(s.start)), scale.toX(ms(s.end))]),
    ticks: timeline.orchestrator.prompts.map(p => scale.toX(ms(p.timestamp))),
    color: BUSY_COLOR,
    durationLabel: formatDurationMs(end - start),
    startMs: start,
    endMs: end,
    dim: false,
  })

  const push = (a: AgentRun, depth: number) => {
    const s = ms(a.start), e = ms(a.end)
    const kids = children.get(a.id) ?? []
    rows.push({
      key: a.id,
      label: a.description,
      depth,
      kind: 'agent',
      agent: a,
      expandable: kids.length > 0,
      expanded: expanded.has(a.id),
      range: [scale.toX(s), scale.toX(e)],
      segments: [],
      ticks: a.nudges.map(n => scale.toX(ms(n))),
      color: OUTCOME_COLORS[a.outcome],
      durationLabel: formatDurationMs(a.duration_ms),
      startMs: s,
      endMs: e,
      dim: !intersectsWindow(s, e, win),
    })
    if (expanded.has(a.id)) for (const k of kids) push(k, depth + 1)
  }
  for (const a of timeline.agents) if (!a.parent_id) push(a, 1)
  return rows
}

// ─── Custom pieces ───────────────────────────────────────────────────────────

interface ShapeCallbacks {
  onHover(row: ChartRow | null): void
  onRowClick(row: ChartRow): void
}

function makeRowShape(cb: ShapeCallbacks) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function RowShape(props: any) {
    const { x, y, width, height, payload, background } = props as {
      x: number; y: number; width: number; height: number; payload: ChartRow
      background?: { x: number; y: number; width: number; height: number }
    }
    if (!payload || !Number.isFinite(x)) return null
    const [x0, x1] = payload.range
    const span = Math.max(x1 - x0, 1)
    const px = width / span
    const barH = Math.max(6, height - 12)
    const barY = y + (height - barH) / 2
    const w = Math.max(width, 3)
    const toPx = (v: number) => x + (v - x0) * px
    const opacity = payload.dim ? 0.25 : 1
    const tickColor = payload.kind === 'orchestrator' ? TICK_COLOR : NUDGE_COLOR
    const running = payload.agent?.outcome === 'running'

    // The band owns hover and click for the whole row, so the tooltip can never
    // point at a different row than the one under the cursor.
    const band = background ?? { x, y, width, height }
    const enter = () => cb.onHover(payload)

    return (
      <g opacity={opacity} style={{ cursor: payload.kind === 'agent' ? 'pointer' : 'default' }}>
        <rect
          x={band.x} y={band.y} width={band.width} height={band.height} fill="transparent"
          onMouseEnter={enter} onMouseLeave={() => cb.onHover(null)}
          onClick={() => cb.onRowClick(payload)}
        />
        {payload.kind === 'orchestrator' && <rect x={x} y={barY} width={w} height={barH} rx={2} fill={BASE_COLOR} pointerEvents="none" />}
        {payload.kind === 'orchestrator'
          ? payload.segments.map(([s, e], i) => (
              <rect key={i} x={toPx(s)} y={barY} width={Math.max((e - s) * px, 2)} height={barH} fill={BUSY_COLOR} opacity={0.9} pointerEvents="none" />
            ))
          : <rect x={x} y={barY} width={w} height={barH} rx={2} fill={payload.color} className={running ? 'animate-pulse' : undefined} pointerEvents="none" />}
        {payload.ticks.map((t, i) => (
          <rect key={`t${i}`} x={toPx(t) - 1.5} y={barY - 3} width={3} height={barH + 6} fill={tickColor} pointerEvents="none" />
        ))}
      </g>
    )
  }
}

function makeRowTick(rowsByKey: Map<string, ChartRow>, onToggle: (id: string) => void, onSelect: (a: AgentRun) => void) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function RowTick(props: any) {
    const { x, y, payload } = props as { x: number; y: number; payload: { value: string } }
    const row = rowsByKey.get(payload.value)
    if (!row) return null
    const isOrch = row.kind === 'orchestrator'
    const failed = row.agent?.outcome === 'failed' || row.agent?.outcome === 'killed'
    const indent = Math.max(0, row.depth - 1) * 14
    const label = row.expandable ? `${row.label} · ${row.agent!.children_count}` : row.label
    const maxChars = Math.max(10, Math.floor((LABEL_WIDTH - 28 - indent) / 7.2))
    const shown = label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label
    // The label opens the agent; only the chevron expands or collapses its sub-agents
    const open = () => { if (row.agent) onSelect(row.agent) }
    const toggle = (e: React.MouseEvent) => { e.stopPropagation(); onToggle(row.key) }
    return (
      <g onClick={open} style={{ cursor: row.kind === 'agent' ? 'pointer' : 'default' }} opacity={row.dim ? 0.4 : 1}>
        <title>{label}</title>
        {row.expandable && (
          <g onClick={toggle} style={{ cursor: 'pointer' }}>
            <title>{row.expanded ? 'Collapse sub-agents' : 'Expand sub-agents'}</title>
            <rect x={x - 22 - measure(shown)} y={y - 10} width={20} height={20} fill="transparent" />
            <text x={x - 6 - measure(shown)} y={y} dy={4} textAnchor="end" fontSize={11} fill="var(--muted-foreground)">
              {row.expanded ? '▾' : '▸'}
            </text>
          </g>
        )}
        <text
          x={x - 6}
          y={y}
          dy={4}
          textAnchor="end"
          fontSize={isOrch ? 13 : 12}
          fontWeight={isOrch ? 600 : failed ? 600 : 400}
          fill={isOrch ? 'var(--foreground)' : failed ? TICK_COLOR : row.depth > 1 ? 'var(--muted-foreground)' : 'var(--foreground)'}
        >
          {shown}
        </text>
      </g>
    )
  }
}

/** Rough text width for the chevron offset */
function measure(text: string): number {
  return text.length * 7.2
}

function HoverCard({ row, left, top }: { row: ChartRow; left: number; top: number }) {
  const a = row.agent
  return (
    <div
      className="pointer-events-none absolute z-10 w-[270px] rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md"
      style={{ left, top }}
    >
      <div className="font-medium">{row.label}</div>
      <div className="text-muted-foreground tabular-nums">
        {formatDayClock(row.startMs)} → {formatClock(row.endMs)} · {row.durationLabel}
      </div>
      {a && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-muted-foreground">
          <span style={{ color: row.color }}>{a.outcome}</span>
          <span>{a.agent_type}{a.model ? ` · ${a.model}` : ''}</span>
          <span>{a.turns} turns</span>
          {a.nudges.length > 0 && <span style={{ color: NUDGE_COLOR }}>{a.nudges.length} message{a.nudges.length > 1 ? 's' : ''} from launcher</span>}
          {a.children_count > 0 && <span>{a.children_count} sub-agents</span>}
        </div>
      )}
      {!a && (
        <div className="mt-1 text-muted-foreground">
          {row.segments.length} active turns · {row.ticks.length} human prompts
        </div>
      )}
      {row.dim && <div className="mt-1 italic text-muted-foreground">Outside the selected window</div>}
    </div>
  )
}

export function describeContextEvent(e: ContextEvent): string {
  if (e.type === 'compact') {
    const parts: string[] = e.trigger ? [e.trigger] : []
    if (e.pre_tokens != null && e.post_tokens != null) parts.push(`${formatTokens(e.pre_tokens)} → ${formatTokens(e.post_tokens)} tokens`)
    if (e.duration_ms != null) parts.push(formatDurationMs(e.duration_ms))
    return parts.filter(Boolean).join(' · ')
  }
  if (e.type === 'rewind') return `${e.discarded_turns ?? 0} turn${e.discarded_turns === 1 ? '' : 's'} discarded`
  return 'conversation cleared'
}

// ─── Chart ───────────────────────────────────────────────────────────────────

export function AgentFlameChart({ timeline, expanded, window: win, onToggle, onSelect, onWindowChange }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [hoverRow, setHoverRow] = useState<ChartRow | null>(null)
  const [pointer, setPointer] = useState<{ left: number; top: number } | null>(null)
  const [drag, setDrag] = useState<{ start: number; current: number } | null>(null)
  const suppressClick = useRef(false)

  const scale = useMemo(() => {
    const intervals = timelineIntervals(timeline)
    // First pass to count the breaks, then size them so that all breaks
    // together take at most ~15% of the active width.
    const probe = buildCompressedScale(intervals, GAP_THRESHOLD_MS, 0)
    const active = probe.total
    const n = Math.max(1, probe.breaks.length)
    const gapWidth = Math.max(30_000, Math.min(active * 0.04, (active * 0.15) / n))
    return buildCompressedScale(intervals, GAP_THRESHOLD_MS, gapWidth)
  }, [timeline])

  const rows = useMemo(() => buildRows(timeline, expanded, scale, win), [timeline, expanded, scale, win])
  const rowsByKey = useMemo(() => new Map(rows.map(r => [r.key, r])), [rows])
  const ticks = useMemo(() => clockTicks(scale, 8), [scale])
  const tickLabel = useMemo(() => {
    // The first tick of each activity block carries the date, the rest only the clock
    const seen = new Set<number>()
    return new Map(ticks.map(t => {
      const block = scale.blocks.findIndex(b => t.time >= b.start && t.time <= b.end)
      const first = !seen.has(block)
      seen.add(block)
      return [t.x, first && scale.blocks.length > 1 ? formatDayClock(t.time) : formatClock(t.time)]
    }))
  }, [ticks, scale])

  const RowTick = useMemo(() => makeRowTick(rowsByKey, onToggle, onSelect), [rowsByKey, onToggle, onSelect])
  const RowShape = useMemo(() => makeRowShape({
    onHover: setHoverRow,
    onRowClick: row => { if (row.agent) onSelect(row.agent) },
  }), [onSelect])



  // ─── Drag to select a time window
  const pxToTime = useCallback((px: number, rect: DOMRect) => {
    const plotWidth = rect.width - PLOT_LEFT - PLOT_RIGHT
    const frac = Math.min(1, Math.max(0, (px - PLOT_LEFT) / plotWidth))
    return scale.toTime(frac * scale.total)
  }, [scale])

  // The hover card follows the pointer; the wrapper's own handler knows its rect
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    setPointer({
      left: Math.max(0, Math.min(px + 14, rect.width - 280)),
      top: e.clientY - rect.top + 14,
    })
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !wrapperRef.current) return
    const rect = wrapperRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    if (px < PLOT_LEFT || px > rect.width - PLOT_RIGHT) return
    setDrag({ start: px, current: px })
  }

  useEffect(() => {
    if (!drag) return
    const clampPx = (rect: DOMRect, clientX: number) => Math.min(rect.width - PLOT_RIGHT, Math.max(PLOT_LEFT, clientX - rect.left))
    const move = (e: MouseEvent) => {
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (!rect) return
      const px = clampPx(rect, e.clientX)
      setDrag(d => (d ? { ...d, current: px } : d))
      if (Math.abs(px - drag.start) >= DRAG_MIN_PX) suppressClick.current = true
    }
    const up = (e: MouseEvent) => {
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (rect) {
        const px = clampPx(rect, e.clientX)
        if (Math.abs(px - drag.start) >= DRAG_MIN_PX) {
          onWindowChange(normalizeWindow(pxToTime(drag.start, rect), pxToTime(px, rect)))
        }
      }
      setDrag(null)
      // Let the click that follows mouseup be swallowed, then re-enable
      setTimeout(() => { suppressClick.current = false }, 0)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [drag, onWindowChange, pxToTime])

  const height = rows.length * ROW_HEIGHT + 40
  // After a drag, swallow the click that follows mouseup so rows do not open
  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClick.current) { e.stopPropagation(); e.preventDefault() }
  }

  return (
    <div
      ref={wrapperRef}
      className="relative w-full select-none"
      style={{ height }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onClickCapture={onClickCapture}
      onMouseLeave={() => setHoverRow(null)}
    >
      <ChartBody rows={rows} rowsByKey={rowsByKey} scale={scale} ticks={ticks} tickLabel={tickLabel} win={win} events={timeline.context_events} RowTick={RowTick} RowShape={RowShape} />

      {drag && Math.abs(drag.current - drag.start) >= DRAG_MIN_PX && (
        <div
          className="pointer-events-none absolute inset-y-1 border-x border-primary bg-primary/15"
          style={{ left: Math.min(drag.start, drag.current), width: Math.abs(drag.current - drag.start) }}
        />
      )}
      {hoverRow && pointer && !drag && <HoverCard row={hoverRow} left={pointer.left} top={pointer.top} />}
    </div>
  )
}

interface ChartBodyProps {
  rows: ChartRow[]
  rowsByKey: Map<string, ChartRow>
  scale: CompressedScale
  ticks: ReturnType<typeof clockTicks>
  tickLabel: Map<number, string>
  win: TimeWindow | null
  events: ContextEvent[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RowTick: (props: any) => React.ReactElement | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RowShape: (props: any) => React.ReactElement | null
}

/** Memoized so that pointer tracking in the parent does not re-render Recharts */
const ChartBody = memo(function ChartBody({ rows, rowsByKey, scale, ticks, tickLabel, win, events, RowTick, RowShape }: ChartBodyProps) {
  return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart layout="vertical" data={rows} margin={MARGIN} barCategoryGap={0}>
          <XAxis
            type="number"
            domain={[0, scale.total]}
            ticks={ticks.map(t => t.x)}
            tickFormatter={(v: number) => tickLabel.get(v) ?? ''}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            axisLine={{ stroke: 'var(--border)' }}
            tickLine={{ stroke: 'var(--border)' }}
            allowDataOverflow
          />
          <YAxis yAxisId="left" type="category" dataKey="key" width={LABEL_WIDTH} interval={0} tick={RowTick} axisLine={false} tickLine={false} />
          <YAxis
            yAxisId="right"
            orientation="right"
            type="category"
            dataKey="key"
            width={DURATION_WIDTH}
            interval={0}
            tickFormatter={(k: string) => rowsByKey.get(k)?.durationLabel ?? ''}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'ui-monospace, monospace' }}
            axisLine={false}
            tickLine={false}
          />
          {scale.breaks.map((b, i) => (
            <ReferenceArea
              key={i}
              yAxisId="left"
              x1={b.x}
              x2={b.x + b.width}
              fill="var(--muted-foreground)"
              fillOpacity={0.08}
              stroke="var(--border)"
              strokeDasharray="3 3"
              label={{ value: '⋯', position: 'insideTop', fontSize: 11, fill: 'var(--muted-foreground)' }}
            />
          ))}
          {ticks.map(t => (
            <ReferenceArea key={`g${t.x}`} yAxisId="left" x1={t.x} x2={t.x} stroke="var(--border)" strokeOpacity={0.6} />
          ))}
          {win && (
            <ReferenceArea
              yAxisId="left"
              x1={scale.toX(win.from)}
              x2={scale.toX(win.to)}
              fill={WINDOW_COLOR}
              fillOpacity={0.1}
              stroke={WINDOW_COLOR}
              strokeOpacity={0.6}
            />
          )}
          {events.map(e => {
            const st = CONTEXT_EVENT_STYLE[e.type]
            return (
              <ReferenceLine
                key={e.uuid || e.timestamp}
                yAxisId="left"
                x={scale.toX(ms(e.timestamp))}
                stroke={st.color}
                strokeDasharray="4 3"
                strokeWidth={1.5}
                label={{ value: st.glyph, position: 'insideTopRight', fill: st.color, fontSize: 12 }}
              />
            )
          })}
          <Bar yAxisId="left" dataKey="range" shape={RowShape} background={{ fill: 'transparent' }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
  )
})

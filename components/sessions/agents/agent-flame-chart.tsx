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
/** extra right-column width per filter layer, for the counts */
const COUNT_WIDTH = 40
const MARGIN = { top: 4, right: 8, bottom: 4, left: 8 }
/** Horizontal extent of the plot area inside the wrapper, derived from the fixed axis widths */
const PLOT_LEFT = MARGIN.left + LABEL_WIDTH
const plotRight = (layerCount: number) => MARGIN.right + DURATION_WIDTH + Math.min(layerCount, 4) * COUNT_WIDTH
const DRAG_MIN_PX = 5

/** One search filter drawn as thin vertical bars on the rows */
export interface MarkLayer {
  key: string
  color: string
  /** match [start, end] times (ms) per agent id; '__orchestrator' for the orchestrator */
  byAgent: Map<string, Array<[number, number]>>
}

export interface RowMarks {
  color: string
  /** compressed x [start, end] of every drawn match, own and rolled-up */
  xs: Array<[number, number]>
  own: number
  /** matches of hidden (collapsed) descendants, rolled into this row */
  rolled: number
}

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
  /** one entry per filter layer */
  marks: RowMarks[]
}

interface Props {
  timeline: AgentTimeline
  expanded: Set<string>
  window: TimeWindow | null
  /** Show only the selected window, on a linear scale */
  zoom: boolean
  layers: MarkLayer[]
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
  zoom = false,
  layers: MarkLayer[] = [],
): ChartRow[] {
  const rows: ChartRow[] = []
  // In zoom mode every bar is clipped to the window and rows outside it are dropped
  const clip = zoom && win ? win : null
  const lo = clip ? clip.from : -Infinity
  const hi = clip ? clip.to : Infinity
  const clamp = (t: number) => Math.min(hi, Math.max(lo, t))
  const inside = (t: number) => t >= lo && t <= hi
  const clipSeg = ([a, b]: [number, number]): [number, number] | null =>
    b < lo || a > hi ? null : [clamp(a), clamp(b)]

  const start = clamp(ms(timeline.start))
  const end = clamp(ms(timeline.end))

  const children = new Map<string, AgentRun[]>()
  for (const a of timeline.agents) {
    if (a.parent_id) children.set(a.parent_id, [...(children.get(a.parent_id) ?? []), a])
  }
  const descendants = (id: string): string[] => (children.get(id) ?? []).flatMap(k => [k.id, ...descendants(k.id)])

  /** Marks of one row: its own matches, plus those of collapsed descendants */
  const marksFor = (agentKey: string, rolledIds: string[]): RowMarks[] =>
    layers.map(layer => {
      const own = (layer.byAgent.get(agentKey) ?? []).filter(([a]) => inside(a))
      const rolled = rolledIds.flatMap(id => layer.byAgent.get(id) ?? []).filter(([a]) => inside(a))
      return {
        color: layer.color,
        xs: [...own, ...rolled].map(([a, b]) => [scale.toX(clamp(a)), scale.toX(clamp(b))] as [number, number]),
        own: own.length,
        rolled: rolled.length,
      }
    })

  rows.push({
    key: '__orchestrator',
    label: 'Orchestrator',
    depth: 0,
    kind: 'orchestrator',
    expandable: false,
    expanded: false,
    range: [scale.toX(start), scale.toX(end)],
    segments: timeline.orchestrator.busy
      .map(s => clipSeg([ms(s.start), ms(s.end)]))
      .filter((x): x is [number, number] => !!x)
      .map(([a, b]) => [scale.toX(a), scale.toX(b)]),
    ticks: timeline.orchestrator.prompts.map(p => ms(p.timestamp)).filter(inside).map(t => scale.toX(t)),
    color: BUSY_COLOR,
    durationLabel: formatDurationMs(end - start),
    startMs: start,
    endMs: end,
    dim: false,
    marks: marksFor('__orchestrator', []),
  })

  const push = (a: AgentRun, depth: number) => {
    const s0 = ms(a.start), e0 = ms(a.end)
    if (clip && !intersectsWindow(s0, e0, clip)) return
    const s = clamp(s0), e = clamp(e0)
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
      ticks: a.nudges.map(n => ms(n)).filter(inside).map(t => scale.toX(t)),
      color: OUTCOME_COLORS[a.outcome],
      durationLabel: formatDurationMs(a.duration_ms),
      startMs: s0,
      endMs: e0,
      dim: !clip && !intersectsWindow(s0, e0, win),
      marks: marksFor(a.id, expanded.has(a.id) ? [] : descendants(a.id)),
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
        {payload.marks.map((m, li) =>
          m.xs.map(([a, b], i) => {
            // The bar spans the call to its result; a call with no result stays 1px
            const wpx = Math.max(1, (b - a) * px)
            return <rect key={`m${li}-${i}`} x={toPx(a) - (wpx <= 1 ? 0.5 : 0)} y={y + 1} width={wpx} height={height - 2} fill={m.color} opacity={0.55} pointerEvents="none" />
          }),
        )}
      </g>
    )
  }
}

/** Right column: duration, then one colored count per filter layer */
function makeRightTick(rowsByKey: Map<string, ChartRow>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function RightTick(props: any) {
    const { x, y, payload } = props as { x: number; y: number; payload: { value: string } }
    const row = rowsByKey.get(payload.value)
    if (!row) return null
    return (
      <g opacity={row.dim ? 0.4 : 1}>
        <text x={x + 6} y={y} dy={4} fontSize={11} fill="var(--muted-foreground)" fontFamily="ui-monospace, monospace">
          {row.durationLabel}
        </text>
        {row.marks.slice(0, 4).map((m, i) => {
          const total = m.own + m.rolled
          return (
            <text key={i} x={x + DURATION_WIDTH + i * COUNT_WIDTH} y={y} dy={4} fontSize={11} fontFamily="ui-monospace, monospace" fill={total ? m.color : 'var(--muted-foreground)'} opacity={total ? 1 : 0.35}>
              {m.rolled ? `${m.own}+${m.rolled}` : String(total)}
            </text>
          )
        })}
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

function formatClockSeconds(time: number): string {
  const d = new Date(time)
  return `${formatDayClock(time)}:${String(d.getSeconds()).padStart(2, '0')}`
}

function HoverCard({ row, left, top, cursorTime }: { row: ChartRow; left: number; top: number; cursorTime: number | null }) {
  const a = row.agent
  return (
    <div
      className="pointer-events-none absolute z-10 w-[270px] rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md"
      style={{ left, top }}
    >
      {cursorTime != null && (
        <div className="mb-1 font-mono text-[11px] tabular-nums text-primary">{formatClockSeconds(cursorTime)}</div>
      )}
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
      {row.marks.some(m => m.own + m.rolled > 0) && (
        <div className="mt-1 flex flex-wrap gap-x-3">
          {row.marks.map((m, i) => (m.own + m.rolled > 0) && (
            <span key={i} style={{ color: m.color }}>{m.own + m.rolled} match{m.own + m.rolled > 1 ? 'es' : ''}{m.rolled ? ` (${m.rolled} in sub-agents)` : ''}</span>
          ))}
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

export function AgentFlameChart({ timeline, expanded, window: win, zoom, layers, onToggle, onSelect, onWindowChange }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [hoverRow, setHoverRow] = useState<ChartRow | null>(null)
  const [pointer, setPointer] = useState<{ left: number; top: number } | null>(null)
  /** Vertical cursor: pixel x inside the wrapper and the time it points at */
  const [cursor, setCursor] = useState<{ px: number; time: number } | null>(null)
  const [drag, setDrag] = useState<{ start: number; current: number } | null>(null)
  const suppressClick = useRef(false)

  const zoomed = zoom && !!win
  const scale = useMemo(() => {
    // Zoomed: a plain linear scale over the window
    if (zoomed && win) return buildCompressedScale([{ start: win.from, end: win.to }], GAP_THRESHOLD_MS, 0)
    const intervals = timelineIntervals(timeline)
    // First pass to count the breaks, then size them so that all breaks
    // together take at most ~15% of the active width.
    const probe = buildCompressedScale(intervals, GAP_THRESHOLD_MS, 0)
    const active = probe.total
    const n = Math.max(1, probe.breaks.length)
    const gapWidth = Math.max(30_000, Math.min(active * 0.04, (active * 0.15) / n))
    return buildCompressedScale(intervals, GAP_THRESHOLD_MS, gapWidth)
  }, [timeline, zoomed, win])

  const rows = useMemo(() => buildRows(timeline, expanded, scale, win, zoomed, layers), [timeline, expanded, scale, win, zoomed, layers])
  const rightWidth = DURATION_WIDTH + Math.min(layers.length, 4) * COUNT_WIDTH
  const PLOT_RIGHT = plotRight(layers.length)
  const events = useMemo(
    () => (zoomed && win ? timeline.context_events.filter(e => { const t = ms(e.timestamp); return t >= win.from && t <= win.to }) : timeline.context_events),
    [timeline, zoomed, win],
  )
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
  const RightTick = useMemo(() => makeRightTick(rowsByKey), [rowsByKey])
  const RowShape = useMemo(() => makeRowShape({
    onHover: setHoverRow,
    onRowClick: row => { if (row.agent) onSelect(row.agent) },
  }), [onSelect])



  // ─── Drag to select a time window
  const pxToTime = useCallback((px: number, rect: DOMRect) => {
    const plotWidth = rect.width - PLOT_LEFT - PLOT_RIGHT
    const frac = Math.min(1, Math.max(0, (px - PLOT_LEFT) / plotWidth))
    return scale.toTime(frac * scale.total)
  }, [scale, PLOT_RIGHT])

  // The hover card and the cursor follow the pointer; the wrapper's own handler knows its rect
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    setPointer({
      left: Math.max(0, Math.min(px + 14, rect.width - 280)),
      top: e.clientY - rect.top + 14,
    })
    if (px >= PLOT_LEFT && px <= rect.width - PLOT_RIGHT) setCursor({ px, time: pxToTime(px, rect) })
    else setCursor(null)
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
  }, [drag, onWindowChange, pxToTime, PLOT_RIGHT])

  const height = rows.length * ROW_HEIGHT + 40
  // After a drag, swallow the click that follows mouseup so rows do not open
  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClick.current) { e.stopPropagation(); e.preventDefault() }
  }

  return (
    <div
      ref={wrapperRef}
      className="relative w-full select-none [&_.recharts-wrapper]:outline-none [&_.recharts-wrapper_*]:outline-none"
      style={{ height }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onClickCapture={onClickCapture}
      onMouseLeave={() => { setHoverRow(null); setCursor(null) }}
    >
      <ChartBody rows={rows} scale={scale} ticks={ticks} tickLabel={tickLabel} win={zoomed ? null : win} events={events} RowTick={RowTick} RightTick={RightTick} RowShape={RowShape} rightWidth={rightWidth} />

      {drag && Math.abs(drag.current - drag.start) >= DRAG_MIN_PX && (
        <div
          className="pointer-events-none absolute inset-y-1 border-x border-primary bg-primary/15"
          style={{ left: Math.min(drag.start, drag.current), width: Math.abs(drag.current - drag.start) }}
        />
      )}
      {cursor && !drag && (
        <div className="pointer-events-none absolute inset-y-1 w-px bg-primary/70" style={{ left: cursor.px }}>
          <span className="absolute -top-0.5 left-1 rounded bg-popover px-1 font-mono text-[10px] tabular-nums text-primary">
            {formatClock(cursor.time)}
          </span>
        </div>
      )}
      {hoverRow && pointer && !drag && <HoverCard row={hoverRow} left={pointer.left} top={pointer.top} cursorTime={cursor?.time ?? null} />}
    </div>
  )
}

interface ChartBodyProps {
  rows: ChartRow[]
  scale: CompressedScale
  rightWidth: number
  ticks: ReturnType<typeof clockTicks>
  tickLabel: Map<number, string>
  win: TimeWindow | null
  events: ContextEvent[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RowTick: (props: any) => React.ReactElement | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RowShape: (props: any) => React.ReactElement | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RightTick: (props: any) => React.ReactElement | null
}

/** Memoized so that pointer tracking in the parent does not re-render Recharts */
const ChartBody = memo(function ChartBody({ rows, scale, ticks, tickLabel, win, events, RowTick, RightTick, RowShape, rightWidth }: ChartBodyProps) {
  return (
      <ResponsiveContainer width="100%" height="100%">
        {/* accessibilityLayer off: no focus outline or keyboard tooltip on click, hover is handled by the rows */}
        <ComposedChart layout="vertical" data={rows} margin={MARGIN} barCategoryGap={0} accessibilityLayer={false}>
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
            width={rightWidth}
            interval={0}
            tick={RightTick}
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

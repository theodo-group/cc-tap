'use client'

import { useMemo } from 'react'
import {
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceArea,
  ResponsiveContainer,
} from 'recharts'
import type { AgentRun, AgentOutcome, AgentTimeline } from '@/types/claude'
import { buildCompressedScale, clockTicks, formatClock, formatDayClock, type CompressedScale } from '@/lib/time-scale'
import { formatDurationMs } from '@/lib/decode'

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

const ROW_HEIGHT = 32
const GAP_THRESHOLD_MS = 30 * 60_000
const LABEL_WIDTH = 300
const DURATION_WIDTH = 72

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
  /** compressed x of orange tick marks */
  ticks: number[]
  color: string
  durationLabel: string
  startMs: number
  endMs: number
}

interface Props {
  timeline: AgentTimeline
  expanded: Set<string>
  onToggle(agentId: string): void
  onSelect(agent: AgentRun): void
}

const ms = (iso: string) => new Date(iso).getTime()

export function buildRows(timeline: AgentTimeline, expanded: Set<string>, scale: CompressedScale): ChartRow[] {
  const rows: ChartRow[] = []
  const start = ms(timeline.start)
  const end = ms(timeline.end)

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
  })

  const children = new Map<string, AgentRun[]>()
  for (const a of timeline.agents) {
    if (a.parent_id) children.set(a.parent_id, [...(children.get(a.parent_id) ?? []), a])
  }

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
    })
    if (expanded.has(a.id)) for (const k of kids) push(k, depth + 1)
  }
  for (const a of timeline.agents) if (!a.parent_id) push(a, 1)
  return rows
}

// ─── Custom pieces ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RowShape(props: any) {
  const { x, y, width, height, payload } = props as { x: number; y: number; width: number; height: number; payload: ChartRow }
  if (!payload || !Number.isFinite(x)) return null
  const [x0, x1] = payload.range
  const span = Math.max(x1 - x0, 1)
  const px = width / span
  const barH = Math.max(6, height - 12)
  const barY = y + (height - barH) / 2
  const w = Math.max(width, 3)
  const toPx = (v: number) => x + (v - x0) * px

  if (payload.kind === 'orchestrator') {
    return (
      <g>
        <rect x={x} y={barY} width={w} height={barH} rx={2} fill={BASE_COLOR} />
        {payload.segments.map(([s, e], i) => (
          <rect key={i} x={toPx(s)} y={barY} width={Math.max((e - s) * px, 2)} height={barH} fill={BUSY_COLOR} opacity={0.9} />
        ))}
        {payload.ticks.map((t, i) => (
          <rect key={`t${i}`} x={toPx(t) - 1.5} y={barY - 3} width={3} height={barH + 6} fill={TICK_COLOR} />
        ))}
      </g>
    )
  }

  const running = payload.agent?.outcome === 'running'
  return (
    <g style={{ cursor: 'pointer' }}>
      <rect x={x} y={barY} width={w} height={barH} rx={2} fill={payload.color} className={running ? 'animate-pulse' : undefined} />
      {payload.ticks.map((t, i) => (
        <rect key={`t${i}`} x={toPx(t) - 1.5} y={barY - 3} width={3} height={barH + 6} fill={NUDGE_COLOR} />
      ))}
    </g>
  )
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
      <g onClick={open} style={{ cursor: row.kind === 'agent' ? 'pointer' : 'default' }}>
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload as ChartRow
  const a = row.agent
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
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
    </div>
  )
}

// ─── Chart ───────────────────────────────────────────────────────────────────

export function AgentFlameChart({ timeline, expanded, onToggle, onSelect }: Props) {
  const scale = useMemo(() => {
    const intervals = [
      ...timeline.orchestrator.busy.map(s => ({ start: ms(s.start), end: ms(s.end) })),
      ...timeline.orchestrator.prompts.map(p => ({ start: ms(p.timestamp), end: ms(p.timestamp) + 60_000 })),
      ...timeline.agents.map(a => ({ start: ms(a.start), end: ms(a.end) })),
    ]
    // First pass to count the breaks, then size them so that all breaks
    // together take at most ~15% of the active width.
    const probe = buildCompressedScale(intervals, GAP_THRESHOLD_MS, 0)
    const active = probe.total
    const n = Math.max(1, probe.breaks.length)
    const gapWidth = Math.max(30_000, Math.min(active * 0.04, (active * 0.15) / n))
    return buildCompressedScale(intervals, GAP_THRESHOLD_MS, gapWidth)
  }, [timeline])

  const rows = useMemo(() => buildRows(timeline, expanded, scale), [timeline, expanded, scale])
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

  const height = rows.length * ROW_HEIGHT + 40

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          layout="vertical"
          data={rows}
          margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
          barCategoryGap={0}
        >
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
          <YAxis
            yAxisId="left"
            type="category"
            dataKey="key"
            width={LABEL_WIDTH}
            interval={0}
            tick={RowTick}
            axisLine={false}
            tickLine={false}
          />
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
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--muted)', fillOpacity: 0.35 }} isAnimationActive={false} />
          <Bar
            yAxisId="left"
            dataKey="range"
            shape={<RowShape />}
            isAnimationActive={false}
            onClick={(_data, index) => {
              const row = rows[index]
              if (row?.agent) onSelect(row.agent)
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

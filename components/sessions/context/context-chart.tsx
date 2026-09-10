'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
} from 'recharts'
import { formatTokens } from '@/lib/decode'
import { formatClock, formatDayClock } from '@/lib/time-scale'
import { normalizeWindow, type TimeWindow } from '@/lib/time-window'
import { deltaPoints, type AutocompactBand, type ContextMark, type ContextPoint } from '@/lib/context-series'

export type ContextMode = 'tokens' | 'pct' | 'diff'
export type ContextAxis = 'turn' | 'time'

export interface ContextSeries {
  key: string
  label: string
  color: string
  points: ContextPoint[]
  /** The main thread: drawn last, so no agent curve can cover it, and thicker */
  emphasis?: boolean
}

interface Props {
  series: ContextSeries[]
  marks?: ContextMark[]
  band?: AutocompactBand | null
  mode: ContextMode
  xAxis: ContextAxis
  height?: number
  /** A drag across the plot selects a time window; absent disables the drag */
  onWindowChange?(w: TimeWindow | null): void
  /** A click on the plot opens the nearest point */
  onPointClick?(seriesKey: string, point: ContextPoint): void
}

// Plot geometry, needed to turn a pixel into an axis value. Recharts puts the
// plot area at margin.left + the Y axis width.
const MARGIN = { top: 8, right: 12, bottom: 16, left: 0 }
// Wide enough for a 13px mono "−280.0K": globals.css forces .recharts-text to
// 13px app-wide, so the `tick` font size below never applies.
const Y_WIDTH = 74
const PLOT_LEFT = MARGIN.left + Y_WIDTH
const PLOT_RIGHT = MARGIN.right
/** Set on the X axis, so the plot's bottom edge is known and a pixel maps to a value */
const X_HEIGHT = 30
const PLOT_TOP = MARGIN.top
/** Below this a drag counts as a click */
const DRAG_MIN_PX = 6

/** A round upper bound, so an explicit Y domain still reads well on the axis */
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / (mag / 2)) * (mag / 2)
}

const niceFloor = (v: number): number => (v >= 0 ? 0 : -niceCeil(-v))

/** Every diff bar at one x, drawn by a single shape.
 *
 *  Recharts sizes a bar from its axis band, and a continuous axis has none, so
 *  a bar comes back about a pixel wide whatever barSize says. Its own grouping
 *  is no help either: side by side, each series takes a share of a band that is
 *  already only a few pixels, and with three or four agents nothing is left to
 *  see. So the bars share one x and one full width, and the shape paints them
 *  tallest first — a shorter bar lands in front of a taller one, and both stay
 *  readable.
 *
 *  The row carries `__scale`, the largest magnitude at that x, so Recharts
 *  computes a real y and height for it; every other bar is measured against
 *  that one. */
function makeDiffBars(width: number, series: ReadonlyArray<{ key: string; color: string; emphasis?: boolean }>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function DiffBars(props: any) {
    const { x = 0, width: slot = 0, y = 0, height = 0, payload } = props
    const scale = payload?.__scale ?? 0
    if (!scale || !height) return null
    const pxPerUnit = height / scale
    const zero = y + height
    const left = x + slot / 2 - width / 2
    const bars = series
      .map(s => ({ s, v: payload[s.key] as number | undefined }))
      .filter((b): b is { s: typeof series[number]; v: number } => typeof b.v === 'number')
      // Tallest to the back. On a tie the main thread wins the front.
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || Number(!!a.s.emphasis) - Number(!!b.s.emphasis))
    return (
      <g>
        {bars.map(({ s, v }) => {
          const h = Math.max(Math.abs(v) * pxPerUnit, 1)
          return <rect key={s.key} x={left} y={v >= 0 ? zero - h : zero} width={width} height={h} fill={s.color} />
        })}
      </g>
    )
  }
}

/** formatTokens has no branch for a negative, so a delta needs its own sign */
const formatDelta = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatTokens(Math.abs(n))}`

type Row = ContextPoint & { x: number; y: number; delta?: number }

const toRows = (points: ContextPoint[], mode: ContextMode, xAxis: ContextAxis): Row[] => {
  const at = (p: ContextPoint) => (xAxis === 'turn' ? p.turn : p.time)
  if (mode === 'diff') return deltaPoints(points).map(p => ({ ...p, x: at(p), y: p.delta }))
  return points.map(p => ({ ...p, x: at(p), y: mode === 'pct' ? p.pct : p.tokens }))
}

/** What one row reads as, in the mode on show */
const rowValue = (row: Row, mode: ContextMode): string =>
  mode === 'pct' ? `${row.pct.toFixed(1)}%` : mode === 'diff' ? formatDelta(row.delta ?? 0) : formatTokens(row.tokens)

function HoverCard({ rows, mode, xAxis, leadKey }: { rows: Array<{ key: string; row: Row; label: string; color: string; emphasis?: boolean }>; mode: ContextMode; xAxis: ContextAxis; leadKey?: string }) {
  if (rows.length === 0) return null
  const ordered = [...rows].sort((a, b) => Number(!!b.emphasis) - Number(!!a.emphasis))
  const first = (rows.find(r => r.key === leadKey) ?? ordered[0]).row
  return (
    <div className="rounded border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {xAxis === 'turn' ? `Turn ${first.turn}` : formatDayClock(first.time)}
      </div>
      {ordered.map(({ key, row, label, color, emphasis }) => {
        // The curve a click would open, so the reader can aim before clicking
        const lead = key === leadKey
        return (
          <div key={key} className={`flex items-baseline gap-2 ${lead || emphasis ? 'font-semibold text-foreground' : 'opacity-70'}`}>
            <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: color, outline: lead ? '1px solid var(--foreground)' : undefined, outlineOffset: 1 }} />
            <span className="max-w-40 truncate">{label}</span>
            <span className="ml-auto tabular-nums">{rowValue(row, mode)}</span>
          </div>
        )
      })}
      {mode === 'pct' && <div className="mt-1 text-[10px] text-muted-foreground">of {formatTokens(first.limit)}</div>}
      {mode === 'diff' && <div className="mt-1 text-[10px] text-muted-foreground">context now {formatTokens(first.tokens)}</div>}
    </div>
  )
}

export function ContextChart({ series, marks = [], band, mode, xAxis, height = 220, onWindowChange, onPointClick }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  /** Both the pixel (to draw the band and to tell a drag from a click) and the axis value (to make the window) */
  const [drag, setDrag] = useState<{ startPx: number; startX: number; currentPx: number; currentX: number } | null>(null)
  /** Width of the plot area. A bar on a continuous axis has no band to size
   *  against, so Recharts gives it none, and it must be measured instead. */
  const [plotWidth, setPlotWidth] = useState(0)
  /** Vertical cursor: the pixel under the pointer, and the points it picks out */
  const [cursor, setCursor] = useState<{
    px: number
    width: number
    label: string
    leadKey: string
    /** Pixel of the point a click would open, so it can be marked */
    dot: { px: number; py: number; color: string } | null
    rows: Array<{ key: string; row: Row; label: string; color: string }>
  } | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => {
    const el = wrapperRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setPlotWidth(Math.max(0, e.contentRect.width - PLOT_LEFT - PLOT_RIGHT)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowsBySeries = useMemo(
    () => series.map(s => ({ ...s, rows: toRows(s.points, mode, xAxis) })),
    [series, mode, xAxis],
  )
  const allRows = useMemo(() => rowsBySeries.flatMap(s => s.rows), [rowsBySeries])

  // A cursor is a snapshot of what was under the pointer. Once the curves,
  // the mode or the axis change it describes a chart that is no longer there,
  // so it goes rather than lingering until the next move.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCursor(null)
  }, [rowsBySeries, mode, xAxis])


  /** Bars read from one shared dataset: a row per x, a column per series.
   *  Unlike Line, Bar carries no data of its own. */
  const barData = useMemo(() => {
    if (mode !== 'diff') return undefined
    const byX = new Map<number, Record<string, number>>()
    for (const s of rowsBySeries) {
      for (const r of s.rows) {
        const row = byX.get(r.x) ?? { x: r.x, __scale: 0 }
        row[s.key] = r.y
        row.__scale = Math.max(row.__scale, Math.abs(r.y))
        byX.set(r.x, row)
      }
    }
    return [...byX.values()].sort((a, b) => a.x - b.x)
  }, [rowsBySeries, mode])

  /** As wide as one turn allows. The width is not shared between series: they
   *  overlap rather than stand side by side, so a fourth agent costs nothing. */
  const diffBars = useMemo(() => {
    const rows = barData?.length ?? 0
    const per = rows && plotWidth ? Math.floor(plotWidth / rows) : 3
    return makeDiffBars(Math.max(1, Math.min(10, per > 2 ? per - 1 : per)), rowsBySeries)
  }, [barData, plotWidth, rowsBySeries])

  const yDomain = useMemo<[number, number]>(() => {
    if (mode === 'pct') return [0, 100]
    const max = allRows.reduce((m, r) => Math.max(m, r.y), 0)
    const min = allRows.reduce((m, r) => Math.min(m, r.y), 0)
    // A diff that goes both ways reads best around a centred zero
    if (min < 0) { const m = niceCeil(Math.max(-min, max) || 1); return [-m, m] }
    return [niceFloor(min), niceCeil(max || 1)]
  }, [allRows, mode])

  const domain = useMemo<[number, number] | null>(() => {
    if (allRows.length === 0) return null
    const xs = allRows.map(r => r.x)
    const min = Math.min(...xs)
    const max = Math.max(...xs)
    return min === max ? [min - 1, max + 1] : [min, max]
  }, [allRows])

  // ─── Pixel → axis value, shared by the drag selection and the click
  const pxToX = useCallback((px: number, rect: DOMRect) => {
    if (!domain) return 0
    const plotWidth = Math.max(1, rect.width - PLOT_LEFT - PLOT_RIGHT)
    const frac = Math.min(1, Math.max(0, (px - PLOT_LEFT) / plotWidth))
    return domain[0] + frac * (domain[1] - domain[0])
  }, [domain])

  const xToPx = useCallback((x: number, rect: DOMRect) => {
    if (!domain) return PLOT_LEFT
    const plotWidth = Math.max(1, rect.width - PLOT_LEFT - PLOT_RIGHT)
    return PLOT_LEFT + ((x - domain[0]) / Math.max(1e-9, domain[1] - domain[0])) * plotWidth
  }, [domain])

  const yToPy = useCallback((y: number, rect: DOMRect) => {
    const plotHeight = Math.max(1, rect.height - PLOT_TOP - MARGIN.bottom - X_HEIGHT)
    return PLOT_TOP + (1 - (y - yDomain[0]) / Math.max(1e-9, yDomain[1] - yDomain[0])) * plotHeight
  }, [yDomain])

  const pyToY = useCallback((py: number, rect: DOMRect) => {
    const plotHeight = Math.max(1, rect.height - PLOT_TOP - MARGIN.bottom - X_HEIGHT)
    const frac = Math.min(1, Math.max(0, (py - PLOT_TOP) / plotHeight))
    return yDomain[1] - frac * (yDomain[1] - yDomain[0])
  }, [yDomain])

  /** Each series' point closest to an axis value, one per curve.
   *  A curve only counts where it is actually drawn: an agent that ran for ten
   *  turns must not be selectable three hundred turns later, however close its
   *  last point sits to the pointer. Outside every span, nothing is drawn, so
   *  the plain closest point is the only answer left. */
  const candidates = useCallback((x: number) => {
    const all = rowsBySeries
      .map(s => {
        const row = s.rows.reduce<Row | null>((best, r) => (!best || Math.abs(r.x - x) < Math.abs(best.x - x) ? r : best), null)
        if (!row) return null
        const spans = x >= s.rows[0].x && x <= s.rows[s.rows.length - 1].x
        return { key: s.key, row, label: s.label, color: s.color, emphasis: s.emphasis, spans }
      })
      .filter(Boolean) as Array<{ key: string; row: Row; label: string; color: string; emphasis?: boolean; spans: boolean }>
    const within = all.filter(c => c.spans)
    return within.length > 0 ? within : all
  }, [rowsBySeries])

  /** The curve to act on: of each series' closest point in x, the one closest
   *  in y to the pointer. Picking on x alone made a crowded chart impossible to
   *  aim at, because whichever curve happened to have a point nearby always won. */
  const nearest = useCallback((x: number, y?: number) => {
    const cands = candidates(x)
    if (cands.length === 0) return null
    if (y === undefined || cands.length === 1) {
      return cands.reduce((best, c) => (Math.abs(c.row.x - x) < Math.abs(best.row.x - x) ? c : best))
    }
    return cands.reduce((best, c) => (Math.abs(c.row.y - y) < Math.abs(best.row.y - y) ? c : best))
  }, [candidates])

  /** A drag always gives a time window, whichever axis is on show */
  const xToTime = useCallback((x: number) => {
    if (xAxis === 'time') return x
    const n = nearest(x)
    return n ? n.row.time : x
  }, [xAxis, nearest])

  const onMouseDown = (e: React.MouseEvent) => {
    if (!onWindowChange || e.button !== 0 || !wrapperRef.current) return
    const rect = wrapperRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    if (px < PLOT_LEFT || px > rect.width - PLOT_RIGHT) return
    const x = pxToX(px, rect)
    setDrag({ startPx: px, startX: x, currentPx: px, currentX: x })
  }

  useEffect(() => {
    if (!drag || !onWindowChange) return
    const clampPx = (rect: DOMRect, clientX: number) =>
      Math.min(rect.width - PLOT_RIGHT, Math.max(PLOT_LEFT, clientX - rect.left))
    const move = (e: MouseEvent) => {
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (!rect) return
      const px = clampPx(rect, e.clientX)
      setDrag(d => (d ? { ...d, currentPx: px, currentX: pxToX(px, rect) } : d))
      if (Math.abs(px - drag.startPx) >= DRAG_MIN_PX) suppressClick.current = true
    }
    const up = (e: MouseEvent) => {
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (rect) {
        const px = clampPx(rect, e.clientX)
        if (Math.abs(px - drag.startPx) >= DRAG_MIN_PX) {
          onWindowChange(normalizeWindow(xToTime(drag.startX), xToTime(pxToX(px, rect))))
        }
      }
      setDrag(null)
      // Let the click that follows mouseup be swallowed, then re-enable
      setTimeout(() => { suppressClick.current = false }, 0)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [drag, onWindowChange, pxToX, xToTime])

  /** The vertical cursor follows the pointer, as it does on the Agents chart.
   *  It reads the same nearest-point rule the click uses, so what you hover is
   *  what you open. */
  const onMouseMove = (e: React.MouseEvent) => {
    if (!wrapperRef.current) return
    const rect = wrapperRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    if (px < PLOT_LEFT || px > rect.width - PLOT_RIGHT) { setCursor(null); return }
    const x = pxToX(px, rect)
    const rows = candidates(x)
    const lead = nearest(x, pyToY(py, rect))
    setCursor({
      px,
      width: rect.width,
      label: xAxis === 'turn' ? (lead ? `Turn ${lead.row.turn}` : '') : formatClock(x),
      leadKey: lead?.key ?? '',
      dot: lead ? { px: xToPx(lead.row.x, rect), py: yToPy(lead.row.y, rect), color: lead.color } : null,
      rows,
    })
  }

  const onClick = (e: React.MouseEvent) => {
    if (suppressClick.current || !onPointClick || !wrapperRef.current) return
    const rect = wrapperRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    if (px < PLOT_LEFT || px > rect.width - PLOT_RIGHT) return
    const n = nearest(pxToX(px, rect), pyToY(e.clientY - rect.top, rect))
    if (n) onPointClick(n.key, n.row)
  }

  if (!domain) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No turn carries a context reading here.</p>
  }

  const bandFrom = band ? (mode === 'pct' ? band.fromPct : band.fromTokens) : 0
  const bandTo = band ? (mode === 'pct' ? band.toPct : band.toTokens) : 0

  return (
    <div
      ref={wrapperRef}
      className="relative w-full select-none [&_.recharts-wrapper]:outline-none [&_.recharts-wrapper_*]:outline-none"
      style={{ height, cursor: onPointClick ? 'pointer' : 'default' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setCursor(null)}
      onClick={onClick}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={barData} margin={MARGIN} barCategoryGap={0} barGap={0}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            type="number"
            dataKey="x"
            domain={domain}
            allowDataOverflow
            tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => (xAxis === 'turn' ? String(Math.round(v)) : formatClock(v))}
            height={X_HEIGHT}
          />
          <YAxis
            type="number"
            width={Y_WIDTH}
            domain={yDomain}
            tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => (mode === 'pct' ? `${Math.round(v)}%` : mode === 'diff' ? formatDelta(v) : formatTokens(v))}
          />

          {/* Where this session actually compacted, measured from its own logs */}
          {band && mode === 'pct' && (
            bandFrom === bandTo
              ? <ReferenceLine y={bandFrom} stroke="#f59e0b" strokeDasharray="6 3" label={{ value: 'autocompact', position: 'insideTopLeft', fontSize: 9, fill: '#f59e0b' }} />
              : <ReferenceArea y1={bandFrom} y2={bandTo} fill="#f59e0b" fillOpacity={0.12} stroke="#f59e0b" strokeOpacity={0.35} strokeDasharray="4 2" label={{ value: 'autocompact', position: 'insideTopLeft', fontSize: 9, fill: '#f59e0b' }} />
          )}

          {mode === 'pct' && <ReferenceLine y={100} stroke="#ef4444" strokeDasharray="4 2" />}
          {mode === 'diff' && <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeOpacity={0.6} />}

          {marks.map(m => (
            <ReferenceLine
              key={m.uuid || `${m.turn}`}
              x={xAxis === 'turn' ? m.turn : m.time}
              stroke="#f59e0b"
              strokeDasharray="4 2"
              label={{ value: '⚡', position: 'top', fontSize: 12 }}
            />
          ))}

          {/* A delta belongs to its turn: it is not a value that varies between
              two turns, so nothing may be drawn between them. Bars from the
              zero line say that, and leave an interruption empty. One Bar
              carries every series, so the shape can order them per turn. */}
          {mode === 'diff' && (
            <Bar dataKey="__scale" shape={diffBars} isAnimationActive={false} />
          )}

          {/* An emphasised curve is drawn last, so it sits above every other one */}
          {mode !== 'diff' && [...rowsBySeries].sort((a, b) => Number(!!a.emphasis) - Number(!!b.emphasis)).map(s => (
            <Line
              key={s.key}
              name={s.key}
              data={s.rows}
              dataKey="y"
              // linear, not monotone: with points hours apart the smoothing
              // draws a gentle curve through empty time, which reads as data.
              // Where points are dense the two are indistinguishable.
              type="linear"
              stroke={s.color}
              strokeWidth={s.emphasis ? 2.5 : 1.5}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          ))}

        </ComposedChart>
      </ResponsiveContainer>

      {drag && Math.abs(drag.currentPx - drag.startPx) >= DRAG_MIN_PX && (
        <div
          className="pointer-events-none absolute inset-y-1 border-x border-primary bg-primary/15"
          style={{ left: Math.min(drag.startPx, drag.currentPx), width: Math.abs(drag.currentPx - drag.startPx) }}
        />
      )}
      {cursor && !drag && onPointClick && (
        <div className="pointer-events-none absolute inset-y-1 w-px bg-primary/70" style={{ left: cursor.px }}>
          <span className="absolute -top-0.5 left-1 rounded bg-popover px-1 font-mono text-[10px] tabular-nums text-primary">
            {cursor.label}
          </span>
        </div>
      )}
      {cursor && !drag && cursor.dot && onPointClick && (
        <span
          className="pointer-events-none absolute z-10 block h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
          style={{ left: cursor.dot.px, top: cursor.dot.py, background: cursor.dot.color }}
        />
      )}
      {cursor && !drag && cursor.rows.length > 0 && (
        <div
          className="pointer-events-none absolute top-6 z-10"
          // Flip to the left of the cursor near the right edge, so the card stays on the chart
          style={cursor.px > cursor.width * 0.6 ? { right: cursor.width - cursor.px + 10 } : { left: cursor.px + 10 }}
        >
          <HoverCard rows={cursor.rows} mode={mode} xAxis={xAxis} leadKey={cursor.leadKey} />
        </div>
      )}
    </div>
  )
}

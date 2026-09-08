import type { AgentTimeline } from '@/types/claude'
import { buildCompressedScale, type Interval } from '@/lib/time-scale'

/** A selected time window, in ms since epoch, inclusive on both ends */
export interface TimeWindow { from: number; to: number }

export function normalizeWindow(a: number, b: number): TimeWindow {
  return { from: Math.min(a, b), to: Math.max(a, b) }
}

/** True when an instant falls inside the window (no window = everything) */
export function inWindow(timestamp: string | number, w: TimeWindow | null): boolean {
  if (!w) return true
  const t = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime()
  return t >= w.from && t <= w.to
}

/** True when [start, end] overlaps the window (no window = everything) */
export function intersectsWindow(start: string | number, end: string | number, w: TimeWindow | null): boolean {
  if (!w) return true
  const s = typeof start === 'number' ? start : new Date(start).getTime()
  const e = typeof end === 'number' ? end : new Date(end).getTime()
  return s <= w.to && e >= w.from
}

export function windowFromSearch(search: string): TimeWindow | null {
  const p = new URLSearchParams(search)
  const from = Date.parse(p.get('from') ?? '')
  const to = Date.parse(p.get('to') ?? '')
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  return normalizeWindow(from, to)
}

export function windowToSearch(search: string, w: TimeWindow | null): string {
  const p = new URLSearchParams(search)
  if (w) {
    p.set('from', new Date(w.from).toISOString())
    p.set('to', new Date(w.to).toISOString())
  } else {
    p.delete('from'); p.delete('to')
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

const ms = (iso: string) => new Date(iso).getTime()

/** Every activity interval of a timeline: orchestrator turns, prompts, agents */
export function timelineIntervals(timeline: AgentTimeline): Interval[] {
  return [
    ...timeline.orchestrator.busy.map(s => ({ start: ms(s.start), end: ms(s.end) })),
    ...timeline.orchestrator.prompts.map(p => ({ start: ms(p.timestamp), end: ms(p.timestamp) + 60_000 })),
    ...timeline.agents.map(a => ({ start: ms(a.start), end: ms(a.end) })),
  ]
}

/** Blocks of activity separated by idle gaps longer than the threshold */
export function activityBlocks(timeline: AgentTimeline, gapThresholdMs: number): Interval[] {
  return buildCompressedScale(timelineIntervals(timeline), gapThresholdMs, 0).blocks.map(b => ({ start: b.start, end: b.end }))
}

/** Value for an <input type="datetime-local"> in the viewer's local time */
export function toLocalInputValue(t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

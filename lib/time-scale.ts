/**
 * Piecewise-linear time scale that collapses idle gaps.
 *
 * Real time (ms since epoch) maps to a "compressed" coordinate where every
 * idle gap longer than `gapThresholdMs` is replaced by a fixed `gapWidthMs`.
 * Coordinates stay in milliseconds so the chart can use a plain numeric axis.
 */

export interface Interval { start: number; end: number }

export interface ScaleBreak {
  /** compressed x where the break starts */
  x: number
  width: number
  /** real time on each side */
  from: number
  to: number
}

export interface ScaleTick { x: number; time: number }

export interface CompressedScale {
  /** compressed total width in ms */
  total: number
  breaks: ScaleBreak[]
  blocks: Array<Interval & { x: number }>
  toX(time: number): number
  toTime(x: number): number
}

/** Merge overlapping intervals into sorted, disjoint blocks */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter(i => Number.isFinite(i.start) && Number.isFinite(i.end))
    .map(i => ({ start: Math.min(i.start, i.end), end: Math.max(i.start, i.end) }))
    .sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const i of sorted) {
    const last = out[out.length - 1]
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end)
    else out.push({ ...i })
  }
  return out
}

export function buildCompressedScale(
  intervals: Interval[],
  gapThresholdMs: number,
  gapWidthMs: number,
): CompressedScale {
  const merged = mergeIntervals(intervals)
  // Blocks of activity separated by gaps above the threshold
  const groups: Interval[] = []
  for (const i of merged) {
    const last = groups[groups.length - 1]
    if (last && i.start - last.end <= gapThresholdMs) last.end = Math.max(last.end, i.end)
    else groups.push({ ...i })
  }

  const blocks: Array<Interval & { x: number }> = []
  const breaks: ScaleBreak[] = []
  let x = 0
  for (let idx = 0; idx < groups.length; idx++) {
    const g = groups[idx]
    if (idx > 0) {
      breaks.push({ x, width: gapWidthMs, from: groups[idx - 1].end, to: g.start })
      x += gapWidthMs
    }
    blocks.push({ ...g, x })
    x += g.end - g.start
  }
  const total = x

  const toX = (time: number): number => {
    if (blocks.length === 0) return 0
    if (time <= blocks[0].start) return blocks[0].x - (blocks[0].start - time)
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (time <= b.end) return b.x + (time - b.start)
      const next = blocks[i + 1]
      if (!next) return b.x + (b.end - b.start) + (time - b.end)
      if (time < next.start) {
        // inside a gap: spread linearly over the break width
        const frac = (time - b.end) / (next.start - b.end)
        return b.x + (b.end - b.start) + frac * (next.x - (b.x + (b.end - b.start)))
      }
    }
    return total
  }

  const toTime = (xx: number): number => {
    if (blocks.length === 0) return 0
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const bEnd = b.x + (b.end - b.start)
      if (xx <= bEnd) return b.start + (xx - b.x)
      const next = blocks[i + 1]
      if (!next) return b.end + (xx - bEnd)
      if (xx < next.x) {
        const frac = (xx - bEnd) / (next.x - bEnd)
        return b.end + frac * (next.start - b.end)
      }
    }
    return blocks[blocks.length - 1].end
  }

  return { total, breaks, blocks, toX, toTime }
}

const STEPS_MS = [
  60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
  60 * 60_000, 2 * 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000,
]

/** Clock ticks at round local times inside each active block, about `target` in total */
export function clockTicks(scale: CompressedScale, target = 8): ScaleTick[] {
  const active = scale.blocks.reduce((s, b) => s + (b.end - b.start), 0)
  if (active <= 0) return []
  const ideal = active / target
  const step = STEPS_MS.find(s => s >= ideal) ?? STEPS_MS[STEPS_MS.length - 1]
  const ticks: ScaleTick[] = []
  for (const b of scale.blocks) {
    const offset = new Date(b.start).getTimezoneOffset() * 60_000
    // Align to local clock: round up to the next multiple of step in local time
    let t = Math.ceil((b.start - offset) / step) * step + offset
    for (; t <= b.end; t += step) ticks.push({ x: scale.toX(t), time: t })
  }
  return ticks
}

export function formatClock(time: number): string {
  const d = new Date(time)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatDayClock(time: number): string {
  const d = new Date(time)
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${formatClock(time)}`
}

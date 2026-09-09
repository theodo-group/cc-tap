import { describe, it, expect } from 'vitest'
import { buildCompressedScale, mergeIntervals, clockTicks } from '@/lib/time-scale'

const MIN = 60_000
const H = 60 * MIN

describe('mergeIntervals', () => {
  it('merges overlapping and touching intervals, sorted', () => {
    expect(mergeIntervals([
      { start: 10, end: 20 }, { start: 0, end: 5 }, { start: 15, end: 30 }, { start: 30, end: 31 },
    ])).toEqual([{ start: 0, end: 5 }, { start: 10, end: 31 }])
  })
  it('normalises reversed intervals and drops NaN', () => {
    expect(mergeIntervals([{ start: 5, end: 1 }, { start: NaN, end: 2 }])).toEqual([{ start: 1, end: 5 }])
  })
})

describe('buildCompressedScale', () => {
  it('is linear when there is no gap above the threshold', () => {
    const s = buildCompressedScale([{ start: 0, end: 10 * MIN }, { start: 12 * MIN, end: 20 * MIN }], 30 * MIN, 5 * MIN)
    expect(s.breaks).toEqual([])
    expect(s.total).toBe(20 * MIN)
    expect(s.toX(15 * MIN)).toBe(15 * MIN)
    expect(s.toTime(s.toX(7 * MIN))).toBe(7 * MIN)
  })

  it('collapses a long gap into a fixed width', () => {
    const s = buildCompressedScale([{ start: 0, end: 1 * H }, { start: 10 * H, end: 11 * H }], 30 * MIN, 5 * MIN)
    expect(s.breaks).toEqual([{ x: 1 * H, width: 5 * MIN, from: 1 * H, to: 10 * H }])
    expect(s.total).toBe(2 * H + 5 * MIN)
    expect(s.toX(10 * H)).toBe(1 * H + 5 * MIN)
    expect(s.toX(10.5 * H)).toBe(1.5 * H + 5 * MIN)
    // inside the gap: midway maps to the middle of the break
    expect(s.toX(5.5 * H)).toBe(1 * H + 2.5 * MIN)
    // round trip on both blocks
    expect(s.toTime(s.toX(0.25 * H))).toBe(0.25 * H)
    expect(s.toTime(s.toX(10.25 * H))).toBe(10.25 * H)
  })

  it('extends linearly outside the covered range', () => {
    const s = buildCompressedScale([{ start: 100, end: 200 }], 10, 5)
    expect(s.toX(50)).toBe(-50)
    expect(s.toX(250)).toBe(150)
  })

  it('handles empty input', () => {
    const s = buildCompressedScale([], 10, 5)
    expect(s.total).toBe(0)
    expect(s.toX(123)).toBe(0)
    expect(clockTicks(s)).toEqual([])
  })
})

describe('clockTicks', () => {
  it('places round ticks inside each block only', () => {
    const base = Date.UTC(2026, 0, 1, 10, 7)
    const s = buildCompressedScale([
      { start: base, end: base + 50 * MIN },
      { start: base + 5 * H, end: base + 5 * H + 50 * MIN },
    ], 30 * MIN, 5 * MIN)
    const ticks = clockTicks(s, 8)
    expect(ticks.length).toBeGreaterThan(3)
    for (const t of ticks) {
      const inBlock = s.blocks.some(b => t.time >= b.start && t.time <= b.end)
      expect(inBlock).toBe(true)
      expect(t.x).toBe(s.toX(t.time))
      expect(new Date(t.time).getSeconds()).toBe(0)
    }
    // ticks are strictly increasing in x
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].x).toBeGreaterThan(ticks[i - 1].x)
  })
})

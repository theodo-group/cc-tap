import { describe, it, expect } from 'vitest'
import type { CompactionEvent, ReplayTurn } from '@/types/claude'
import { autocompactBand, buildContextMarks, buildContextSeries, deltaPoints, pointsInWindow } from '@/lib/context-series'
import { DEFAULT_CONTEXT_LIMITS } from '@/lib/context-limits'

const T = DEFAULT_CONTEXT_LIMITS

function turn(p: Partial<ReplayTurn> & { timestamp: string }): ReplayTurn {
  return { uuid: p.timestamp, parentUuid: null, type: 'assistant', ...p }
}
const usage = (input: number, cacheRead: number, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: 0,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
})

describe('buildContextSeries', () => {
  const turns: ReplayTurn[] = [
    turn({ timestamp: '2026-09-10T10:00:00.000Z', type: 'user' }),
    turn({ timestamp: '2026-09-10T10:00:10.000Z', model: 'claude-opus-5', usage: usage(1_000, 99_000) }),
    turn({ timestamp: '2026-09-10T10:00:20.000Z', model: 'claude-sonnet-4-6', usage: usage(500, 49_500) }),
  ]

  it('reads the context size as the whole prompt', () => {
    const s = buildContextSeries(turns, T)
    expect(s.map(p => p.tokens)).toEqual([100_000, 50_000])
  })

  it('counts what was written to the cache, not only what was read', () => {
    // A cold cache after a /login or a resume writes the whole prompt instead
    // of reading it. The context did not shrink, so the reading must not either.
    const cold = buildContextSeries([
      turn({ timestamp: '2026-09-10T12:02:00.000Z', model: 'claude-opus-5', usage: usage(150_000, 0) }),
      turn({ timestamp: '2026-09-10T12:02:06.000Z', model: 'claude-opus-5', usage: usage(2, 0, 146_337) }),
      turn({ timestamp: '2026-09-10T12:02:11.000Z', model: 'claude-opus-5', usage: usage(2, 146_337, 1_532) }),
    ], T)
    expect(cold.map(p => p.tokens)).toEqual([150_000, 146_339, 147_871])
    expect(deltaPoints(cold).map(p => p.delta)).toEqual([-3_661, 1_532])
  })

  it('numbers a point by its place among the assistant turns, as the Replay does', () => {
    // turns[0] is a user turn, so the two assistant turns are #1 and #2 —
    // not 2 and 3, which is where they sit in the full list
    expect(buildContextSeries(turns, T).map(p => p.turn)).toEqual([1, 2])
  })

  it('counts an assistant turn it does not plot, so the numbers stay in step', () => {
    const withGap = buildContextSeries([
      turn({ timestamp: '2026-09-10T10:00:00.000Z', model: 'claude-opus-5', usage: usage(0, 10) }),
      turn({ timestamp: '2026-09-10T10:00:05.000Z', model: '<synthetic>', usage: usage(0, 0) }),
      turn({ timestamp: '2026-09-10T10:00:10.000Z', type: 'user' }),
      turn({ timestamp: '2026-09-10T10:00:20.000Z', model: 'claude-opus-5', usage: usage(0, 20) }),
    ], T)
    expect(withGap.map(p => p.turn)).toEqual([1, 3])
  })

  it('measures the percentage against the model of that turn', () => {
    const s = buildContextSeries(turns, T)
    expect(s[0].limit).toBe(1_000_000)
    expect(s[0].pct).toBeCloseTo(10)
    expect(s[1].limit).toBe(200_000)
    expect(s[1].pct).toBeCloseTo(25)
  })

  it('leaves out user turns and turns with no usage', () => {
    const s = buildContextSeries([
      turn({ timestamp: '2026-09-10T10:00:00.000Z', type: 'user', usage: usage(10, 10) }),
      turn({ timestamp: '2026-09-10T10:00:10.000Z' }),
    ], T)
    expect(s).toEqual([])
  })
})

describe('autocompactBand', () => {
  const points = buildContextSeries([
    turn({ timestamp: '2026-09-10T10:00:00.000Z', model: 'claude-sonnet-4-6', usage: usage(0, 150_000) }),
  ], T)
  const compaction = (pre: number, i: number): CompactionEvent => ({
    uuid: `c${i}`, timestamp: '2026-09-10T10:00:05.000Z', trigger: 'auto', pre_tokens: pre, turn_index: i,
  })

  it('returns nothing when the session never compacted', () => {
    expect(autocompactBand([], points)).toBeNull()
  })

  it('spans the lowest and the highest observed trigger', () => {
    const marks = buildContextMarks([compaction(150_000, 0), compaction(170_000, 5)])
    const band = autocompactBand(marks, points)
    expect(band?.fromTokens).toBe(150_000)
    expect(band?.toTokens).toBe(170_000)
  })

  it('collapses to one value with a single compaction', () => {
    const band = autocompactBand(buildContextMarks([compaction(160_000, 0)]), points)
    expect(band?.fromTokens).toBe(band?.toTokens)
    expect(band?.fromPct).toBeCloseTo(80)
  })

  it('ignores a compaction that logged no size', () => {
    expect(autocompactBand(buildContextMarks([compaction(0, 0)]), points)).toBeNull()
  })
})

describe('buildContextMarks', () => {
  const compactionAt = (turn_index: number) => ({
    uuid: 'c1', timestamp: '2026-09-10T10:00:05.000Z', trigger: 'manual' as const, pre_tokens: 9, turn_index,
  })

  it('places a compaction on both axes', () => {
    const [m] = buildContextMarks([compactionAt(3)])
    expect(m.time).toBe(Date.parse('2026-09-10T10:00:05.000Z'))
    expect(m.trigger).toBe('manual')
  })

  it('lands between the assistant turns it sits between, not on the full-list index', () => {
    // user, assistant, user, assistant: index 3 has one assistant turn before it
    const list: ReplayTurn[] = [
      turn({ timestamp: '2026-09-10T10:00:00.000Z', type: 'user' }),
      turn({ timestamp: '2026-09-10T10:00:01.000Z', model: 'claude-opus-5', usage: usage(0, 1) }),
      turn({ timestamp: '2026-09-10T10:00:02.000Z', type: 'user' }),
      turn({ timestamp: '2026-09-10T10:00:03.000Z', model: 'claude-opus-5', usage: usage(0, 2) }),
    ]
    expect(buildContextMarks([compactionAt(3)], list)[0].turn).toBe(1.5)
  })
})

describe('pointsInWindow', () => {
  const points = buildContextSeries([
    turn({ timestamp: '2026-09-10T10:00:00.000Z', model: 'claude-opus-5', usage: usage(1, 1) }),
    turn({ timestamp: '2026-09-10T11:00:00.000Z', model: 'claude-opus-5', usage: usage(1, 1) }),
    turn({ timestamp: '2026-09-10T12:00:00.000Z', model: 'claude-opus-5', usage: usage(1, 1) }),
  ], T)

  it('keeps everything with no window', () => {
    expect(pointsInWindow(points)).toHaveLength(3)
  })

  it('keeps the points inside, ends included', () => {
    const kept = pointsInWindow(points, Date.parse('2026-09-10T10:00:00.000Z'), Date.parse('2026-09-10T11:00:00.000Z'))
    expect(kept.map(p => p.turn)).toEqual([1, 2])
  })
})

describe('deltaPoints', () => {
  const points = buildContextSeries([
    turn({ timestamp: '2026-09-10T10:00:00.000Z', model: 'claude-opus-5', usage: usage(0, 10_000) }),
    turn({ timestamp: '2026-09-10T10:01:00.000Z', model: 'claude-opus-5', usage: usage(0, 25_000) }),
    turn({ timestamp: '2026-09-10T10:02:00.000Z', model: 'claude-opus-5', usage: usage(0, 5_000) }),
  ], T)

  it('reports the change since the turn before', () => {
    expect(deltaPoints(points).map(p => p.delta)).toEqual([15_000, -20_000])
  })

  it('leaves out the first point, which has nothing to compare against', () => {
    const d = deltaPoints(points)
    expect(d).toHaveLength(points.length - 1)
    expect(d[0].turn).toBe(points[1].turn)
  })

  it('keeps the rest of the point untouched', () => {
    expect(deltaPoints(points)[0]).toMatchObject({ tokens: 25_000, limit: 1_000_000 })
  })

  it('gives nothing for a single point or none', () => {
    expect(deltaPoints(points.slice(0, 1))).toEqual([])
    expect(deltaPoints([])).toEqual([])
  })
})

describe('synthetic turns', () => {
  // Claude Code writes these locally — a usage limit, a missing credit — with
  // every count at zero. A real assistant turn always reads a system prompt.
  const turns: ReplayTurn[] = [
    turn({ timestamp: '2026-09-10T10:00:00.000Z', model: 'claude-opus-5', usage: usage(0, 150_000) }),
    turn({ timestamp: '2026-09-10T11:00:00.000Z', model: '<synthetic>', usage: usage(0, 0), text: "You've hit your session limit" }),
    turn({ timestamp: '2026-09-10T13:00:00.000Z', model: 'claude-opus-5', usage: usage(0, 155_000) }),
  ]

  it('leaves a synthetic turn out rather than drawing it at zero', () => {
    expect(buildContextSeries(turns, T).map(p => p.tokens)).toEqual([150_000, 155_000])
  })

  it('keeps the real turns numbered as the Replay numbers them', () => {
    expect(buildContextSeries(turns, T).map(p => p.turn)).toEqual([1, 3])
  })

  it('bridges the gap in a diff, so no false drop and rise appear', () => {
    expect(deltaPoints(buildContextSeries(turns, T)).map(p => p.delta)).toEqual([5_000])
  })

  it('still drops a real turn that carries no usage at all', () => {
    expect(buildContextSeries([turn({ timestamp: '2026-09-10T10:00:00.000Z', model: 'claude-opus-5' })], T)).toEqual([])
  })
})

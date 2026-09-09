import { describe, expect, it } from 'vitest'
import { turnAtTime } from '@/lib/turn-at-time'

const turns = [
  { uuid: 'a', timestamp: '2026-01-01T10:00:00Z' },
  { uuid: 'b', timestamp: '2026-01-01T10:05:00Z' },
  { uuid: 'c', timestamp: '2026-01-01T10:10:00Z' },
]
const at = (iso: string) => new Date(iso).getTime()

describe('turnAtTime', () => {
  it('returns the last turn that started at or before the time', () => {
    expect(turnAtTime(turns, at('2026-01-01T10:07:00Z'))?.uuid).toBe('b')
    expect(turnAtTime(turns, at('2026-01-01T10:05:00Z'))?.uuid).toBe('b')
    expect(turnAtTime(turns, at('2026-01-01T11:00:00Z'))?.uuid).toBe('c')
  })
  it('falls back to the first turn before the session started', () => {
    expect(turnAtTime(turns, at('2026-01-01T09:00:00Z'))?.uuid).toBe('a')
  })
  it('returns undefined for an empty list', () => {
    expect(turnAtTime([], 0)).toBeUndefined()
  })
})

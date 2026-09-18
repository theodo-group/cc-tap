import { describe, it, expect } from 'vitest'
import { windowFromSearch, windowToSearch } from '@/lib/time-window'

const FROM = Date.UTC(2026, 8, 17, 8, 0, 0)
const TO = FROM + 5 * 60 * 60 * 1000

describe('windowFromSearch', () => {
  it('parses ISO timestamps', () => {
    const w = windowFromSearch(`?from=${new Date(FROM).toISOString()}&to=${new Date(TO).toISOString()}`)
    expect(w).toEqual({ from: FROM, to: TO })
  })

  it('parses 13-digit millisecond values', () => {
    expect(windowFromSearch(`?from=${FROM}&to=${TO}`)).toEqual({ from: FROM, to: TO })
  })

  it('accepts a mix of ISO and ms, and normalises order', () => {
    const w = windowFromSearch(`?from=${TO}&to=${new Date(FROM).toISOString()}`)
    expect(w).toEqual({ from: FROM, to: TO })
  })

  it('returns null when either bound is missing or unparseable', () => {
    expect(windowFromSearch('')).toBeNull()
    expect(windowFromSearch(`?from=${FROM}`)).toBeNull()
    expect(windowFromSearch(`?from=yesterday&to=${TO}`)).toBeNull()
  })

  it('round-trips through windowToSearch', () => {
    expect(windowFromSearch(windowToSearch('?tab=x', { from: FROM, to: TO }))).toEqual({ from: FROM, to: TO })
  })
})

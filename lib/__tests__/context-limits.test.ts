import { describe, it, expect } from 'vitest'
import { contextLimit, DEFAULT_CONTEXT_LIMITS, FALLBACK_CONTEXT_LIMIT } from '@/lib/context-limits'

const T = DEFAULT_CONTEXT_LIMITS

describe('contextLimit', () => {
  it('gives Opus and Fable the 1M window', () => {
    expect(contextLimit('claude-opus-5', T)).toBe(1_000_000)
    expect(contextLimit('claude-opus-4-8-20251101', T)).toBe(1_000_000)
    expect(contextLimit('claude-fable-5-1', T)).toBe(1_000_000)
  })

  it('keeps Sonnet and Haiku at 200k', () => {
    expect(contextLimit('claude-sonnet-4-6', T)).toBe(200_000)
    expect(contextLimit('claude-haiku-4-5-20251001', T)).toBe(200_000)
  })

  it('falls back for an unknown or missing model', () => {
    expect(contextLimit('gpt-9', T)).toBe(FALLBACK_CONTEXT_LIMIT)
    expect(contextLimit(undefined, T)).toBe(FALLBACK_CONTEXT_LIMIT)
  })

  it('does not match a key that is only a text prefix', () => {
    expect(contextLimit('claude-opusx-1', T)).toBe(FALLBACK_CONTEXT_LIMIT)
  })

  it('prefers the longest matching key', () => {
    const table = { ...T, 'claude-opus-4-1': 200_000 }
    expect(contextLimit('claude-opus-4-1-20250805', table)).toBe(200_000)
    expect(contextLimit('claude-opus-4-8', table)).toBe(1_000_000)
  })

  it('takes an exact entry before any prefix match', () => {
    expect(contextLimit('claude-opus-5', { ...T, 'claude-opus-5': 500_000 })).toBe(500_000)
  })
})

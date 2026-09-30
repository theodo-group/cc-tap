import { describe, it, expect } from 'vitest'
import { otelCommand } from '@/lib/otel-control'

describe('otelCommand', () => {
  it('writes the default dir relative to $HOME', () => {
    expect(otelCommand('/home/me/.cc-lens/otel-bodies', '/home/me')).toBe('OTEL_LOG_RAW_API_BODIES=file:$HOME/.cc-lens/otel-bodies claude')
  })

  it('keeps a dir outside the home dir absolute', () => {
    expect(otelCommand('/data/bodies', '/home/me')).toBe('OTEL_LOG_RAW_API_BODIES=file:/data/bodies claude')
    expect(otelCommand('/home/me2/bodies', '/home/me')).toBe('OTEL_LOG_RAW_API_BODIES=file:/home/me2/bodies claude')
  })
})

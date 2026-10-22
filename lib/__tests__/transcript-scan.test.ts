import { describe, it, expect } from 'vitest'
import { scanTranscript } from '@/lib/transcript-scan'
import { TERM_FAST, ledgerMetrics } from '@/lib/session-ledger'

const usage = {
  input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
  speed: 'fast',
}
const line = {
  type: 'assistant', timestamp: '2026-10-01T10:00:00.000Z', requestId: 'req_1',
  message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [] },
}

describe('scanTranscript pricing', () => {
  it('keeps the 1-hour cache split and the request terms of a sub-agent turn', () => {
    const { ledger } = scanTranscript([line])
    expect(ledger.cacheWrite1h[0]).toBe(1000)
    expect(ledger.terms[0]).toBe(TERM_FAST)
    const cost = ledgerMetrics(ledger, null, 1).model_usage['claude-opus-5-5'].costUSD
    expect(cost).toBeCloseTo((10 * 4 + 20 * 20 + 1000 * 8) / 1_000_000 * 2)
  })

  it('takes the request terms from a later line of the same response', () => {
    const { speed: _speed, ...early } = usage
    const { ledger } = scanTranscript([
      { ...line, message: { ...line.message, usage: { ...early, output_tokens: 5 } } },
      line,
    ])
    expect(ledger.ts.length).toBe(1)
    expect(ledger.terms[0]).toBe(TERM_FAST)
  })
})

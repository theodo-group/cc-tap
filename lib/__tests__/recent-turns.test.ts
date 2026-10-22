import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { estimateCostFromUsage } from '@/lib/pricing'

let tmpDir: string
let reader: typeof import('@/lib/claude-reader')
let previousClaudeConfigDir: string | undefined

const MODEL = 'claude-opus-4-8'

function line(ts: string, id: string, usage: Record<string, unknown>) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'req', message: { id, model: MODEL, usage, content: [] } })
}

const lines = [
  line('2026-06-01T10:00:00.000Z', 'msg_1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } }),
  line('2026-06-01T10:00:01.000Z', 'msg_1', { input_tokens: 10, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } }),
  line('2026-06-01T10:00:02.000Z', 'msg_1', { input_tokens: 10, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } }),
  line('2026-06-01T10:05:00.000Z', 'msg_2', { input_tokens: 3, output_tokens: 7, speed: 'fast' }),
]

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-turns-'))
  const projectDir = path.join(tmpDir, 'projects', '-Users-test-proj')
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'abc12345-0000-0000-0000-000000000000.jsonl'), lines.join('\n'))
  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  vi.resetModules()
  reader = await import('@/lib/claude-reader')
})

afterAll(async () => {
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
  vi.resetModules()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('getRecentTurns', () => {
  it('counts a response written over several lines once, at its final usage', async () => {
    const turns = await reader.getRecentTurns(0)
    const sum = (f: (t: (typeof turns)[number]) => number) => turns.reduce((a, t) => a + f(t), 0)

    expect(sum(t => t.inputTokens)).toBe(13)
    expect(sum(t => t.outputTokens)).toBe(87)
    expect(sum(t => t.cacheReadTokens)).toBe(1000)
    expect(sum(t => t.cacheWriteTokens)).toBe(200)

    const expected =
      estimateCostFromUsage(MODEL, {
        input_tokens: 10, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 },
      }) +
      2 * estimateCostFromUsage(MODEL, { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(sum(t => t.costUSD)).toBeCloseTo(expected, 10)
  })

  it('skips lines that add nothing to their response', async () => {
    const turns = await reader.getRecentTurns(0)
    expect(turns.map(t => t.ts)).toEqual([
      Date.parse('2026-06-01T10:00:00.000Z'),
      Date.parse('2026-06-01T10:00:01.000Z'),
      Date.parse('2026-06-01T10:05:00.000Z'),
    ])
  })
})

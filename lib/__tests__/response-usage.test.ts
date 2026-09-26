import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { ResponseTracker, maxUsage, responseKey } from '@/lib/response-usage'
import { estimateCostFromUsage } from '@/lib/pricing'

// Claude Code writes one line per content block of an API response, each
// repeating the response's usage; an early line can hold an intermediate
// snapshot. A response must count once, at its per-field max.

const MODEL = 'claude-opus-4-8'
const U1 = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 500 }
const U2_EARLY = { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 }
const U2_FINAL = { ...U2_EARLY, output_tokens: 80 }
const U3 = { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const line = (id: string, requestId: string, ts: string, usage: object, block: object) =>
  JSON.stringify({ type: 'assistant', uuid: `${id}-${ts}`, requestId, timestamp: ts, message: { id, model: MODEL, usage, content: [block] } })

const SESSION_ID = 'aaaa1111-0000-0000-0000-000000000000'
const sessionLines = [
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-25T08:00:00.000Z', cwd: '/Users/test/proj', message: { content: 'go' } }),
  // msg_1: thinking, text and a tool call — three lines, one response
  line('msg_1', 'req_1', '2026-09-25T08:00:05.000Z', U1, { type: 'thinking', thinking: '…' }),
  line('msg_1', 'req_1', '2026-09-25T08:00:06.000Z', U1, { type: 'text', text: 'Running it.' }),
  line('msg_1', 'req_1', '2026-09-25T08:00:07.000Z', U1, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }),
  JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-09-25T08:00:09.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }),
  // msg_2: the first line is an intermediate snapshot (output 5), the last the final one (80)
  line('msg_2', 'req_2', '2026-09-25T08:00:12.000Z', U2_EARLY, { type: 'text', text: 'Done' }),
  line('msg_2', 'req_2', '2026-09-25T08:00:13.000Z', U2_FINAL, { type: 'text', text: '.' }),
]
const agentLines = [
  line('msg_3', 'req_3', '2026-09-25T08:00:08.000Z', U3, { type: 'text', text: 'agent' }),
  line('msg_3', 'req_3', '2026-09-25T08:00:08.500Z', U3, { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'a' } }),
]

describe('responseKey / maxUsage / ResponseTracker', () => {
  it('keys a line by message id and request id, and leaves an id-less line alone', () => {
    expect(responseKey({ requestId: 'r', message: { id: 'm' } })).toBe('m:r')
    expect(responseKey({ message: { id: 'm' } })).toBe('m')
    expect(responseKey({ message: {} })).toBeNull()
  })

  it('merges per field, never below either side', () => {
    expect(maxUsage(U2_EARLY, U2_FINAL)).toMatchObject(U2_FINAL)
    expect(maxUsage(U2_FINAL, U2_EARLY)).toMatchObject(U2_FINAL)
    expect(maxUsage({ cache_creation: { ephemeral_5m_input_tokens: 3 } }, { cache_creation: { ephemeral_1h_input_tokens: 7 } }).cache_creation)
      .toEqual({ ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 7 })
  })

  it('adds a response once: the whole usage on its first line, only the growth after', () => {
    const t = new ResponseTracker()
    const sum = { input: 0, output: 0 }
    const add = (l: object, u: typeof U1) => {
      const { isNew, delta } = t.add(l, u)
      sum.input += delta.input_tokens ?? 0
      sum.output += delta.output_tokens ?? 0
      return isNew
    }
    const m1 = { requestId: 'req_1', message: { id: 'msg_1' } }
    const m2 = { requestId: 'req_2', message: { id: 'msg_2' } }
    expect([add(m1, U1), add(m1, U1), add(m1, U1)]).toEqual([true, false, false])
    expect([add(m2, U2_EARLY), add(m2, U2_FINAL)]).toEqual([true, false])
    expect(sum).toEqual({ input: U1.input_tokens + U2_FINAL.input_tokens, output: U1.output_tokens + U2_FINAL.output_tokens })
    // Two id-less lines are two responses, as before.
    expect([add({ message: {} }, U3), add({ message: {} }, U3)]).toEqual([true, true])
  })
})

// The three places that read usage from transcripts, on the same fixture.
let tmpDir: string
let previous: string | undefined
let reader: typeof import('@/lib/claude-reader')
let replay: typeof import('@/lib/replay-parser')

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-usage-'))
  const project = path.join(tmpDir, 'projects', '-Users-test-proj')
  await fs.mkdir(path.join(project, SESSION_ID, 'subagents'), { recursive: true })
  await fs.writeFile(path.join(project, `${SESSION_ID}.jsonl`), sessionLines.join('\n'))
  await fs.writeFile(path.join(project, SESSION_ID, 'subagents', 'agent-a1.jsonl'), agentLines.join('\n'))
  previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  vi.resetModules()
  reader = await import('@/lib/claude-reader')
  replay = await import('@/lib/replay-parser')
})

afterAll(async () => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
  vi.resetModules()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('a response written over several lines counts once', () => {
  it('in the session totals, sub-agents folded in', async () => {
    const [s] = (await reader.getAllParsedSessions()).filter(x => x.session_id === SESSION_ID)
    expect(s.assistant_message_count).toBe(2)
    expect(s.input_tokens).toBe(U1.input_tokens + U2_FINAL.input_tokens + U3.input_tokens)
    expect(s.output_tokens).toBe(U1.output_tokens + U2_FINAL.output_tokens + U3.output_tokens)
    expect(s.cache_read_input_tokens).toBe(U1.cache_read_input_tokens + U2_FINAL.cache_read_input_tokens)
    expect(s.tool_counts).toEqual({ Bash: 1 })
  })

  it('in the replay: every line stays a turn, the usage rides on one of them', async () => {
    const file = path.join(tmpDir, 'projects', '-Users-test-proj', `${SESSION_ID}.jsonl`)
    const data = await replay.parseSessionReplay(file, SESSION_ID)
    const assistant = data.turns.filter(t => t.type === 'assistant')
    expect(assistant).toHaveLength(5)
    const priced = assistant.filter(t => t.usage)
    expect(priced.map(t => t.uuid)).toEqual(['msg_1-2026-09-25T08:00:07.000Z', 'msg_2-2026-09-25T08:00:13.000Z'])
    expect(priced[1].usage?.output_tokens).toBe(80)
    expect(data.total_cost).toBeCloseTo(estimateCostFromUsage(MODEL, U1) + estimateCostFromUsage(MODEL, U2_FINAL), 10)
  })
})

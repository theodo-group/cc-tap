import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { parseAgentTimeline, isHumanPrompt, parseNotifications, resolveOutcome } from '@/lib/agent-timeline'

const SESSION = 'sess-1'
let dir: string
let jsonlPath: string

const T = (min: number, sec = 0) => new Date(Date.UTC(2026, 0, 1, 10, min, sec)).toISOString()
const jsonl = (lines: object[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n'

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-timeline-'))
  jsonlPath = path.join(dir, `${SESSION}.jsonl`)
  const sub = path.join(dir, SESSION, 'subagents')
  await mkdir(sub, { recursive: true })

  await writeFile(jsonlPath, jsonl([
    { type: 'user', uuid: 'u1', timestamp: T(0), message: { role: 'user', content: 'Implement the feature' } },
    { type: 'assistant', uuid: 'a1', timestamp: T(0, 5), message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 }, content: [
      { type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: 'Implement backend', subagent_type: 'claude', model: 'opus', prompt: 'You are backend' } },
      { type: 'tool_use', id: 'toolu_B', name: 'Agent', input: { description: 'Review', subagent_type: 'claude', prompt: 'You are reviewer' } },
      { type: 'tool_use', id: 'toolu_C', name: 'Agent', input: { description: 'Doomed', subagent_type: 'claude', prompt: 'x' } },
    ] } },
    { type: 'user', uuid: 'u2', timestamp: T(0, 6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'launched' }] } },
    { type: 'system', subtype: 'turn_duration', durationMs: 6000, timestamp: T(0, 6), uuid: 's1' },
    { type: 'user', uuid: 'u3', timestamp: T(1), isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } },
    { type: 'user', uuid: 'u4', timestamp: T(5), promptSource: 'system', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>aaa</task-id>\n<status>completed</status>\n</task-notification>' } },
    { type: 'queue-operation', operation: 'enqueue', timestamp: T(5), content: '<task-notification>\n<task-id>aaa</task-id>\n<status>completed</status>\n</task-notification>' },
    { type: 'assistant', uuid: 'a2', timestamp: T(6), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_S', name: 'SendMessage', input: { to: 'bbb', message: 'continue' } },
      { type: 'tool_use', id: 'toolu_K', name: 'TaskStop', input: { task_id: 'ccc' } },
    ] } },
    { type: 'user', uuid: 'u5', timestamp: T(20), message: { role: 'user', content: 'Thanks, ship it' } },
  ]))

  // Agent aaa: depth 1, completed, launches a child
  await writeFile(path.join(sub, 'agent-aaa.meta.json'), JSON.stringify({ agentType: 'claude', description: 'Implement backend', toolUseId: 'toolu_A', spawnDepth: 1, model: 'opus' }))
  await writeFile(path.join(sub, 'agent-aaa.jsonl'), jsonl([
    { type: 'user', agentId: 'aaa', isSidechain: true, timestamp: T(0, 6), message: { role: 'user', content: 'You are backend' } },
    { type: 'assistant', agentId: 'aaa', timestamp: T(1), message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, content: [
      { type: 'tool_use', id: 'toolu_child', name: 'Agent', input: { description: 'Child verify', subagent_type: 'general-purpose', prompt: 'verify' } },
    ] } },
    { type: 'user', agentId: 'aaa', timestamp: T(3), message: { role: 'user', content: '<task-notification>\n<task-id>ddd</task-id>\n<status>failed</status>\n</task-notification>' } },
    { type: 'assistant', agentId: 'aaa', timestamp: T(4), message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'done' }] } },
  ]))
  // Child ddd: depth 2, failed
  await writeFile(path.join(sub, 'agent-ddd.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Child verify', toolUseId: 'toolu_child', spawnDepth: 2 }))
  await writeFile(path.join(sub, 'agent-ddd.jsonl'), jsonl([
    { type: 'user', agentId: 'ddd', timestamp: T(1, 10), message: { role: 'user', content: 'verify' } },
    { type: 'assistant', agentId: 'ddd', timestamp: T(2, 50), message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 5, output_tokens: 5 }, content: [] } },
  ]))
  // Agent bbb: no notification, nudged, old -> unknown
  await writeFile(path.join(sub, 'agent-bbb.meta.json'), JSON.stringify({ agentType: 'claude', description: 'Review', toolUseId: 'toolu_B', spawnDepth: 1 }))
  await writeFile(path.join(sub, 'agent-bbb.jsonl'), jsonl([
    { type: 'user', agentId: 'bbb', timestamp: T(0, 7), message: { role: 'user', content: 'You are reviewer' } },
    { type: 'assistant', agentId: 'bbb', timestamp: T(8), message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 5, output_tokens: 5 }, content: [] } },
  ]))
  // Agent ccc: stopped via TaskStop
  await writeFile(path.join(sub, 'agent-ccc.meta.json'), JSON.stringify({ agentType: 'claude', description: 'Doomed', toolUseId: 'toolu_C', spawnDepth: 1 }))
  await writeFile(path.join(sub, 'agent-ccc.jsonl'), jsonl([
    { type: 'user', agentId: 'ccc', timestamp: T(0, 8), message: { role: 'user', content: 'x' } },
  ]))
})

afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('parseAgentTimeline', () => {
  it('builds orchestrator busy segments and human prompts only', async () => {
    const tl = await parseAgentTimeline(jsonlPath, SESSION, Date.UTC(2027, 0, 1))
    expect(tl.orchestrator.busy).toEqual([{ start: T(0, 0), end: T(0, 6) }])
    expect(tl.orchestrator.prompts.map(p => p.text)).toEqual(['Implement the feature', 'Thanks, ship it'])
    expect(tl.start).toBe(T(0))
    expect(tl.end).toBe(T(20))
  })

  it('links agents to launches, parents, nudges and outcomes', async () => {
    const tl = await parseAgentTimeline(jsonlPath, SESSION, Date.UTC(2027, 0, 1))
    const byId = Object.fromEntries(tl.agents.map(a => [a.id, a]))

    expect(tl.agents.map(a => a.id)).toEqual(['aaa', 'bbb', 'ccc', 'ddd']) // sorted by start

    expect(byId.aaa).toMatchObject({
      depth: 1, parent_id: null, description: 'Implement backend', agent_type: 'claude', model: 'opus',
      prompt: 'You are backend', outcome: 'completed', turns: 2, children_count: 1,
      launch_tool_use_id: 'toolu_A', launch_turn_uuid: 'a1',
    })
    expect(byId.aaa.start).toBe(T(0, 6))
    expect(byId.aaa.end).toBe(T(4))
    expect(byId.aaa.duration_ms).toBe((4 * 60 - 6) * 1000)
    expect(byId.aaa.usage.input_tokens).toBe(101)
    expect(byId.aaa.usage.cache_read_input_tokens).toBe(1000)
    expect(byId.aaa.estimated_cost).toBeGreaterThan(0)

    expect(byId.ddd).toMatchObject({ depth: 2, parent_id: 'aaa', outcome: 'failed', prompt: 'verify' })
    expect(byId.ddd.launch_turn_uuid).toBeUndefined()

    expect(byId.bbb).toMatchObject({ outcome: 'unknown', nudges: [T(6)] })
    expect(byId.ccc).toMatchObject({ outcome: 'killed', children_count: 0 })
  })

  it('marks an agent running when its transcript is fresh and no notification exists', async () => {
    const tl = await parseAgentTimeline(jsonlPath, SESSION, new Date(T(8)).getTime() + 30_000)
    const bbb = tl.agents.find(a => a.id === 'bbb')!
    expect(bbb.outcome).toBe('running')
    expect(bbb.end).toBe(new Date(new Date(T(8)).getTime() + 30_000).toISOString())
  })

  it('returns an empty agent list when the subagents folder is missing', async () => {
    const other = path.join(dir, 'other.jsonl')
    await writeFile(other, jsonl([{ type: 'user', uuid: 'u', timestamp: T(0), message: { role: 'user', content: 'hi' } }]))
    const tl = await parseAgentTimeline(other, 'other')
    expect(tl.agents).toEqual([])
    expect(tl.orchestrator.prompts).toHaveLength(1)
  })
})

describe('helpers', () => {
  it('isHumanPrompt filters system-injected content', () => {
    expect(isHumanPrompt({ type: 'user', message: { content: 'hello' } })).toBe('hello')
    expect(isHumanPrompt({ type: 'user', message: { content: [{ type: 'text', text: ' hi ' }] } })).toBe('hi')
    expect(isHumanPrompt({ type: 'user', message: { content: '<command-name>/clear</command-name>' } })).toBeNull()
    expect(isHumanPrompt({ type: 'user', isMeta: true, message: { content: 'x' } })).toBeNull()
    expect(isHumanPrompt({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } })).toBeNull()
    expect(isHumanPrompt({ type: 'assistant', message: { content: 'x' } })).toBeNull()
  })

  it('parseNotifications reads every notification in a message', () => {
    const text = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>\n<task-notification>\n<task-id>a2</task-id>\n<output-file>/x</output-file>\n<status>killed</status>\n</task-notification>'
    expect(parseNotifications(text, 't')).toEqual([
      { taskId: 'a1', status: 'completed', timestamp: 't' },
      { taskId: 'a2', status: 'killed', timestamp: 't' },
    ])
  })

  it('resolveOutcome prefers the latest notification', () => {
    const n = [
      { taskId: 'a', status: 'failed', timestamp: '2026-01-01T00:00:01Z' },
      { taskId: 'a', status: 'completed', timestamp: '2026-01-01T00:00:02Z' },
    ]
    expect(resolveOutcome('a', n, new Set(), undefined, 0)).toBe('completed')
    expect(resolveOutcome('b', n, new Set(['b']), undefined, 0)).toBe('killed')
  })
})

describe('context events', async () => {
  const { findRewinds, findContextEvents } = await import('@/lib/agent-timeline')
  const msg = (uuid: string, parent: string | null, ts: string, type: 'user' | 'assistant' = 'user', content: unknown = 'x') =>
    ({ type, uuid, parentUuid: parent, timestamp: ts, message: { role: type, content } })

  it('detects a rewind as a fork and lists the discarded messages', () => {
    const lines = [
      msg('a', null, T(0)), msg('b', 'a', T(1), 'assistant'), msg('c', 'b', T(2)), msg('d', 'c', T(3), 'assistant'),
      msg('e', 'b', T(10)), // fork back to b: c and d are discarded
      msg('f', 'e', T(11), 'assistant'),
      msg('g', 'e', T(20)), // second fork: f discarded
    ]
    const r = findRewinds(lines)
    expect(r).toEqual([
      { timestamp: T(10), uuid: 'e', rewound_to_uuid: 'b', discarded_uuids: ['c', 'd'] },
      { timestamp: T(20), uuid: 'g', rewound_to_uuid: 'e', discarded_uuids: ['f'] },
    ])
  })

  it('does not mistake parallel tool results for a rewind', () => {
    const toolUse = (uuid: string, parent: string, ts: string, id: string) =>
      msg(uuid, parent, ts, 'assistant', [{ type: 'tool_use', id, name: 'Bash', input: {} }])
    const toolResult = (uuid: string, parent: string, ts: string, id: string) =>
      msg(uuid, parent, ts, 'user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }])
    const lines = [
      msg('u', null, T(0)),
      toolUse('a1', 'u', T(1), 't1'),
      toolUse('a2', 'a1', T(1), 't2'),
      toolResult('r1', 'a1', T(2), 't1'), // parent is a1, not the previous line a2
      toolResult('r2', 'a2', T(2), 't2'),
      msg('n', 'r2', T(3), 'assistant'),
    ]
    expect(findRewinds(lines)).toEqual([])
  })

  it('ignores a linear chain and unknown parents (after compaction)', () => {
    const lines = [msg('a', null, T(0)), msg('b', 'a', T(1)), { type: 'system', uuid: 's', subtype: 'compact_boundary', timestamp: T(2), compactMetadata: { trigger: 'auto', preTokens: 100, postTokens: 10, durationMs: 5 } }, msg('c', 's', T(3))]
    expect(findRewinds(lines)).toEqual([])
    const ev = findContextEvents(lines)
    expect(ev).toEqual([{ type: 'compact', timestamp: T(2), uuid: 's', trigger: 'auto', pre_tokens: 100, post_tokens: 10, duration_ms: 5 }])
  })

  it('reads /clear commands and orders events by time', () => {
    const lines = [
      msg('a', null, T(0)), msg('b', 'a', T(1), 'assistant'),
      msg('z', 'b', T(5), 'user', '<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
      { type: 'system', uuid: 's', subtype: 'compact_boundary', timestamp: T(3), compactMetadata: { trigger: 'manual' } },
    ]
    expect(findContextEvents(lines).map(e => [e.type, e.timestamp])).toEqual([['compact', T(3)], ['clear', T(5)]])
  })
})

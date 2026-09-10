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

describe('workflows', () => {
  const S = 'sess-wf'
  const RUN_A = 'wf_aaaaaaaa-111'
  const RUN_B = 'wf_bbbbbbbb-222'
  const RUN_K = 'wf_kkkkkkkk-333'
  let wdir: string
  let wjsonl: string
  const msOf = (iso: string) => new Date(iso).getTime()
  const launchResult = (uuid: string, ts: string, toolUseId: string, runId: string, taskId: string, name = 'gen') => ({
    type: 'user', uuid, timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Workflow launched in background. Task ID: ${taskId}\nRun ID: ${runId}` }] },
    toolUseResult: { status: 'async_launched', taskId, taskType: 'local_workflow', workflowName: name, runId, summary: 'Gen', transcriptDir: '/x', scriptPath: '/repo/.claude/workflows/gen.mjs' },
  })
  const notification = (uuid: string, ts: string, taskId: string, status: string) => ({
    type: 'user', uuid, timestamp: ts, promptSource: 'system', origin: { kind: 'task-notification' },
    message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>` },
  })
  const transcript = (agentId: string, first: string, last: string) => jsonl([
    { type: 'user', agentId, isSidechain: true, timestamp: first, message: { role: 'user', content: 'go' } },
    { type: 'assistant', agentId, timestamp: last, message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: 'done' }] } },
  ])

  beforeAll(async () => {
    wdir = await mkdtemp(path.join(tmpdir(), 'agent-timeline-wf-'))
    wjsonl = path.join(wdir, `${S}.jsonl`)
    const flat = path.join(wdir, S, 'subagents')
    const runA = path.join(flat, 'workflows', RUN_A)
    const runB = path.join(flat, 'workflows', RUN_B)
    const runK = path.join(flat, 'workflows', RUN_K)
    const records = path.join(wdir, S, 'workflows')
    for (const d of [runA, runB, runK, records]) await mkdir(d, { recursive: true })

    await writeFile(wjsonl, jsonl([
      { type: 'user', uuid: 'u1', timestamp: T(0), message: { role: 'user', content: 'Run the workflow' } },
      { type: 'assistant', uuid: 'a1', timestamp: T(1), message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_W1', name: 'Workflow', input: { scriptPath: '/repo/.claude/workflows/gen.mjs', args: ['x'] } },
        { type: 'tool_use', id: 'toolu_P', name: 'Agent', input: { description: 'Plain', subagent_type: 'claude', prompt: 'p' } },
      ] } },
      launchResult('u2', T(1, 5), 'toolu_W1', RUN_A, 'w111'),
      { type: 'user', uuid: 'u2b', timestamp: T(1, 6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_P', content: 'launched' }] } },
      notification('u3', T(30), 'w111', 'failed'),
      { type: 'assistant', uuid: 'a2', timestamp: T(31), message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_W1b', name: 'Workflow', input: { scriptPath: '/repo/.claude/workflows/gen.mjs', resumeFromRunId: RUN_A } },
      ] } },
      launchResult('u4', T(31, 5), 'toolu_W1b', RUN_A, 'w111b'),
      notification('u5', T(50), 'w111b', 'completed'),
      { type: 'assistant', uuid: 'a3', timestamp: T(60), message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_W2', name: 'Workflow', input: { script: "export const meta = { name: 'inline-gen', description: 'x' }", args: {} } },
      ] } },
      // No structured toolUseResult here: the text fallback names the run
      { type: 'user', uuid: 'u6', timestamp: T(60, 5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_W2', content: 'Workflow launched in background. Task ID: w222\nRun ID: ' + RUN_B }] } },
      { type: 'assistant', uuid: 'a4', timestamp: T(70), message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_W3', name: 'Workflow', input: { scriptPath: '/repo/k.mjs' } },
      ] } },
      launchResult('u7', T(70, 5), 'toolu_W3', RUN_K, 'w333', 'killer'),
      { type: 'assistant', uuid: 'a5', timestamp: T(75), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_S', name: 'TaskStop', input: { task_id: 'w333' } }] } },
    ]))

    // Plain agent next to the runs
    await writeFile(path.join(flat, 'agent-eee.meta.json'), JSON.stringify({ agentType: 'claude', description: 'Plain', toolUseId: 'toolu_P', spawnDepth: 1 }))
    await writeFile(path.join(flat, 'agent-eee.jsonl'), transcript('eee', T(1, 7), T(2)))

    // Run A: completed on the second attempt; record written by that attempt
    await writeFile(path.join(records, `${RUN_A}.json`), JSON.stringify({
      runId: RUN_A, timestamp: T(49), taskId: 'w111b', script: 'export default SCRIPT_MARKER', scriptPath: '/repo/.claude/workflows/gen.mjs',
      args: ['x'], result: { marker: 'RESULT_MARKER' }, agentCount: 3, logs: ['l1'], durationMs: 17 * 60_000, summary: 'Gen', workflowName: 'gen',
      status: 'completed', startTime: msOf(T(32)), phases: [{ title: 'P1', detail: 'd' }, { title: 'P2' }], defaultModel: 'claude-opus-5[1m]',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'P1' },
        { type: 'workflow_agent', index: 1, label: 'one', phaseIndex: 1, phaseTitle: 'P1', agentId: 'a1111111111111111', model: 'claude-opus-5[1m]', state: 'done', startedAt: msOf(T(33)), queuedAt: msOf(T(32, 30)), attempt: 1, toolCalls: 3, tokens: 100, durationMs: 60_000, resultPreview: 'ok', lastProgressAt: msOf(T(34)) },
        { type: 'workflow_phase', index: 2, title: 'P2' },
        { type: 'workflow_agent', index: 2, label: 'two', phaseIndex: 2, phaseTitle: 'P2', agentId: 'a2222222222222222', model: 'claude-opus-5[1m]', state: 'error', startedAt: msOf(T(35)), queuedAt: msOf(T(34, 30)), attempt: 2, lastAttemptReason: 'stalled', error: 'limit', lastProgressAt: msOf(T(40)) },
        { type: 'workflow_agent', index: 3, label: 'gate', phaseIndex: 2, phaseTitle: 'P2', model: 'claude-opus-5[1m]', state: 'error', blocked: true, error: 'blocked by safety classifier', queuedAt: msOf(T(41)), lastProgressAt: msOf(T(42)) },
      ],
      totalTokens: 100, totalToolCalls: 3,
    }))
    await writeFile(path.join(runA, 'journal.jsonl'), jsonl([
      { type: 'launched' },
      { type: 'started', key: 'v2:k3', agentId: 'a3333333333333333', label: 'orphan', phase: 'P2' },
      { type: 'failed', key: 'v2:k3', agentId: 'a3333333333333333' },
      { type: 'launched' },
      { type: 'started', key: 'v2:k1', agentId: 'a1111111111111111', label: 'one', phase: 'P1' },
      { type: 'result', key: 'v2:k1', agentId: 'a1111111111111111', result: { ok: true } },
      { type: 'started', key: 'v2:k2', agentId: 'a2222222222222222', label: 'two', phase: 'P2' },
      { type: 'failed', key: 'v2:k2', agentId: 'a2222222222222222' },
      { type: 'failed', key: 'v2:k4', agentId: '' },
    ]))
    await writeFile(path.join(runA, 'agent-a1111111111111111.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'one', workflowPhase: 'P1', spawnDepth: 1 }))
    await writeFile(path.join(runA, 'agent-a1111111111111111.jsonl'), transcript('a1111111111111111', T(33), T(34)))
    await writeFile(path.join(runA, 'agent-a2222222222222222.meta.json'), JSON.stringify({ agentType: 'prd-verifier', description: 'two', workflowPhase: 'P2', spawnDepth: 1 }))
    await writeFile(path.join(runA, 'agent-a2222222222222222.jsonl'), transcript('a2222222222222222', T(35), T(40)))
    // The orphan ran during the first attempt; the record of the second attempt does not list it
    await writeFile(path.join(runA, 'agent-a3333333333333333.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'orphan', workflowPhase: 'P2', spawnDepth: 1 }))
    await writeFile(path.join(runA, 'agent-a3333333333333333.jsonl'), transcript('a3333333333333333', T(2), T(20)))

    // Run B: no record yet; one agent started, per the journal
    await writeFile(path.join(runB, 'journal.jsonl'), jsonl([{ type: 'launched' }, { type: 'started', key: 'v2:k5', agentId: 'a4444444444444444', label: 'late', phase: 'Only' }]))
    await writeFile(path.join(runB, 'agent-a4444444444444444.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'late', workflowPhase: 'Only', spawnDepth: 1 }))
    await writeFile(path.join(runB, 'agent-a4444444444444444.jsonl'), transcript('a4444444444444444', T(61), T(65)))

    // Run K: killed with TaskStop; the record lists one agent in progress and one never started
    await writeFile(path.join(records, `${RUN_K}.json`), JSON.stringify({
      runId: RUN_K, timestamp: T(76), taskId: 'w333', status: 'killed', error: 'Error: Workflow aborted', workflowName: 'killer', startTime: msOf(T(70, 5)),
      phases: [{ title: 'K' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'K' },
        { type: 'workflow_agent', index: 1, label: 'inflight', phaseIndex: 1, phaseTitle: 'K', agentId: 'a5555555555555555', state: 'progress', startedAt: msOf(T(71)), queuedAt: msOf(T(70, 30)), lastProgressAt: msOf(T(74)) },
        { type: 'workflow_agent', index: 2, label: 'never', phaseIndex: 1, phaseTitle: 'K', state: 'start', queuedAt: msOf(T(70, 30)), lastProgressAt: msOf(T(70, 30)) },
      ],
    }))
    await writeFile(path.join(runK, 'journal.jsonl'), jsonl([{ type: 'launched' }, { type: 'started', key: 'v2:k6', agentId: 'a5555555555555555', label: 'inflight', phase: 'K' }]))
    await writeFile(path.join(runK, 'agent-a5555555555555555.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'inflight', workflowPhase: 'K', spawnDepth: 1 }))
    await writeFile(path.join(runK, 'agent-a5555555555555555.jsonl'), transcript('a5555555555555555', T(71), T(74)))
  })
  afterAll(async () => { await rm(wdir, { recursive: true, force: true }) })

  it('builds one run per record or run folder, linked to its launches', async () => {
    const tl = await parseAgentTimeline(wjsonl, S, Date.UTC(2027, 0, 1))
    expect(tl.workflows.map(w => w.id)).toEqual([RUN_A, RUN_B, RUN_K])
    const a = tl.workflows[0]
    expect(a).toMatchObject({
      name: 'gen', summary: 'Gen', status: 'completed', task_ids: ['w111', 'w111b'], attempts: 2, resumed: true,
      launch_tool_use_id: 'toolu_W1', launch_turn_uuid: 'a1', has_record: true, agent_count: 4,
      done_count: 1, error_count: 3, blocked_count: 1, running_count: 0, total_tokens: 100, total_tool_calls: 3,
      phases: [{ index: 1, title: 'P1', detail: 'd' }, { index: 2, title: 'P2' }],
      error: undefined, script_path: '/repo/.claude/workflows/gen.mjs', default_model: 'claude-opus-5[1m]',
    })
    expect(a.start).toBe(T(1)) // the first launch, before the record's resume-time startTime
    expect(a.end).toBe(T(50)) // the completion notification, after the record timestamp
    const rows = tl.agents.filter(x => x.workflow_id === RUN_A)
    expect(a.estimated_cost).toBeCloseTo(rows.reduce((s, r) => s + r.estimated_cost, 0), 10)
    expect(a.estimated_cost).toBeGreaterThan(0)
    // The big record fields never reach the payload
    const json = JSON.stringify(tl)
    expect(json).not.toContain('SCRIPT_MARKER')
    expect(json).not.toContain('RESULT_MARKER')
  })

  it('completes the agent rows from the record, the journal, and synthesizes the missing ones', async () => {
    const tl = await parseAgentTimeline(wjsonl, S, Date.UTC(2027, 0, 1))
    const byId = Object.fromEntries(tl.agents.map(x => [x.id, x]))
    expect(byId.a1111111111111111).toMatchObject({
      workflow_id: RUN_A, parent_id: null, depth: 1, description: 'one', agent_type: 'workflow-subagent', model: 'claude-opus-5',
      outcome: 'completed', workflow_state: 'done', workflow_index: 1, workflow_phase: 'P1', workflow_phase_index: 1,
      workflow_tool_calls: 3, workflow_result_preview: 'ok', workflow_attempt: 1, queued_at: T(32, 30), has_transcript: true,
      launch_tool_use_id: undefined, turns: 1,
    })
    expect(byId.a1111111111111111.start).toBe(T(33))
    expect(byId.a1111111111111111.end).toBe(T(34))
    expect(byId.a2222222222222222).toMatchObject({ outcome: 'failed', workflow_state: 'error', workflow_error: 'limit', workflow_attempt: 2, workflow_attempt_reason: 'stalled', agent_type: 'prd-verifier' })
    // Blocked: no transcript, so a synthesized row spanning its queue time
    const blocked = byId[`${RUN_A}#3`]
    expect(blocked).toMatchObject({ outcome: 'failed', workflow_state: 'blocked', has_transcript: false, turns: 0, estimated_cost: 0, description: 'gate', workflow_phase_index: 2, workflow_error: 'blocked by safety classifier' })
    expect(blocked.start).toBe(T(41))
    expect(blocked.end).toBe(T(42))
    // Orphan of the first attempt: the journal says it failed
    expect(byId.a3333333333333333).toMatchObject({ workflow_id: RUN_A, workflow_state: 'error', outcome: 'failed', description: 'orphan', workflow_phase: 'P2', workflow_phase_index: 2 })
    expect(byId.a3333333333333333.workflow_index).toBeUndefined()
    // Plain agent untouched
    expect(byId.eee).toMatchObject({ outcome: 'unknown', launch_turn_uuid: 'a1', parent_id: null })
    expect(byId.eee.workflow_id).toBeUndefined()
    expect(byId.eee.has_transcript).toBeUndefined()
    // Session span covers the runs
    expect(tl.start).toBe(T(0))
    expect(tl.end).toBe(T(76))
  })

  it('treats a run without a record as running while its transcripts are fresh, then unknown', async () => {
    const fresh = await parseAgentTimeline(wjsonl, S, msOf(T(65)) + 30_000)
    const b = fresh.workflows.find(w => w.id === RUN_B)!
    expect(b).toMatchObject({ name: 'inline-gen', status: 'running', has_record: false, task_ids: ['w222'], attempts: 1, launch_turn_uuid: 'a3', agent_count: 1, running_count: 1, phases: [{ index: 1, title: 'Only' }] })
    expect(b.start).toBe(T(60))
    expect(b.end).toBe(new Date(msOf(T(65)) + 30_000).toISOString())
    const late = fresh.agents.find(x => x.id === 'a4444444444444444')!
    expect(late).toMatchObject({ outcome: 'running', workflow_state: 'running', workflow_phase: 'Only', workflow_phase_index: 1 })

    const stale = await parseAgentTimeline(wjsonl, S, Date.UTC(2027, 0, 1))
    const b2 = stale.workflows.find(w => w.id === RUN_B)!
    expect(b2.status).toBe('unknown')
    expect(b2.end).toBe(T(65))
    expect(stale.agents.find(x => x.id === 'a4444444444444444')!.outcome).toBe('unknown')
  })

  it('marks a killed run and its unfinished agents as killed', async () => {
    const tl = await parseAgentTimeline(wjsonl, S, Date.UTC(2027, 0, 1))
    const k = tl.workflows.find(w => w.id === RUN_K)!
    expect(k).toMatchObject({ name: 'killer', status: 'killed', error: 'Error: Workflow aborted', agent_count: 2, running_count: 2 })
    expect(tl.agents.find(x => x.id === 'a5555555555555555')).toMatchObject({ outcome: 'killed', workflow_state: 'running' })
    expect(tl.agents.find(x => x.id === `${RUN_K}#2`)).toMatchObject({ outcome: 'killed', workflow_state: 'queued', has_transcript: false, description: 'never' })
  })

  it('returns no workflows for a session without any', async () => {
    const tl = await parseAgentTimeline(jsonlPath, SESSION, Date.UTC(2027, 0, 1))
    expect(tl.workflows).toEqual([])
    expect(tl.agents.every(a => a.workflow_id === undefined)).toBe(true)
  })
})

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { FALLBACK_MODEL, agentsCost, sessionCost } from '@/lib/pricing'

// Fixture-driven test against a fake ~/.claude dir. CLAUDE_CONFIG_DIR is read
// at module load, so the reader is imported dynamically after env setup.
let tmpDir: string
let reader: typeof import('@/lib/claude-reader')
let previousClaudeConfigDir: string | undefined

const SESSION_ID = 'abc12345-0000-0000-0000-000000000000'
/** Earlier session that spawned sub-agents; sorted after SESSION_ID */
const AGENT_SESSION_ID = 'def67890-0000-0000-0000-000000000000'
/** Oldest session: assistant lines carry no model, plus one sub-agent */
const LEGACY_SESSION_ID = '01234567-0000-0000-0000-000000000000'

function assistantLine(ts: string, model: string | undefined, usage: Record<string, number>) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { model, usage, content: [] } })
}

const agentSessionLines = [
  JSON.stringify({ type: 'user', timestamp: '2026-05-01T10:00:00.000Z', cwd: '/Users/test/proj', message: { content: 'Spawn agents' } }),
  assistantLine('2026-05-01T10:01:00.000Z', 'claude-opus-4-8', { input_tokens: 10, output_tokens: 20 }),
]
const sonnetAgentLines = [
  assistantLine('2026-05-01T10:02:00.000Z', 'claude-sonnet-4-5', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 3000 }),
  '{malformed',
  assistantLine('2026-05-01T10:03:00.000Z', 'claude-sonnet-4-5', { input_tokens: 1000, output_tokens: 500 }),
]
const modelLessAgentLines = [
  assistantLine('2026-05-01T10:04:00.000Z', undefined, { input_tokens: 7, output_tokens: 3 }),
]

const legacySessionLines = [
  JSON.stringify({ type: 'user', timestamp: '2026-04-01T10:00:00.000Z', cwd: '/Users/test/proj', message: { content: 'Old session' } }),
  assistantLine('2026-04-01T10:01:00.000Z', undefined, { input_tokens: 40, output_tokens: 60 }),
]

const jsonlLines = [
  JSON.stringify({
    type: 'user',
    timestamp: '2026-06-01T10:00:00.000Z',
    cwd: '/Users/test/proj',
    slug: 'happy-otter',
    version: '2.1.62',
    gitBranch: 'main',
    sessionId: SESSION_ID,
    message: { content: '<system-reminder>injected noise</system-reminder>Hello world' },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-01T10:01:00.000Z',
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'tool_use', name: 'mcp__foo__bar', input: {} },
      ],
    },
  }),
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: '2026-06-01T10:02:00.000Z',
  }),
  '{this line is malformed json',
]

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-test-'))
  const projectDir = path.join(tmpDir, 'projects', '-Users-test-proj')
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), jsonlLines.join('\n'))

  await fs.writeFile(path.join(projectDir, `${AGENT_SESSION_ID}.jsonl`), agentSessionLines.join('\n'))
  const subagents = path.join(projectDir, AGENT_SESSION_ID, 'subagents')
  const run = path.join(subagents, 'workflows', 'wf_aaaaaaaa-111')
  await fs.mkdir(run, { recursive: true })
  await fs.writeFile(path.join(subagents, 'agent-aaa.jsonl'), sonnetAgentLines.join('\n'))
  await fs.writeFile(path.join(run, 'agent-bbb.jsonl'), modelLessAgentLines.join('\n'))
  await fs.writeFile(path.join(run, 'agent-bbb.meta.json'), JSON.stringify({ model: 'claude-haiku-4-5' }))
  await fs.writeFile(path.join(subagents, 'agent-ddd.jsonl'), modelLessAgentLines.join('\n'))
  await fs.mkdir(path.join(subagents, 'agent-ccc.jsonl'))
  await fs.writeFile(path.join(subagents, 'agent-fff.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-05-01T10:06:00.000Z', message: { content: 'go' } }))

  await fs.writeFile(path.join(projectDir, `${LEGACY_SESSION_ID}.jsonl`), legacySessionLines.join('\n'))
  const legacySubagents = path.join(projectDir, LEGACY_SESSION_ID, 'subagents')
  await fs.mkdir(legacySubagents, { recursive: true })
  await fs.writeFile(path.join(legacySubagents, 'agent-aaa.jsonl'), sonnetAgentLines.join('\n'))

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

describe('getAllParsedSessions', () => {
  it('parses a session JSONL into metadata', async () => {
    const sessions = await reader.getAllParsedSessions()
    expect(sessions).toHaveLength(3)

    const s = sessions[0]
    expect(s.session_id).toBe(SESSION_ID)
    expect(s.agent_count).toBeUndefined()
    expect(s.agent_model_usage).toBeUndefined()
    expect(s.project_path).toBe('/Users/test/proj')
    expect(s.user_message_count).toBe(1)
    expect(s.assistant_message_count).toBe(1)
    expect(s.duration_minutes).toBeCloseTo(2)

    expect(s.input_tokens).toBe(100)
    expect(s.output_tokens).toBe(50)
    expect(s.cache_read_input_tokens).toBe(1000)
    expect(s.cache_creation_input_tokens).toBe(200)
    expect(s.model_usage!['claude-opus-4-8'].inputTokens).toBe(100)

    expect(s.tool_counts).toEqual({ Bash: 1, mcp__foo__bar: 1 })
    expect(s.uses_mcp).toBe(true)
    expect(s.has_thinking).toBe(true)
    expect(s.has_compaction).toBe(true)

    expect(s.slug_name).toBe('happy-otter')
    expect(s.cc_version).toBe('2.1.62')
    expect(s.git_branch).toBe('main')
  })

  it('strips wrapper tags from the first prompt without eating surrounding text', async () => {
    const sessions = await reader.getAllParsedSessions()
    expect(sessions[0].first_prompt).toBe('Hello world')
  })

  it('folds sub-agent transcripts into the session totals', async () => {
    const sessions = await reader.getAllParsedSessions()
    const s = sessions.find(x => x.session_id === AGENT_SESSION_ID)!
    expect(s).toBeDefined()

    // Orchestrator 10/20 + sonnet 2000/1000 + two model-less agents at 7/3
    expect(s.input_tokens).toBe(2024)
    expect(s.output_tokens).toBe(1026)
    expect(s.cache_read_input_tokens).toBe(3000)
    expect(s.agent_count).toBe(3)
    expect(s.uses_task_agent).toBe(true)

    const mu = s.model_usage!
    expect(mu['claude-sonnet-4-5']).toMatchObject({ inputTokens: 2000, outputTokens: 1000, cacheReadInputTokens: 3000 })
    expect(mu['claude-haiku-4-5']).toMatchObject({ inputTokens: 7, outputTokens: 3 })
    expect(mu['claude-opus-4-8']).toMatchObject({ inputTokens: 17, outputTokens: 23 })
    expect(Object.keys(mu).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-5'])

    expect(s.agent_model_usage!['claude-sonnet-4-5']).toMatchObject({ inputTokens: 2000, outputTokens: 1000 })
    expect(s.agent_model_usage!['claude-haiku-4-5']).toMatchObject({ inputTokens: 7, outputTokens: 3 })
    expect(s.agent_model_usage!['claude-opus-4-8']).toMatchObject({ inputTokens: 7, outputTokens: 3 })
    const { estimateTotalCostFromModel } = await import('@/lib/pricing')
    const total = sessionCost(s)
    const mainOnly = estimateTotalCostFromModel('claude-opus-4-8', { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0 })
    expect(agentsCost(s)).toBeGreaterThan(0)
    expect(total - agentsCost(s)).toBeCloseTo(mainOnly, 10)
  })

  it('keeps pricing a model-less orchestrator when agents are folded in', async () => {
    const sessions = await reader.getAllParsedSessions()
    const s = sessions.find(x => x.session_id === LEGACY_SESSION_ID)!
    expect(s.agent_count).toBe(1)
    expect(s.input_tokens).toBe(2040)
    expect(Object.keys(s.model_usage!).sort()).toEqual([FALLBACK_MODEL, 'claude-sonnet-4-5'])
    expect(s.model_usage![FALLBACK_MODEL]).toMatchObject({ inputTokens: 40, outputTokens: 60 })

    const { estimateTotalCostFromModel } = await import('@/lib/pricing')
    const mainOnly = estimateTotalCostFromModel(FALLBACK_MODEL, { inputTokens: 40, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0 })
    expect(sessionCost(s) - agentsCost(s)).toBeCloseTo(mainOnly, 10)
  })

  it('picks up a sub-agent transcript that grows after the first scan', async () => {
    const agentFile = path.join(tmpDir, 'projects', '-Users-test-proj', AGENT_SESSION_ID, 'subagents', 'agent-eee.jsonl')
    try {
      const before = (await reader.getAllParsedSessions()).find(x => x.session_id === AGENT_SESSION_ID)!
      await fs.writeFile(agentFile, assistantLine('2026-05-01T10:05:00.000Z', 'claude-sonnet-4-5', { input_tokens: 100, output_tokens: 0 }))
      const grown = (await reader.getAllParsedSessions()).find(x => x.session_id === AGENT_SESSION_ID)!
      expect(grown.input_tokens).toBe(before.input_tokens + 100)
      expect(grown.agent_count).toBe(before.agent_count! + 1)

      await fs.appendFile(agentFile, '\n' + assistantLine('2026-05-01T10:05:30.000Z', 'claude-sonnet-4-5', { input_tokens: 100, output_tokens: 0 }))
      // Ensure a distinct mtime even on coarse filesystems
      const later = new Date(Date.now() + 5000)
      await fs.utimes(agentFile, later, later)
      const after = (await reader.getAllParsedSessions()).find(x => x.session_id === AGENT_SESSION_ID)!
      expect(after.input_tokens).toBe(before.input_tokens + 200)
    } finally {
      await fs.rm(agentFile, { force: true })
    }
  })

  it('honors a sidecar that lands after the transcript was cached', async () => {
    const dir = path.join(tmpDir, 'projects', '-Users-test-proj', AGENT_SESSION_ID, 'subagents')
    const jsonl = path.join(dir, 'agent-0a0.jsonl')
    const meta = path.join(dir, 'agent-0a0.meta.json')
    try {
      await fs.writeFile(jsonl, modelLessAgentLines.join('\n'))
      const before = (await reader.getAllParsedSessions()).find(x => x.session_id === AGENT_SESSION_ID)!
      expect(before.model_usage!['claude-opus-4-8'].inputTokens).toBe(24)
      await fs.writeFile(meta, JSON.stringify({ model: 'claude-haiku-4-5' }))
      const after = (await reader.getAllParsedSessions()).find(x => x.session_id === AGENT_SESSION_ID)!
      expect(after.model_usage!['claude-opus-4-8'].inputTokens).toBe(17)
      expect(after.model_usage!['claude-haiku-4-5'].inputTokens).toBe(14)
    } finally {
      await fs.rm(jsonl, { force: true })
      await fs.rm(meta, { force: true })
    }
  })

  it('serves repeat calls from the mtime cache', async () => {
    const first = await reader.getAllParsedSessions()
    const second = await reader.getAllParsedSessions()
    expect(second).toHaveLength(first.length)
    expect(second[0].session_id).toBe(first[0].session_id)
  })
})

describe('findSessionJSONL', () => {
  it('locates the file for a session id', async () => {
    const file = await reader.findSessionJSONL(SESSION_ID)
    expect(file).toContain(`${SESSION_ID}.jsonl`)
  })

  it('returns null for unknown ids', async () => {
    expect(await reader.findSessionJSONL('does-not-exist')).toBeNull()
  })
})

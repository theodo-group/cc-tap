import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { searchToolCalls, queryWords, matchesAll, inputText, makeSnippet } from '@/lib/tool-search'

const SESSION = 'sess-search'
let dir: string
let jsonlPath: string
const T = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min)).toISOString()
const jsonl = (lines: object[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n'
const call = (uuid: string, ts: string, id: string, name: string, input: object) =>
  ({ type: 'assistant', uuid, timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: unknown, is_error = false, ts = T(0)) =>
  ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } })

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tool-search-'))
  jsonlPath = path.join(dir, `${SESSION}.jsonl`)
  const sub = path.join(dir, SESSION, 'subagents')
  await mkdir(sub, { recursive: true })
  await writeFile(jsonlPath, jsonl([
    call('m1', T(1), 't1', 'Bash', { command: 'cd repo && pnpm run ci-verify', description: 'Verify' }),
    result('t1', 'All 12 tests passed', false, T(5)),
    call('m2', T(2), 't2', 'Bash', { command: 'git status' }),
    result('t2', [{ type: 'text', text: 'ci-verify is not a git command' }], true),
    call('m3', T(3), 't3', 'Read', { file_path: '/x/ci-verify.md' }),
  ]))
  await writeFile(path.join(sub, 'agent-aaa.meta.json'), JSON.stringify({ description: 'Backend agent' }))
  await writeFile(path.join(sub, 'agent-aaa.jsonl'), jsonl([
    call('a1', T(0), 'ta', 'Bash', { command: 'PNPM CI-VERIFY --filter backend' }),
    result('ta', 'ok'),
  ]))
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('helpers', () => {
  it('splits words and requires all of them, case-insensitively, in any order', () => {
    expect(queryWords('  Pnpm   ci-verify ')).toEqual(['pnpm', 'ci-verify'])
    expect(matchesAll('run CI-Verify with pnpm', ['pnpm', 'ci-verify'])).toBe(true)
    expect(matchesAll('pnpm test', ['pnpm', 'ci-verify'])).toBe(false)
    expect(matchesAll('anything', [])).toBe(false)
  })
  it('treats a quoted part as one exact phrase', () => {
    expect(queryWords('"pnpm ci-verify" backend')).toEqual(['pnpm ci-verify', 'backend'])
    expect(queryWords('"  pnpm   ci-verify "')).toEqual(['pnpm ci-verify'])
    expect(queryWords('"unclosed')).toEqual(['"unclosed'])
    const phrase = queryWords('"pnpm ci-verify"')
    expect(matchesAll('cd x && pnpm ci-verify', phrase)).toBe(true)
    expect(matchesAll('cd x && pnpm\n  ci-verify', phrase)).toBe(true) // line break inside the phrase
    expect(matchesAll('pnpm run ci-verify', phrase)).toBe(false)
    expect(matchesAll('pnpm install && make ci-verify', phrase)).toBe(false)
    expect(matchesAll('pnpm install && make ci-verify', queryWords('pnpm ci-verify'))).toBe(true)
  })
  it('searches input values but not JSON keys', () => {
    expect(inputText({ command: 'ls', nested: { flags: ['-a', 2] } })).toBe('ls\n-a\n2')
    expect(matchesAll(inputText({ command: 'ls' }), ['command'])).toBe(false)
  })
  it('makes a one-line snippet around the first match', () => {
    const text = 'x'.repeat(300) + ' pnpm ci-verify ' + 'y'.repeat(300)
    const s = makeSnippet(text, ['ci-verify'], 60)
    expect(s).toContain('ci-verify')
    expect(s.startsWith('…')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(62)
    expect(makeSnippet('short\n\ntext', ['short'])).toBe('short text')
  })
})

describe('searchToolCalls', () => {
  it('finds matches in tool name and input across orchestrator and agents, sorted by time', async () => {
    const r = await searchToolCalls(jsonlPath, SESSION, 'pnpm ci-verify')
    expect(r.total).toBe(2)
    expect(r.matches.map(m => [m.agent_id, m.tool, m.turn_uuid])).toEqual([['aaa', 'Bash', 'a1'], [null, 'Bash', 'm1']])
    expect(r.matches[0].agent_description).toBe('Backend agent')
    expect(r.matches[1].snippet).toBe('cd repo && pnpm run ci-verify Verify')
    expect(r.matches[1].in_result).toBeUndefined()
    expect(r.matches[1].end_timestamp).toBe(T(5)) // result time, even without result scope
    expect(r.truncated).toBe(false)
  })

  it('matches the tool name and file paths', async () => {
    const r = await searchToolCalls(jsonlPath, SESSION, 'read ci-verify')
    expect(r.matches.map(m => m.tool_use_id)).toEqual(['t3'])
  })

  it('searches results only with scope all and flags the match', async () => {
    const input = await searchToolCalls(jsonlPath, SESSION, 'not a git command', 'input')
    expect(input.total).toBe(0)
    const all = await searchToolCalls(jsonlPath, SESSION, 'not a git command', 'all')
    expect(all.total).toBe(1)
    expect(all.matches[0]).toMatchObject({ tool_use_id: 't2', in_result: true, is_error: true })
    expect(all.matches[0].snippet).toContain('not a git command')
  })

  it('returns nothing for an empty query', async () => {
    const r = await searchToolCalls(jsonlPath, SESSION, '   ')
    expect(r).toMatchObject({ total: 0, matches: [], truncated: false })
  })
})

describe('workflow agents', () => {
  let wdir: string
  let wjsonl: string
  beforeAll(async () => {
    wdir = await mkdtemp(path.join(tmpdir(), 'tool-search-wf-'))
    wjsonl = path.join(wdir, 'sess-wf.jsonl')
    const run = path.join(wdir, 'sess-wf', 'subagents', 'workflows', 'wf_xxxxxxxx-111')
    await mkdir(run, { recursive: true })
    await writeFile(wjsonl, jsonl([call('m1', T(1), 't1', 'Bash', { command: 'pnpm ci-verify' })]))
    await writeFile(path.join(run, 'agent-a5555555555555555.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'audit:one', workflowPhase: 'Audit' }))
    await writeFile(path.join(run, 'agent-a5555555555555555.jsonl'), jsonl([call('w1', T(2), 'tw', 'Bash', { command: 'pnpm ci-verify --wf' })]))
    await writeFile(path.join(run, 'journal.jsonl'), '{"type":"launched"}\n')
  })
  afterAll(async () => { await rm(wdir, { recursive: true, force: true }) })

  it('searches the transcripts of workflow agents and tags the matches with the run', async () => {
    const r = await searchToolCalls(wjsonl, 'sess-wf', 'ci-verify')
    expect(r.total).toBe(2)
    expect(r.matches.map(m => [m.agent_id, m.agent_description, m.workflow_id])).toEqual([
      [null, undefined, undefined],
      ['a5555555555555555', 'audit:one', 'wf_xxxxxxxx-111'],
    ])
  })
})

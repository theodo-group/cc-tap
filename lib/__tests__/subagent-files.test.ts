import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  WORKFLOW_RUN_ID_RE, findSubagentFile, listSubagentFiles, listWorkflowRecordIds, listWorkflowRunDirs, readAgentMeta,
  workflowRecordPath, workflowRunDir,
} from '@/lib/subagent-files'

const SESSION = 'sess-files'
let dir: string
let jsonlPath: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'subagent-files-'))
  jsonlPath = path.join(dir, `${SESSION}.jsonl`)
  await writeFile(jsonlPath, '')
  const sub = path.join(dir, SESSION, 'subagents')
  const run = path.join(sub, 'workflows', 'wf_aaaaaaaa-111')
  await mkdir(run, { recursive: true })
  await mkdir(path.join(sub, 'workflows', 'not-a-run'), { recursive: true })
  await mkdir(path.join(dir, SESSION, 'workflows', 'scripts'), { recursive: true })
  await writeFile(path.join(sub, 'agent-aaa.jsonl'), '')
  await writeFile(path.join(sub, 'agent-aaa.meta.json'), JSON.stringify({ description: 'flat', toolUseId: 't1' }))
  await writeFile(path.join(sub, 'notes.txt'), '')
  await writeFile(path.join(run, 'agent-bbb.jsonl'), '')
  await writeFile(path.join(run, 'agent-bbb.meta.json'), JSON.stringify({ description: 'wf', workflowPhase: 'P1' }))
  await writeFile(path.join(run, 'journal.jsonl'), '')
  await writeFile(path.join(sub, 'workflows', 'not-a-run', 'agent-ccc.jsonl'), '')
  await writeFile(path.join(dir, SESSION, 'workflows', 'wf_aaaaaaaa-111.json'), '{}')
  await writeFile(path.join(dir, SESSION, 'workflows', 'wf_bbbbbbbb-222.json'), '{}')
  await writeFile(path.join(dir, SESSION, 'workflows', 'other.json'), '{}')
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('subagent files', () => {
  it('validates run ids', () => {
    expect(WORKFLOW_RUN_ID_RE.test('wf_eb41ad30-875')).toBe(true)
    expect(WORKFLOW_RUN_ID_RE.test('wf_../x')).toBe(false)
    expect(WORKFLOW_RUN_ID_RE.test('agent-abc')).toBe(false)
  })

  it('builds the run paths', () => {
    expect(workflowRunDir(jsonlPath, SESSION, 'wf_x')).toBe(path.join(dir, SESSION, 'subagents', 'workflows', 'wf_x'))
    expect(workflowRecordPath(jsonlPath, SESSION, 'wf_x')).toBe(path.join(dir, SESSION, 'workflows', 'wf_x.json'))
  })

  it('lists the flat folder and every workflow run folder', async () => {
    const files = await listSubagentFiles(jsonlPath, SESSION)
    expect(files.map(f => [f.id, f.workflowId])).toEqual([['aaa', undefined], ['bbb', 'wf_aaaaaaaa-111']])
    expect(files[1].jsonl).toBe(path.join(dir, SESSION, 'subagents', 'workflows', 'wf_aaaaaaaa-111', 'agent-bbb.jsonl'))
    expect(files[1].meta).toBe(path.join(dir, SESSION, 'subagents', 'workflows', 'wf_aaaaaaaa-111', 'agent-bbb.meta.json'))
  })

  it('lists run folders and records by id', async () => {
    expect(await listWorkflowRunDirs(jsonlPath, SESSION)).toEqual(['wf_aaaaaaaa-111'])
    expect((await listWorkflowRecordIds(jsonlPath, SESSION)).sort()).toEqual(['wf_aaaaaaaa-111', 'wf_bbbbbbbb-222'])
  })

  it('finds a transcript wherever it sits', async () => {
    expect((await findSubagentFile(jsonlPath, SESSION, 'aaa'))?.workflowId).toBeUndefined()
    expect((await findSubagentFile(jsonlPath, SESSION, 'bbb'))?.workflowId).toBe('wf_aaaaaaaa-111')
    expect(await findSubagentFile(jsonlPath, SESSION, 'ccc')).toBeNull()
    expect(await findSubagentFile(jsonlPath, SESSION, 'zzz')).toBeNull()
  })

  it('returns an empty list for a session without sub-agents', async () => {
    const other = path.join(dir, 'other.jsonl')
    expect(await listSubagentFiles(other, 'other')).toEqual([])
    expect(await listWorkflowRunDirs(other, 'other')).toEqual([])
  })

  it('reads the sidecar, or an empty object', async () => {
    expect(await readAgentMeta(path.join(dir, SESSION, 'subagents', 'agent-aaa.meta.json'))).toEqual({ description: 'flat', toolUseId: 't1' })
    expect(await readAgentMeta(path.join(dir, SESSION, 'subagents', 'agent-nope.meta.json'))).toEqual({})
  })
})

import { describe, it, expect } from 'vitest'
import {
  capJson, capText, journalByAgent, normalizeAgentState, outcomeForState, parseWorkflowLaunchText, recordPhases, recordStatus,
  stateFromJournal, stripModelSuffix, summarizeRecord, type WorkflowProgressAgent,
} from '@/lib/workflow-runs'

const agent = (over: Partial<WorkflowProgressAgent>): WorkflowProgressAgent => ({ type: 'workflow_agent', index: 1, ...over })

describe('workflow run helpers', () => {
  it('normalizes the agent state', () => {
    expect(normalizeAgentState(agent({ state: 'error', blocked: true }))).toBe('blocked')
    expect(normalizeAgentState(agent({ state: 'done', cached: true }))).toBe('cached')
    expect(normalizeAgentState(agent({ state: 'done' }))).toBe('done')
    expect(normalizeAgentState(agent({ state: 'error' }))).toBe('error')
    expect(normalizeAgentState(agent({ state: 'progress' }))).toBe('running')
    expect(normalizeAgentState(agent({ state: 'start' }))).toBe('queued')
    expect(normalizeAgentState(agent({ state: 'weird', startedAt: 1 }))).toBe('running')
    expect(normalizeAgentState(agent({}))).toBe('queued')
  })

  it('maps a state to an outcome, unfinished agents taking the run fate', () => {
    expect(outcomeForState('done', 'completed')).toBe('completed')
    expect(outcomeForState('cached', 'failed')).toBe('completed')
    expect(outcomeForState('error', 'completed')).toBe('failed')
    expect(outcomeForState('blocked', 'running')).toBe('failed')
    expect(outcomeForState('running', 'running')).toBe('running')
    expect(outcomeForState('running', 'killed')).toBe('killed')
    expect(outcomeForState('queued', 'killed')).toBe('killed')
    expect(outcomeForState('running', 'completed')).toBe('unknown')
    expect(outcomeForState('queued', 'unknown')).toBe('unknown')
  })

  it('reads the record status', () => {
    expect(recordStatus('completed')).toBe('completed')
    expect(recordStatus('failed')).toBe('failed')
    expect(recordStatus('killed')).toBe('killed')
    expect(recordStatus('running')).toBeUndefined()
    expect(recordStatus(undefined)).toBeUndefined()
  })

  it('folds the journal per agent and skips entries without an id', () => {
    const j = journalByAgent([
      { type: 'launched' },
      { type: 'started', key: 'k1', agentId: 'a1', label: 'one', phase: 'P1' },
      { type: 'result', key: 'k1', agentId: 'a1', result: { ok: true } },
      { type: 'started', key: 'k2', agentId: 'a2', label: 'two', phase: 'P2' },
      { type: 'failed', key: 'k2', agentId: 'a2' },
      { type: 'started', key: 'k3', agentId: 'a3', label: 'three' },
      { type: 'failed', key: 'k4', agentId: '' },
    ])
    expect([...j.keys()]).toEqual(['a1', 'a2', 'a3'])
    expect(j.get('a1')).toEqual({ label: 'one', phase: 'P1', started: true, done: true, failed: false })
    expect(stateFromJournal(j.get('a1')!)).toBe('done')
    expect(stateFromJournal(j.get('a2')!)).toBe('error')
    expect(stateFromJournal(j.get('a3')!)).toBe('running')
    expect(stateFromJournal({ started: false, done: false, failed: false })).toBe('queued')
  })

  it('takes phases from the progress entries and details from the declaration', () => {
    expect(recordPhases({
      phases: [{ title: 'B', detail: 'second' }, { title: 'A', detail: 'first' }],
      workflowProgress: [{ type: 'workflow_phase', index: 2, title: 'B' }, { type: 'workflow_phase', index: 1, title: 'A' }],
    })).toEqual([{ index: 1, title: 'A', detail: 'first' }, { index: 2, title: 'B', detail: 'second' }])
    expect(recordPhases({ phases: [{ title: 'Only' }] })).toEqual([{ index: 1, title: 'Only' }])
    expect(recordPhases(undefined)).toEqual([])
  })

  it('parses the launch text', () => {
    expect(parseWorkflowLaunchText('Workflow launched in background. Task ID: w82plpe7v\nSummary: x\nRun ID: wf_1655e19b-d89\n')).toEqual({ task_id: 'w82plpe7v', run_id: 'wf_1655e19b-d89' })
    expect(parseWorkflowLaunchText('permission denied')).toEqual({ task_id: undefined, run_id: undefined })
  })

  it('caps text and json', () => {
    expect(capText('abcdef', 3)).toEqual({ text: 'abc', truncated: true, total_chars: 6 })
    expect(capText('ab', 3)).toEqual({ text: 'ab', truncated: false, total_chars: 2 })
    expect(capJson(undefined, 10)).toBeUndefined()
    expect(capJson('raw', 10)).toEqual({ text: 'raw', truncated: false, total_chars: 3 })
    expect(capJson({ a: 1 }, 100)?.text).toBe('{\n  "a": 1\n}')
    expect(capJson(null, 100)).toEqual({ text: 'null', truncated: false, total_chars: 4 })
  })

  it('strips the model suffix and the large record fields', () => {
    expect(stripModelSuffix('claude-opus-5[1m]')).toBe('claude-opus-5')
    expect(stripModelSuffix('claude-opus-5')).toBe('claude-opus-5')
    expect(stripModelSuffix(undefined)).toBeUndefined()
    const s = summarizeRecord({ runId: 'wf_x', script: 'export default 1', result: { big: true }, args: [1], logs: ['l'], status: 'completed' })
    expect(s).toEqual({ runId: 'wf_x', status: 'completed' })
  })
})

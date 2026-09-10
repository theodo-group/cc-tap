import { describe, it, expect } from 'vitest'
import type { AgentRun, WorkflowRun } from '@/types/claude'
import { groupByRun, isBlocked, isWorkflowFailure, phaseSpans, sortWorkflowAgents, workflowAgentLabel } from '@/lib/workflow-agents'

const T = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min)).toISOString()
const agent = (id: string, over: Partial<AgentRun>): AgentRun => ({
  id, parent_id: null, depth: 1, description: id, agent_type: 'workflow-subagent', prompt: '', start: T(0), end: T(1), duration_ms: 60_000,
  turns: 1, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, estimated_cost: 0,
  outcome: 'completed', nudges: [], children_count: 0, ...over,
})
const run: WorkflowRun = {
  id: 'wf_x', name: 'x', status: 'completed', task_ids: [], attempts: 1, resumed: false, start: T(0), end: T(9), duration_ms: 0,
  phases: [{ index: 2, title: 'Second' }, { index: 1, title: 'First' }, { index: 3, title: 'Empty' }],
  agent_count: 0, done_count: 0, error_count: 0, blocked_count: 0, running_count: 0, estimated_cost: 0, has_record: true,
}

describe('workflow agent helpers', () => {
  const a1 = agent('a1', { workflow_id: 'wf_x', workflow_phase_index: 1, start: T(1), end: T(3), workflow_state: 'done' })
  const a2 = agent('a2', { workflow_id: 'wf_x', workflow_phase_index: 2, start: T(4), end: T(6), workflow_state: 'error' })
  const a3 = agent('a3', { workflow_id: 'wf_x', workflow_phase_index: 1, start: T(0), end: T(2), workflow_state: 'blocked' })
  const a4 = agent('a4', { workflow_id: 'wf_x', start: T(5), end: T(5) })
  const plain = agent('p', {})

  it('groups by run, leaving plain agents out', () => {
    const g = groupByRun([a1, plain, a2])
    expect([...g.keys()]).toEqual(['wf_x'])
    expect(g.get('wf_x')!.map(a => a.id)).toEqual(['a1', 'a2'])
  })

  it('sorts by phase then start, agents without a phase last', () => {
    expect(sortWorkflowAgents([a4, a2, a1, a3]).map(a => a.id)).toEqual(['a3', 'a1', 'a2', 'a4'])
  })

  it('spans each phase that has agents, in phase order', () => {
    expect(phaseSpans(run, [a1, a2, a3, a4])).toEqual([
      { index: 1, title: 'First', start: new Date(T(0)).getTime(), end: new Date(T(3)).getTime() },
      { index: 2, title: 'Second', start: new Date(T(4)).getTime(), end: new Date(T(6)).getTime() },
    ])
  })

  it('flags failures and labels agents with their phase', () => {
    expect(isBlocked(a3)).toBe(true)
    expect(isWorkflowFailure(a2)).toBe(true)
    expect(isWorkflowFailure(a3)).toBe(true)
    expect(isWorkflowFailure(a1)).toBe(false)
    expect(workflowAgentLabel(run, a1)).toBe('P1 · a1')
    expect(workflowAgentLabel(run, a4)).toBe('a4')
    expect(workflowAgentLabel({ ...run, phases: [run.phases[0]] }, a1)).toBe('a1')
    expect(workflowAgentLabel(undefined, a1)).toBe('a1')
  })
})

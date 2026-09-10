import type { AgentRun, WorkflowAgentState, WorkflowRun } from '@/types/claude'

/** Pure helpers over the timeline payload; safe to import from client components */

export const WORKFLOW_STATE_LABEL: Record<WorkflowAgentState, string> = {
  done:    'done',
  cached:  'cached',
  error:   'failed',
  blocked: 'blocked',
  running: 'running',
  queued:  'queued',
}

export function isBlocked(a: AgentRun): boolean {
  return a.workflow_state === 'blocked'
}

/** An agent that did not deliver: failed, or never started */
export function isWorkflowFailure(a: AgentRun): boolean {
  return a.workflow_state === 'error' || a.workflow_state === 'blocked'
}

/** Agents per run id; agents outside a run are left out */
export function groupByRun(agents: AgentRun[]): Map<string, AgentRun[]> {
  const out = new Map<string, AgentRun[]>()
  for (const a of agents) {
    if (!a.workflow_id) continue
    out.set(a.workflow_id, [...(out.get(a.workflow_id) ?? []), a])
  }
  return out
}

/** Phase order first (agents without a phase last), then start time */
export function sortWorkflowAgents(agents: AgentRun[]): AgentRun[] {
  const rank = (a: AgentRun) => a.workflow_phase_index ?? Number.MAX_SAFE_INTEGER
  return [...agents].sort((a, b) => rank(a) - rank(b) || a.start.localeCompare(b.start) || (a.workflow_index ?? 0) - (b.workflow_index ?? 0))
}

/** [first start, last end] in ms of each phase that has agents, in phase order */
export function phaseSpans(run: WorkflowRun, agents: AgentRun[]): Array<{ index: number; title: string; start: number; end: number }> {
  const out: Array<{ index: number; title: string; start: number; end: number }> = []
  for (const p of [...run.phases].sort((a, b) => a.index - b.index)) {
    const own = agents.filter(a => a.workflow_phase_index === p.index)
    if (own.length === 0) continue
    const start = Math.min(...own.map(a => new Date(a.start).getTime()))
    const end = Math.max(...own.map(a => new Date(a.end).getTime()))
    if (Number.isFinite(start) && Number.isFinite(end)) out.push({ index: p.index, title: p.title, start, end: Math.max(start, end) })
  }
  return out
}

/** "P2 · label" when the run has more than one phase */
export function workflowAgentLabel(run: WorkflowRun | undefined, a: AgentRun): string {
  if (run && run.phases.length > 1 && a.workflow_phase_index !== undefined) return `P${a.workflow_phase_index} · ${a.description}`
  return a.description
}

import path from 'path'
import { readFile } from 'fs/promises'
import type { AgentOutcome, CappedText, WorkflowAgentState, WorkflowPhase } from '@/types/claude'
import { readJSONLLines } from '@/lib/claude-reader'

// ─── On-disk formats, as written by Claude Code ───────────────────────────────

export interface WorkflowProgressPhase {
  type: 'workflow_phase'
  index: number
  title: string
}

/** One agent() call of a run, from the record's workflowProgress */
export interface WorkflowProgressAgent {
  type: 'workflow_agent'
  index: number
  label?: string
  phaseIndex?: number
  phaseTitle?: string
  /** absent when the agent never started (blocked, queued) */
  agentId?: string
  agentType?: string
  model?: string
  /** done | error | progress | start */
  state?: string
  startedAt?: number
  queuedAt?: number
  lastProgressAt?: number
  attempt?: number
  lastAttemptReason?: string
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  promptFramed?: boolean
  tokens?: number
  toolCalls?: number
  durationMs?: number
  resultPreview?: string
  error?: string
  blocked?: boolean
  cached?: boolean
}

export type WorkflowProgressEntry = WorkflowProgressAgent | WorkflowProgressPhase | { type: string }

/** <session>/workflows/wf_<id>.json */
export interface WorkflowRecord {
  runId?: string
  /** ISO, when the run ended */
  timestamp?: string
  taskId?: string
  script?: string
  scriptPath?: string
  args?: unknown
  result?: unknown
  agentCount?: number
  logs?: string[]
  durationMs?: number
  error?: string
  summary?: string
  workflowName?: string
  /** completed | failed | killed */
  status?: string
  /** ms epoch; for a resumed run, the time of the resume */
  startTime?: number
  phases?: Array<{ title: string; detail?: string }>
  defaultModel?: string
  workflowProgress?: WorkflowProgressEntry[]
  totalTokens?: number
  totalToolCalls?: number
}

/** The record without its large fields, safe to keep in memory and to send */
export type WorkflowRecordSummary = Omit<WorkflowRecord, 'script' | 'result' | 'args' | 'logs'>

/** One line of <run dir>/journal.jsonl */
export interface JournalEntry {
  type: string
  key?: string
  agentId?: string
  label?: string
  phase?: string
  result?: unknown
}

export interface JournalFacts {
  label?: string
  phase?: string
  started: boolean
  done: boolean
  failed: boolean
}

// ─── Readers ─────────────────────────────────────────────────────────────────

export async function readWorkflowRecord(recordPath: string): Promise<WorkflowRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(recordPath, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed as WorkflowRecord : null
  } catch { return null }
}

export function summarizeRecord(r: WorkflowRecord): WorkflowRecordSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { script, result, args, logs, ...rest } = r
  return rest
}

export async function readWorkflowJournal(runDir: string): Promise<JournalEntry[]> {
  const out: JournalEntry[] = []
  await readJSONLLines(path.join(runDir, 'journal.jsonl'), l => {
    if (typeof l.type === 'string') out.push(l as unknown as JournalEntry)
  })
  return out
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Facts per agent id; entries without an id are skipped */
export function journalByAgent(entries: JournalEntry[]): Map<string, JournalFacts> {
  const out = new Map<string, JournalFacts>()
  for (const e of entries) {
    if (!e.agentId) continue
    const f = out.get(e.agentId) ?? { started: false, done: false, failed: false }
    if (e.type === 'started') { f.started = true; f.label = f.label ?? e.label; f.phase = f.phase ?? e.phase }
    else if (e.type === 'result') f.done = true
    else if (e.type === 'failed') f.failed = true
    out.set(e.agentId, f)
  }
  return out
}

export function progressAgents(r?: WorkflowRecordSummary): WorkflowProgressAgent[] {
  return (r?.workflowProgress ?? []).filter((e): e is WorkflowProgressAgent => e.type === 'workflow_agent')
}

/**
 * The run's phases, 1-based. The progress entries carry the index the agents
 * refer to; the declared `phases` add the detail text.
 */
export function recordPhases(r?: WorkflowRecordSummary): WorkflowPhase[] {
  if (!r) return []
  const declared = r.phases ?? []
  const fromProgress = (r.workflowProgress ?? [])
    .filter((e): e is WorkflowProgressPhase => e.type === 'workflow_phase' && typeof (e as WorkflowProgressPhase).index === 'number')
  const out: WorkflowPhase[] = fromProgress.length > 0
    ? fromProgress.map(p => ({ index: p.index, title: p.title, detail: declared.find(d => d.title === p.title)?.detail }))
    : declared.map((d, i) => ({ index: i + 1, title: d.title, detail: d.detail }))
  return out
    .map(p => (p.detail === undefined ? { index: p.index, title: p.title } : p))
    .sort((a, b) => a.index - b.index)
}

export function normalizeAgentState(p: WorkflowProgressAgent): WorkflowAgentState {
  if (p.blocked) return 'blocked'
  if (p.cached) return 'cached'
  switch (p.state) {
    case 'done': return 'done'
    case 'error': return 'error'
    case 'progress': return 'running'
    case 'start': return 'queued'
    default: return p.startedAt ? 'running' : 'queued'
  }
}

export function stateFromJournal(j: JournalFacts): WorkflowAgentState {
  if (j.done) return 'done'
  if (j.failed) return 'error'
  if (j.started) return 'running'
  return 'queued'
}

/** An agent's outcome from its state; an unfinished agent takes the run's fate */
export function outcomeForState(state: WorkflowAgentState, runStatus: AgentOutcome): AgentOutcome {
  switch (state) {
    case 'done':
    case 'cached': return 'completed'
    case 'error':
    case 'blocked': return 'failed'
    default:
      if (runStatus === 'killed') return 'killed'
      if (runStatus === 'running') return 'running'
      return 'unknown'
  }
}

export function recordStatus(status: string | undefined): AgentOutcome | undefined {
  if (status === 'completed' || status === 'failed' || status === 'killed') return status
  return undefined
}

/** Fallback when the structured toolUseResult is missing: the launch text lists the ids */
export function parseWorkflowLaunchText(text: string): { task_id?: string; run_id?: string } {
  const task = /Task ID:\s*(\S+)/.exec(text)
  const run = /Run ID:\s*(wf_\S+)/.exec(text)
  return { task_id: task?.[1], run_id: run?.[1] }
}

export function capText(text: string, maxChars: number): CappedText {
  return { text: text.length > maxChars ? text.slice(0, maxChars) : text, truncated: text.length > maxChars, total_chars: text.length }
}

/** JSON (or a string as is), size-capped; undefined stays undefined */
export function capJson(value: unknown, maxChars: number): CappedText | undefined {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)
  return capText(text, maxChars)
}

/** "claude-opus-5[1m]" -> "claude-opus-5" */
export function stripModelSuffix(model?: string): string | undefined {
  return model?.replace(/\[[^\]]*\]$/, '') || undefined
}

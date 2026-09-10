import path from 'path'
import { stat } from 'fs/promises'
import type { AgentOutcome, AgentRun, AgentTimeline, ContextEvent, PromptTick, TimeSegment, TurnUsage, WorkflowAgentState, WorkflowPhase, WorkflowRun } from '@/types/claude'
import { estimateCostFromUsage } from '@/lib/pricing'
import { mapPool, readJSONLLines } from '@/lib/claude-reader'
import { resultText } from '@/lib/tool-search'
import {
  WORKFLOW_RUN_ID_RE, listSubagentFiles, listWorkflowRecordIds, listWorkflowRunDirs, readAgentMeta,
  workflowRecordPath, workflowRunDir, type AgentMeta,
} from '@/lib/subagent-files'
import {
  journalByAgent, normalizeAgentState, outcomeForState, parseWorkflowLaunchText, progressAgents, readWorkflowJournal,
  readWorkflowRecord, recordPhases, recordStatus, stateFromJournal, stripModelSuffix, summarizeRecord,
  type JournalEntry, type WorkflowProgressAgent, type WorkflowRecordSummary,
} from '@/lib/workflow-runs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLine = Record<string, any>

/** An agent is considered live when its transcript changed within this window */
export const RUNNING_WINDOW_MS = 2 * 60_000

interface LaunchInfo {
  timestamp: string
  assistant_uuid: string
  description?: string
  subagent_type?: string
  model?: string
  prompt?: string
}

interface Notification {
  taskId: string
  status: string
  timestamp: string
}

/** A Workflow tool_use, from its input */
export interface WorkflowLaunchInfo {
  timestamp: string
  assistant_uuid: string
  name?: string
  script_path?: string
  inline_script: boolean
  resume_from_run_id?: string
}

/** A Workflow tool_result, from its structured toolUseResult (or the text as a fallback) */
export interface WorkflowLaunchResult {
  run_id: string
  task_id?: string
  name?: string
  summary?: string
  script_path?: string
  timestamp: string
}

/** Facts collected from one transcript (orchestrator or agent) */
interface TranscriptScan {
  first?: string
  last?: string
  assistantCount: number
  usage: TurnUsage
  model?: string
  /** Agent tool_use id -> launch info */
  launches: Map<string, LaunchInfo>
  /** SendMessage target -> timestamps */
  nudges: Map<string, string[]>
  notifications: Notification[]
  /** TaskStop task ids */
  stops: Set<string>
  busy: TimeSegment[]
  prompts: PromptTick[]
  /** Workflow tool_use id -> launch input */
  workflowLaunches: Map<string, WorkflowLaunchInfo>
  /** Workflow tool_use id -> launch result */
  workflowResults: Map<string, WorkflowLaunchResult>
}

function emptyUsage(): TurnUsage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
}

function addUsage(acc: TurnUsage, u: Partial<TurnUsage> | undefined) {
  if (!u) return
  acc.input_tokens                += u.input_tokens ?? 0
  acc.output_tokens               += u.output_tokens ?? 0
  acc.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
  acc.cache_read_input_tokens     += u.cache_read_input_tokens ?? 0
}

const NOTIFICATION_RE = /<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g

export function parseNotifications(text: string, timestamp: string): Notification[] {
  const out: Notification[] = []
  for (const m of text.matchAll(NOTIFICATION_RE)) {
    out.push({ taskId: m[1].trim(), status: m[2].trim(), timestamp })
  }
  return out
}

export interface Rewind {
  timestamp: string
  uuid: string
  rewound_to_uuid: string
  discarded_uuids: string[]
}

/**
 * A rewind leaves no marker in the log. It shows up as a fork: a message whose
 * parentUuid points to an earlier message instead of the previous one. Every
 * message between that parent and the fork was discarded.
 */
export function findRewinds(lines: AnyLine[]): Rewind[] {
  const out: Rewind[] = []
  const indexByUuid = new Map<string, number>()
  const messages: AnyLine[] = []
  let prev: string | undefined
  for (const l of lines) {
    if (l.type !== 'user' && l.type !== 'assistant') continue
    const uuid: string | undefined = l.uuid
    const parent: string | undefined = l.parentUuid ?? undefined
    // Tool results are parented to their own tool call. When several calls run
    // in parallel, the results fan out from the same message: not a rewind.
    const content = l.message?.content
    const isToolResult = Array.isArray(content) && content.some((c: AnyLine) => c?.type === 'tool_result')
    if (!isToolResult && prev && parent && parent !== prev && indexByUuid.has(parent)) {
      const from = indexByUuid.get(parent)! + 1
      out.push({
        timestamp: l.timestamp ?? '',
        uuid: uuid ?? '',
        rewound_to_uuid: parent,
        discarded_uuids: messages.slice(from).map(m => m.uuid).filter((u): u is string => !!u),
      })
      // Later messages continue from the fork; the discarded ones are no longer "current"
      messages.length = from
    }
    if (uuid) { indexByUuid.set(uuid, messages.length); messages.push(l) }
    prev = uuid
  }
  return out
}

const CLEAR_RE = /<command-name>\/clear<\/command-name>/

export function findContextEvents(lines: AnyLine[]): ContextEvent[] {
  const events: ContextEvent[] = []
  for (const l of lines) {
    if (l.type === 'system' && l.subtype === 'compact_boundary') {
      const m = l.compactMetadata ?? {}
      events.push({
        type: 'compact', timestamp: l.timestamp ?? '', uuid: l.uuid ?? '',
        trigger: m.trigger ?? 'auto', pre_tokens: m.preTokens, post_tokens: m.postTokens, duration_ms: m.durationMs,
      })
      continue
    }
    if (l.type === 'user') {
      const c = l.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: AnyLine) => x.text ?? '').join('') : ''
      if (CLEAR_RE.test(text)) events.push({ type: 'clear', timestamp: l.timestamp ?? '', uuid: l.uuid ?? '' })
    }
  }
  for (const r of findRewinds(lines)) {
    events.push({ type: 'rewind', timestamp: r.timestamp, uuid: r.uuid, rewound_to_uuid: r.rewound_to_uuid, discarded_turns: r.discarded_uuids.length })
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

/** True when a user line is a message typed by a human (not a tool result, not system-injected) */
export function isHumanPrompt(l: AnyLine): string | null {
  if (l.type !== 'user') return null
  if (l.isMeta === true) return null
  if (l.origin?.kind === 'task-notification') return null
  if (l.promptSource === 'system') return null
  const content = l.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.some((c: AnyLine) => c.type === 'tool_result')) return null
    text = content.filter((c: AnyLine) => c.type === 'text').map((c: AnyLine) => c.text ?? '').join('')
  }
  text = text.trim()
  if (!text || text.startsWith('<')) return null
  return text
}

/**
 * The launch result of a Workflow call. Claude Code stores it structured in the
 * line's `toolUseResult`; when that is missing the text of the result still
 * names the run and task ids.
 */
function workflowResultOf(line: AnyLine, block: AnyLine, trustStructured: boolean, knownLaunch: boolean, ts: string): WorkflowLaunchResult | undefined {
  const tur = line.toolUseResult
  if (trustStructured && tur && typeof tur === 'object' && tur.taskType === 'local_workflow' && typeof tur.runId === 'string') {
    return {
      run_id: tur.runId,
      task_id: typeof tur.taskId === 'string' ? tur.taskId : undefined,
      name: typeof tur.workflowName === 'string' ? tur.workflowName : undefined,
      summary: typeof tur.summary === 'string' ? tur.summary : undefined,
      script_path: typeof tur.scriptPath === 'string' ? tur.scriptPath : undefined,
      timestamp: ts,
    }
  }
  if (!knownLaunch) return undefined
  const { run_id, task_id } = parseWorkflowLaunchText(resultText(block.content))
  return run_id ? { run_id, task_id, timestamp: ts } : undefined
}

export function scanTranscript(lines: AnyLine[]): TranscriptScan {
  const scan: TranscriptScan = {
    assistantCount: 0,
    usage: emptyUsage(),
    launches: new Map(),
    nudges: new Map(),
    notifications: [],
    stops: new Set(),
    busy: [],
    prompts: [],
    workflowLaunches: new Map(),
    workflowResults: new Map(),
  }

  for (const l of lines) {
    const ts: string | undefined = l.timestamp
    if (ts) {
      if (!scan.first || ts < scan.first) scan.first = ts
      if (!scan.last || ts > scan.last) scan.last = ts
    }

    if (l.type === 'system' && l.subtype === 'turn_duration' && ts && typeof l.durationMs === 'number') {
      const end = new Date(ts).getTime()
      scan.busy.push({ start: new Date(end - l.durationMs).toISOString(), end: ts })
      continue
    }

    if (l.type === 'user') {
      const content = l.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map((c: AnyLine) => c.text ?? '').join('\n') : ''
      if (text.includes('<task-notification>') && ts) {
        scan.notifications.push(...parseNotifications(text, ts))
      }
      const human = isHumanPrompt(l)
      if (human && ts) scan.prompts.push({ timestamp: ts, text: human.slice(0, 160) })
      if (Array.isArray(content)) {
        const results = content.filter((c: AnyLine) => c?.type === 'tool_result' && typeof c.tool_use_id === 'string')
        for (const c of results) {
          const known = scan.workflowLaunches.has(c.tool_use_id)
          const found = workflowResultOf(l, c, results.length === 1 || known, known, ts ?? '')
          if (found) scan.workflowResults.set(c.tool_use_id, found)
        }
      }
      continue
    }

    if (l.type === 'assistant') {
      scan.assistantCount++
      const msg = l.message ?? {}
      addUsage(scan.usage, msg.usage)
      if (!scan.model && msg.model) scan.model = msg.model
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const c of content) {
        if (c.type !== 'tool_use') continue
        const input = c.input ?? {}
        if (c.name === 'Agent' || c.name === 'Task') {
          scan.launches.set(c.id, {
            timestamp: ts ?? '',
            assistant_uuid: l.uuid ?? '',
            description: input.description,
            subagent_type: input.subagent_type,
            model: input.model,
            prompt: input.prompt,
          })
        } else if (c.name === 'SendMessage' && typeof input.to === 'string' && ts) {
          const list = scan.nudges.get(input.to) ?? []
          list.push(ts)
          scan.nudges.set(input.to, list)
        } else if (c.name === 'TaskStop' && typeof input.task_id === 'string') {
          scan.stops.add(input.task_id)
        } else if (c.name === 'Workflow') {
          // An inline script names itself in its meta block
          const metaName = typeof input.script === 'string' ? /\bname\s*:\s*(['"`])([^'"`\n]+)\1/.exec(input.script)?.[2] : undefined
          scan.workflowLaunches.set(c.id, {
            timestamp: ts ?? '',
            assistant_uuid: l.uuid ?? '',
            name: typeof input.name === 'string' ? input.name : metaName,
            script_path: typeof input.scriptPath === 'string' ? input.scriptPath : undefined,
            inline_script: typeof input.script === 'string',
            resume_from_run_id: typeof input.resumeFromRunId === 'string' ? input.resumeFromRunId : undefined,
          })
        }
      }
    }
  }
  return scan
}

async function readLines(filePath: string): Promise<AnyLine[]> {
  const lines: AnyLine[] = []
  await readJSONLLines(filePath, l => lines.push(l))
  return lines
}

/**
 * Scans keyed by file identity. A finished transcript never changes, and a
 * session can hold hundreds of them, so repeated requests only pay a stat.
 * The scan holds no line, only the facts, so the cache stays small.
 */
const scanCache = new Map<string, { mtimeMs: number; size: number; mtime: string; scan: TranscriptScan }>()

async function scanFile(filePath: string): Promise<{ scan: TranscriptScan; mtime?: string }> {
  let st: { mtimeMs: number; size: number; mtime: Date } | undefined
  try { st = await stat(filePath) } catch { /* unreadable: scan without caching */ }
  if (!st) return { scan: scanTranscript(await readLines(filePath)) }
  const hit = scanCache.get(filePath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { scan: hit.scan, mtime: hit.mtime }
  const scan = scanTranscript(await readLines(filePath))
  const entry = { mtimeMs: st.mtimeMs, size: st.size, mtime: st.mtime.toISOString(), scan }
  scanCache.set(filePath, entry)
  return { scan, mtime: entry.mtime }
}

export function resolveOutcome(
  agentId: string,
  notifications: Notification[],
  stops: Set<string>,
  lastActivity: string | undefined,
  now: number,
): AgentOutcome {
  const own = notifications.filter(n => n.taskId === agentId).sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const last = own[own.length - 1]
  if (last) {
    if (last.status === 'completed') return 'completed'
    if (last.status === 'failed') return 'failed'
    if (last.status === 'killed') return 'killed'
  }
  if (stops.has(agentId)) return 'killed'
  if (lastActivity && now - new Date(lastActivity).getTime() < RUNNING_WINDOW_MS) return 'running'
  return 'unknown'
}

// ─── Workflow runs ────────────────────────────────────────────────────────────

/** What is on disk for one run */
export interface WorkflowRunInput {
  runId: string
  record?: WorkflowRecordSummary
  journal: JournalEntry[]
  journalMtime?: string
}

/** Per-agent facts the base rows do not keep */
export interface AgentFacts {
  first?: string
  last?: string
  lastActivity?: string
}

export interface BuildWorkflowRunsArgs {
  /** base rows; those of a run are completed in place */
  agents: AgentRun[]
  facts: Map<string, AgentFacts>
  main: Pick<TranscriptScan, 'first' | 'workflowLaunches' | 'workflowResults'>
  notifications: Notification[]
  stops: Set<string>
  runs: WorkflowRunInput[]
  now: number
}

const iso = (ms: number | undefined): string | undefined => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined)
const maxIso = (xs: Array<string | undefined>): string | undefined => xs.filter((x): x is string => !!x).sort().pop()
const minIso = (xs: Array<string | undefined>): string | undefined => xs.filter((x): x is string => !!x).sort()[0]

function setSpan(row: AgentRun, start: string, end: string) {
  row.start = start
  row.end = end
  row.duration_ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime())
}

/** Fill a base row with the facts the run record holds about it */
function overlayProgress(row: AgentRun, p: WorkflowProgressAgent, state: WorkflowAgentState, runStatus: AgentOutcome, facts: AgentFacts | undefined, now: number) {
  row.workflow_index = p.index
  row.workflow_phase = row.workflow_phase ?? p.phaseTitle
  row.workflow_phase_index = p.phaseIndex
  row.workflow_state = state
  row.workflow_error = p.error
  row.workflow_attempt = p.attempt
  row.workflow_attempt_reason = p.lastAttemptReason
  row.workflow_tool_calls = p.toolCalls
  row.workflow_result_preview = p.resultPreview?.slice(0, 500)
  row.queued_at = iso(p.queuedAt)
  if (row.description === row.id && p.label) row.description = p.label
  if (!row.model) row.model = stripModelSuffix(p.model)
  if (!row.prompt) row.prompt = p.promptPreview ?? ''
  row.outcome = outcomeForState(state, runStatus)
  const start = facts?.first ?? iso(p.startedAt ?? p.queuedAt) ?? row.start
  const end = row.outcome === 'running' ? new Date(now).toISOString() : facts?.last ?? iso(p.lastProgressAt) ?? start
  setSpan(row, start, end)
}

/** A row for an agent() call that has no transcript: blocked, never started, or lost */
function synthesizeRow(runId: string, p: WorkflowProgressAgent, state: WorkflowAgentState, runStatus: AgentOutcome, fallbackStart: string, now: number): AgentRun {
  const outcome = outcomeForState(state, runStatus)
  const start = iso(p.startedAt ?? p.queuedAt) ?? fallbackStart
  const end = outcome === 'running' ? new Date(now).toISOString() : iso(p.lastProgressAt) ?? start
  return {
    id: p.agentId ?? `${runId}#${p.index}`,
    parent_id: null,
    depth: 1,
    description: p.label ?? `agent ${p.index}`,
    agent_type: p.agentType ?? 'workflow-subagent',
    model: stripModelSuffix(p.model),
    prompt: p.promptPreview ?? '',
    start,
    end,
    duration_ms: Math.max(0, new Date(end).getTime() - new Date(start).getTime()),
    turns: 0,
    usage: emptyUsage(),
    estimated_cost: 0,
    outcome,
    nudges: [],
    children_count: 0,
    workflow_id: runId,
    workflow_index: p.index,
    workflow_phase: p.phaseTitle,
    workflow_phase_index: p.phaseIndex,
    workflow_state: state,
    workflow_error: p.error,
    workflow_attempt: p.attempt,
    workflow_attempt_reason: p.lastAttemptReason,
    workflow_tool_calls: p.toolCalls,
    workflow_result_preview: p.resultPreview?.slice(0, 500),
    queued_at: iso(p.queuedAt),
    has_transcript: false,
  }
}

/**
 * Assemble the workflow runs of a session. The run record (written when the
 * run ends) is the main source; the journal and the transcripts cover what it
 * misses: a run still going, or the agents of an earlier attempt of a resumed
 * run. Returns the runs and the rows synthesized for agents without a transcript.
 */
export function buildWorkflowRuns(args: BuildWorkflowRunsArgs): { workflows: WorkflowRun[]; extraAgents: AgentRun[] } {
  const { agents, facts, main, notifications, stops, runs, now } = args
  const workflows: WorkflowRun[] = []
  const extraAgents: AgentRun[] = []
  const fresh = (t: string | undefined) => !!t && now - new Date(t).getTime() < RUNNING_WINDOW_MS

  for (const { runId, record, journal, journalMtime } of runs) {
    const rows = agents.filter(a => a.workflow_id === runId)
    const byId = new Map(rows.map(r => [r.id, r]))

    // ── launches of this run, oldest first; a resume is a new launch of the same run
    const launches = [...main.workflowResults]
      .filter(([, r]) => r.run_id === runId)
      .map(([toolUseId, result]) => ({ toolUseId, result, launch: main.workflowLaunches.get(toolUseId) }))
      .sort((a, b) => (a.launch?.timestamp ?? a.result.timestamp).localeCompare(b.launch?.timestamp ?? b.result.timestamp))
    const taskIds = launches.map(l => l.result.task_id).filter((t): t is string => !!t)
    // A record whose launch line is gone (compaction, clear) still names its task: an earlier attempt
    if (record?.taskId && !taskIds.includes(record.taskId)) taskIds.unshift(record.taskId)
    const latestTaskId = taskIds[taskIds.length - 1]

    // ── status: the record when it covers the latest attempt, else the task's fate, else freshness
    const lastActivity = maxIso([...rows.map(r => facts.get(r.id)?.lastActivity), journalMtime])
    const fromRecord = recordStatus(record?.status)
    let status: AgentOutcome
    if (fromRecord && (!latestTaskId || !record?.taskId || record.taskId === latestTaskId)) status = fromRecord
    else if (latestTaskId) status = resolveOutcome(latestTaskId, notifications, stops, lastActivity, now)
    else status = fresh(lastActivity) ? 'running' : 'unknown'
    if (status === 'unknown' && fromRecord) status = fromRecord

    const fallbackStart = launches[0]?.launch?.timestamp ?? launches[0]?.result.timestamp ?? iso(record?.startTime) ?? main.first ?? ''

    // ── agents named by the record
    const seen = new Set<string>()
    for (const p of progressAgents(record)) {
      const state = normalizeAgentState(p)
      const row = p.agentId ? byId.get(p.agentId) : undefined
      if (row) {
        overlayProgress(row, p, state, status, facts.get(row.id), now)
        seen.add(row.id)
      } else {
        const extra = synthesizeRow(runId, p, state, status, fallbackStart, now)
        extraAgents.push(extra)
        rows.push(extra)
      }
    }

    // ── agents the record does not know: still running, or from an earlier attempt
    const facts2 = journalByAgent(journal)
    for (const row of rows) {
      if (seen.has(row.id) || row.has_transcript === false) continue
      const j = facts2.get(row.id)
      const state: WorkflowAgentState = j ? (j.done || j.failed ? stateFromJournal(j) : row.outcome === 'running' ? 'running' : stateFromJournal(j)) : row.outcome === 'running' ? 'running' : 'queued'
      row.workflow_state = state
      row.workflow_phase = row.workflow_phase ?? j?.phase
      if (row.description === row.id && j?.label) row.description = j.label
      row.outcome = outcomeForState(state, status)
      const f = facts.get(row.id)
      setSpan(row, row.start, row.outcome === 'running' ? new Date(now).toISOString() : f?.last ?? row.start)
    }

    // ── phases: the record's, else the titles seen on the agents in order of first start
    let phases: WorkflowPhase[] = recordPhases(record)
    if (phases.length === 0) {
      const titles: string[] = []
      for (const r of [...rows].sort((a, b) => a.start.localeCompare(b.start))) {
        if (r.workflow_phase && !titles.includes(r.workflow_phase)) titles.push(r.workflow_phase)
      }
      phases = titles.map((title, i) => ({ index: i + 1, title }))
    }
    const phaseIndex = new Map(phases.map(p => [p.title, p.index]))
    for (const r of rows) {
      if (r.workflow_phase_index === undefined && r.workflow_phase) r.workflow_phase_index = phaseIndex.get(r.workflow_phase)
    }

    // ── span
    const start = minIso([launches[0]?.launch?.timestamp ?? launches[0]?.result.timestamp, iso(record?.startTime), ...rows.map(r => r.start)]) ?? main.first ?? ''
    const notified = notifications.filter(n => taskIds.includes(n.taskId)).map(n => n.timestamp)
    const end = status === 'running'
      ? new Date(now).toISOString()
      : maxIso([record?.timestamp, ...notified, ...rows.map(r => r.end)]) ?? start

    const states = rows.map(r => r.workflow_state)
    const count = (...xs: WorkflowAgentState[]) => states.filter(s => s && xs.includes(s)).length
    const firstLaunch = launches[0]
    const scriptPath = record?.scriptPath ?? firstLaunch?.result.script_path ?? firstLaunch?.launch?.script_path
    const name = record?.workflowName
      ?? launches.map(l => l.result.name).find(Boolean)
      ?? launches.map(l => l.launch?.name).find(Boolean)
      ?? (scriptPath ? path.basename(scriptPath).replace(/\.[cm]?js$/, '') : undefined)
      ?? runId

    workflows.push({
      id: runId,
      name,
      summary: record?.summary ?? launches.map(l => l.result.summary).find(Boolean),
      status,
      task_ids: taskIds,
      attempts: Math.max(1, taskIds.length),
      resumed: taskIds.length > 1 || launches.some(l => !!l.launch?.resume_from_run_id),
      launch_tool_use_id: firstLaunch?.toolUseId,
      launch_turn_uuid: firstLaunch?.launch?.assistant_uuid || undefined,
      start,
      end,
      duration_ms: Math.max(0, new Date(end).getTime() - new Date(start).getTime()),
      phases,
      agent_count: rows.length,
      done_count: count('done', 'cached'),
      error_count: count('error', 'blocked'),
      blocked_count: count('blocked'),
      running_count: count('running', 'queued'),
      total_tokens: record?.totalTokens,
      total_tool_calls: record?.totalToolCalls,
      estimated_cost: rows.reduce((s, r) => s + r.estimated_cost, 0),
      error: record?.error,
      script_path: scriptPath,
      default_model: record?.defaultModel,
      has_record: !!record,
    })
  }

  workflows.sort((a, b) => a.start.localeCompare(b.start))
  return { workflows, extraAgents }
}

/** Everything on disk about the runs of a session: run folders, records, and the launches seen in the log */
async function loadWorkflowInputs(jsonlPath: string, sessionId: string, main: TranscriptScan): Promise<WorkflowRunInput[]> {
  const ids = new Set<string>([
    ...await listWorkflowRunDirs(jsonlPath, sessionId),
    ...await listWorkflowRecordIds(jsonlPath, sessionId),
    ...[...main.workflowResults.values()].map(r => r.run_id),
  ])
  const out: WorkflowRunInput[] = []
  for (const runId of ids) {
    if (!WORKFLOW_RUN_ID_RE.test(runId)) continue
    const record = await readWorkflowRecord(workflowRecordPath(jsonlPath, sessionId, runId))
    const runDir = workflowRunDir(jsonlPath, sessionId, runId)
    const journal = await readWorkflowJournal(runDir)
    let journalMtime: string | undefined
    try { journalMtime = (await stat(path.join(runDir, 'journal.jsonl'))).mtime.toISOString() } catch { /* no journal */ }
    out.push({ runId, record: record ? summarizeRecord(record) : undefined, journal, journalMtime })
  }
  return out
}

/**
 * Build the agent timeline for a session from its orchestrator JSONL, the
 * `<session-id>/subagents/` folder that sits next to it, and the Workflow runs
 * recorded under `<session-id>/workflows/`.
 */
export async function parseAgentTimeline(
  jsonlPath: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<AgentTimeline> {
  const mainLines = await readLines(jsonlPath)
  const main = scanTranscript(mainLines)

  const files = await listSubagentFiles(jsonlPath, sessionId)

  interface Raw { id: string; meta: AgentMeta; scan: TranscriptScan; mtime?: string; workflowId?: string }
  const raws: Raw[] = await mapPool(files, 8, async f => {
    const meta = await readAgentMeta(f.meta)
    const { scan, mtime } = await scanFile(f.jsonl)
    return { id: f.id, meta, scan, mtime, workflowId: f.workflowId }
  })

  // Merge facts from every transcript
  const notifications = [...main.notifications, ...raws.flatMap(r => r.scan.notifications)]
  const stops = new Set<string>(main.stops)
  const nudges = new Map<string, string[]>(main.nudges)
  const launchesByToolUse = new Map<string, { info: LaunchInfo; parentId: string | null }>()
  for (const [id, info] of main.launches) launchesByToolUse.set(id, { info, parentId: null })
  for (const r of raws) {
    for (const s of r.scan.stops) stops.add(s)
    for (const [to, list] of r.scan.nudges) nudges.set(to, [...(nudges.get(to) ?? []), ...list])
    for (const [id, info] of r.scan.launches) launchesByToolUse.set(id, { info, parentId: r.id })
  }

  const agents: AgentRun[] = []
  const facts = new Map<string, AgentFacts>()
  for (const r of raws) {
    const launch = r.meta.toolUseId ? launchesByToolUse.get(r.meta.toolUseId) : undefined
    const start = r.scan.first ?? launch?.info.timestamp ?? main.first ?? ''
    const end = r.scan.last ?? start
    const model = r.meta.model ?? launch?.info.model ?? r.scan.model
    const lastActivity = [r.scan.last, r.mtime].filter(Boolean).sort().pop()
    const outcome = resolveOutcome(r.id, notifications, stops, lastActivity, now)
    const durationEnd = outcome === 'running' ? new Date(now).toISOString() : end
    facts.set(r.id, { first: r.scan.first, last: r.scan.last, lastActivity })
    agents.push({
      id: r.id,
      parent_id: launch?.parentId ?? null,
      depth: r.meta.spawnDepth ?? (launch?.parentId ? 2 : 1),
      description: r.meta.description ?? launch?.info.description ?? r.id,
      agent_type: r.meta.agentType ?? launch?.info.subagent_type ?? 'general-purpose',
      model,
      prompt: launch?.info.prompt ?? '',
      start,
      end: durationEnd,
      duration_ms: Math.max(0, new Date(durationEnd).getTime() - new Date(start).getTime()),
      turns: r.scan.assistantCount,
      usage: r.scan.usage,
      estimated_cost: estimateCostFromUsage(r.scan.model ?? model ?? '', r.scan.usage),
      outcome,
      nudges: (nudges.get(r.id) ?? []).sort(),
      launch_tool_use_id: r.meta.toolUseId,
      launch_turn_uuid: launch && launch.parentId === null ? launch.info.assistant_uuid : undefined,
      children_count: 0,
      ...(r.workflowId ? { workflow_id: r.workflowId, workflow_phase: r.meta.workflowPhase, has_transcript: true } : {}),
    })
  }

  const runs = await loadWorkflowInputs(jsonlPath, sessionId, main)
  const { workflows, extraAgents } = buildWorkflowRuns({ agents, facts, main, notifications, stops, runs, now })
  agents.push(...extraAgents)

  const byId = new Map(agents.map(a => [a.id, a]))
  for (const a of agents) {
    if (a.parent_id && byId.has(a.parent_id)) byId.get(a.parent_id)!.children_count++
    else if (a.parent_id) a.parent_id = null
  }
  agents.sort((a, b) => a.start.localeCompare(b.start))

  const allTimes = [main.first, main.last, ...agents.flatMap(a => [a.start, a.end]), ...workflows.flatMap(w => [w.start, w.end])]
    .filter((t): t is string => !!t).sort()

  return {
    session_id: sessionId,
    start: allTimes[0] ?? '',
    end: allTimes[allTimes.length - 1] ?? '',
    orchestrator: {
      busy: main.busy.sort((a, b) => a.start.localeCompare(b.start)),
      prompts: main.prompts,
    },
    agents,
    workflows,
    context_events: findContextEvents(mainLines),
  }
}

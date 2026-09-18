import { stat } from 'fs/promises'
import { z } from 'zod'
import type { PromptTick, TimeSegment, TurnUsage } from '@/types/claude'
import { readJSONLLines } from '@/lib/jsonl'
import { LedgerBuilder, NO_MODEL, type TurnLedger } from '@/lib/session-ledger'
import { resultText } from '@/lib/tool-search'
import { parseWorkflowLaunchText } from '@/lib/workflow-runs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyLine = Record<string, any>

export interface LaunchInfo {
  timestamp: string
  assistant_uuid: string
  description?: string
  subagent_type?: string
  model?: string
  prompt?: string
}

export interface Notification {
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
export interface TranscriptScan {
  first?: string
  last?: string
  assistantCount: number
  usage: TurnUsage
  usageByModel: Record<string, TurnUsage>
  /** Usage of messages that carry no model; the caller attributes it */
  unattributedUsage: TurnUsage
  /** Per-turn record of the assistant messages, for range slicing */
  ledger: TurnLedger
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

export function emptyUsage(): TurnUsage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
}

function addUsage(acc: TurnUsage, u: Partial<TurnUsage> | undefined) {
  if (!u) return
  acc.input_tokens                += u.input_tokens ?? 0
  acc.output_tokens               += u.output_tokens ?? 0
  acc.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
  acc.cache_read_input_tokens     += u.cache_read_input_tokens ?? 0
}

/** The part of an assistant message that prices it */
const AssistantPricing = z.object({
  model: z.string().optional(),
  usage: z.object({
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    cache_read_input_tokens: z.number().default(0),
    cache_creation_input_tokens: z.number().default(0),
  }).optional(),
})

const NOTIFICATION_RE = /<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g

export function parseNotifications(text: string, timestamp: string): Notification[] {
  const out: Notification[] = []
  for (const m of text.matchAll(NOTIFICATION_RE)) {
    out.push({ taskId: m[1].trim(), status: m[2].trim(), timestamp })
  }
  return out
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
    usageByModel: {},
    unattributedUsage: emptyUsage(),
    ledger: new LedgerBuilder().build(),
    launches: new Map(),
    nudges: new Map(),
    notifications: [],
    stops: new Set(),
    busy: [],
    prompts: [],
    workflowLaunches: new Map(),
    workflowResults: new Map(),
  }
  const ledger = new LedgerBuilder()

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
      const priced = AssistantPricing.safeParse(msg)
      if (priced.success) {
        const { model, usage } = priced.data
        if (usage) {
          addUsage(scan.usage, usage)
          if (model) addUsage(scan.usageByModel[model] ??= emptyUsage(), usage)
          else addUsage(scan.unattributedUsage, usage)
        }
        if (!scan.model && model) scan.model = model
      }
      const content = Array.isArray(msg.content) ? msg.content : []
      let toolCalls = 0
      for (const c of content) {
        if (c.type !== 'tool_use') continue
        toolCalls++
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
      if (ts && priced.success && priced.data.usage) {
        const u = priced.data.usage
        ledger.addTurn({
          ts: new Date(ts).getTime(),
          model: priced.data.model ?? NO_MODEL,
          input: u.input_tokens, output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
          toolCalls,
        })
      }
    }
  }
  scan.ledger = ledger.build()
  return scan
}

export async function readLines(filePath: string): Promise<AnyLine[]> {
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

export async function scanFile(filePath: string): Promise<{ scan: TranscriptScan; mtime?: string }> {
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

/** Drop cached scans whose file is no longer wanted (deleted session, pruned agent) */
export function pruneScanCache(keep: (filePath: string) => boolean): void {
  for (const key of scanCache.keys()) {
    if (!keep(key)) scanCache.delete(key)
  }
}

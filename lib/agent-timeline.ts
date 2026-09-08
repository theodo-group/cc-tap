import path from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import type { AgentOutcome, AgentRun, AgentTimeline, ContextEvent, PromptTick, TimeSegment, TurnUsage } from '@/types/claude'
import { estimateCostFromUsage } from '@/lib/pricing'
import { readJSONLLines } from '@/lib/claude-reader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLine = Record<string, any>

/** An agent is considered live when its transcript changed within this window */
export const RUNNING_WINDOW_MS = 2 * 60_000

interface AgentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
  spawnDepth?: number
  model?: string
}

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
    if (prev && parent && parent !== prev && indexByUuid.has(parent)) {
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

/**
 * Build the agent timeline for a session from its orchestrator JSONL and the
 * `<session-id>/subagents/` folder that sits next to it.
 */
export async function parseAgentTimeline(
  jsonlPath: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<AgentTimeline> {
  const mainLines = await readLines(jsonlPath)
  const main = scanTranscript(mainLines)

  const subDir = path.join(path.dirname(jsonlPath), sessionId, 'subagents')
  let entries: string[] = []
  try { entries = await readdir(subDir) } catch { /* no agents */ }

  const agentIds = entries
    .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
    .map(f => f.slice('agent-'.length, -'.jsonl'.length))

  interface Raw { id: string; meta: AgentMeta; scan: TranscriptScan; mtime?: string }
  const raws: Raw[] = []
  for (const id of agentIds) {
    const base = path.join(subDir, `agent-${id}`)
    let meta: AgentMeta = {}
    try { meta = JSON.parse(await readFile(`${base}.meta.json`, 'utf-8')) } catch { /* optional */ }
    const scan = scanTranscript(await readLines(`${base}.jsonl`))
    let mtime: string | undefined
    try { mtime = (await stat(`${base}.jsonl`)).mtime.toISOString() } catch { /* ignore */ }
    raws.push({ id, meta, scan, mtime })
  }

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
  for (const r of raws) {
    const launch = r.meta.toolUseId ? launchesByToolUse.get(r.meta.toolUseId) : undefined
    const start = r.scan.first ?? launch?.info.timestamp ?? main.first ?? ''
    const end = r.scan.last ?? start
    const model = r.meta.model ?? launch?.info.model ?? r.scan.model
    const lastActivity = [r.scan.last, r.mtime].filter(Boolean).sort().pop()
    const outcome = resolveOutcome(r.id, notifications, stops, lastActivity, now)
    const durationEnd = outcome === 'running' ? new Date(now).toISOString() : end
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
    })
  }

  const byId = new Map(agents.map(a => [a.id, a]))
  for (const a of agents) {
    if (a.parent_id && byId.has(a.parent_id)) byId.get(a.parent_id)!.children_count++
    else if (a.parent_id) a.parent_id = null
  }
  agents.sort((a, b) => a.start.localeCompare(b.start))

  const allTimes = [main.first, main.last, ...agents.flatMap(a => [a.start, a.end])].filter((t): t is string => !!t).sort()

  return {
    session_id: sessionId,
    start: allTimes[0] ?? '',
    end: allTimes[allTimes.length - 1] ?? '',
    orchestrator: {
      busy: main.busy.sort((a, b) => a.start.localeCompare(b.start)),
      prompts: main.prompts,
    },
    agents,
    context_events: findContextEvents(mainLines),
  }
}

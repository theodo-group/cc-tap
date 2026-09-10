import { readJSONLLines } from '@/lib/claude-reader'
import { listSubagentFiles, readAgentMeta } from '@/lib/subagent-files'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLine = Record<string, any>

export type SearchScope = 'input' | 'all'

export interface ToolMatch {
  /** null for the orchestrator */
  agent_id: string | null
  agent_description?: string
  /** wf_ run id when the agent was started by a Workflow run */
  workflow_id?: string
  timestamp: string
  /** timestamp of the tool result, when one was recorded */
  end_timestamp?: string
  tool: string
  tool_use_id: string
  /** uuid of the assistant message holding the call */
  turn_uuid: string
  snippet: string
  is_error?: boolean
  /** true when the match came from the result text only */
  in_result?: boolean
}

export interface ToolSearchResult {
  query: string
  scope: SearchScope
  total: number
  /** may be shorter than total when capped */
  matches: ToolMatch[]
  truncated: boolean
}

export const MAX_MATCHES = 5000
const SNIPPET_LEN = 160

/**
 * Split a query into lowercase terms; every term must appear in the text.
 * A quoted part, "pnpm ci-verify", is one term that must appear as that exact
 * phrase (inner whitespace normalized to single spaces). Unquoted words are
 * separate terms that may appear anywhere, in any order.
 */
export function queryWords(query: string): string[] {
  const terms: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  for (const m of query.toLowerCase().matchAll(re)) {
    const term = (m[1] ?? m[2]).replace(/\s+/g, ' ').trim()
    if (term) terms.push(term)
  }
  return terms
}

export function matchesAll(text: string, words: string[]): boolean {
  if (words.length === 0) return false
  const lower = text.toLowerCase()
  // Phrases may span a line break or several spaces in the source text
  const flat = words.some(w => w.includes(' ')) ? lower.replace(/\s+/g, ' ') : lower
  return words.every(w => (w.includes(' ') ? flat : lower).includes(w))
}

/** Concatenate the string values of a tool input, so JSON keys never match */
export function inputText(input: unknown): string {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (v == null) return
    if (typeof v === 'string') out.push(v)
    else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk)
  }
  walk(input)
  return out.join('\n')
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c: AnyLine) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n')
  return ''
}

/** A short excerpt around the first word that matches, collapsed to one line */
export function makeSnippet(text: string, words: string[], len = SNIPPET_LEN): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  let pos = -1
  for (const w of words) {
    const i = lower.indexOf(w)
    if (i >= 0 && (pos < 0 || i < pos)) pos = i
  }
  if (flat.length <= len) return flat
  const start = Math.max(0, Math.min(pos < 0 ? 0 : pos - Math.floor(len / 3), flat.length - len))
  const end = Math.min(flat.length, start + len)
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '')
}

interface Call {
  id: string
  name: string
  timestamp: string
  turn_uuid: string
  text: string
}

/** Collect tool calls and their results from one transcript; result text is kept only when asked */
export function scanCalls(lines: AnyLine[], withResults: boolean): { calls: Call[]; results: Map<string, { text: string; is_error: boolean; timestamp: string }> } {
  const calls: Call[] = []
  const results = new Map<string, { text: string; is_error: boolean; timestamp: string }>()
  for (const l of lines) {
    if (l.type === 'assistant') {
      const content = Array.isArray(l.message?.content) ? l.message.content : []
      for (const c of content) {
        if (c?.type !== 'tool_use') continue
        calls.push({ id: c.id ?? '', name: c.name ?? '', timestamp: l.timestamp ?? '', turn_uuid: l.uuid ?? '', text: `${c.name ?? ''}\n${inputText(c.input)}` })
      }
    } else if (l.type === 'user') {
      const content = Array.isArray(l.message?.content) ? l.message.content : []
      for (const c of content) {
        if (c?.type !== 'tool_result' || !c.tool_use_id) continue
        results.set(c.tool_use_id, { text: withResults ? resultText(c.content) : '', is_error: c.is_error === true, timestamp: l.timestamp ?? '' })
      }
    }
  }
  return { calls, results }
}

async function readLines(filePath: string): Promise<AnyLine[]> {
  const lines: AnyLine[] = []
  await readJSONLLines(filePath, l => lines.push(l))
  return lines
}

/**
 * Search every tool call of a session (orchestrator plus sub-agents) for a
 * query. All words must appear, case-insensitively, in the tool name and its
 * input; with scope `all`, the tool result text is searched too.
 */
export async function searchToolCalls(
  jsonlPath: string,
  sessionId: string,
  query: string,
  scope: SearchScope = 'input',
): Promise<ToolSearchResult> {
  const words = queryWords(query)
  const withResults = scope === 'all'
  const matches: ToolMatch[] = []
  let total = 0
  if (words.length === 0) return { query, scope, total: 0, matches, truncated: false }

  const transcripts: Array<{ agentId: string | null; file: string; description?: string; workflowId?: string }> = [{ agentId: null, file: jsonlPath }]
  for (const f of await listSubagentFiles(jsonlPath, sessionId)) {
    const { description } = await readAgentMeta(f.meta)
    transcripts.push({ agentId: f.id, file: f.jsonl, description, workflowId: f.workflowId })
  }

  for (const t of transcripts) {
    const { calls, results } = scanCalls(await readLines(t.file), withResults)
    for (const c of calls) {
      const inInput = matchesAll(c.text, words)
      const res = results.get(c.id)
      const inResult = !inInput && withResults && !!res && matchesAll(res.text, words)
      if (!inInput && !inResult) continue
      total++
      if (matches.length >= MAX_MATCHES) continue
      matches.push({
        agent_id: t.agentId,
        agent_description: t.description,
        workflow_id: t.workflowId,
        timestamp: c.timestamp,
        end_timestamp: res?.timestamp || undefined,
        tool: c.name,
        tool_use_id: c.id,
        turn_uuid: c.turn_uuid,
        snippet: makeSnippet(inResult ? res!.text : c.text.slice(c.name.length + 1), words),
        is_error: res?.is_error || undefined,
        in_result: inResult || undefined,
      })
    }
  }

  matches.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return { query, scope, total, matches, truncated: total > matches.length }
}

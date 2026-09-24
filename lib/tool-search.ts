import path from 'path'
import { readdir, readFile } from 'fs/promises'
import { readJSONLLines } from '@/lib/claude-reader'
import { findTerm, foldText, inputText, matchesAll, searchTerms } from '@/lib/search-query'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLine = Record<string, any>

export type SearchScope = 'input' | 'all'

export interface ToolMatch {
  /** null for the orchestrator */
  agent_id: string | null
  agent_description?: string
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

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c: AnyLine) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n')
  return ''
}

/** A short excerpt around the first term that matches, collapsed to one line.
 *  A term matched loosely is placed where its run starts. */
export function makeSnippet(text: string, terms: readonly string[], len = SNIPPET_LEN): string {
  const flat = foldText(text, { caseSensitive: true }).trim()
  const hay = flat.toLowerCase()
  let pos = -1
  for (const term of terms) {
    const found = findTerm(hay, term)
    if (found && (pos < 0 || found.start < pos)) pos = found.start
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
 * query, read as the Replay find bar reads one out of exact mode: every term
 * must appear, case-insensitively, a quoted part as that phrase, a lone word
 * loosely when it has no literal match. The tool name and its input are
 * searched; with scope `all`, the tool result text is too.
 */
export async function searchToolCalls(
  jsonlPath: string,
  sessionId: string,
  query: string,
  scope: SearchScope = 'input',
): Promise<ToolSearchResult> {
  const words = searchTerms(query)
  const withResults = scope === 'all'
  const matches: ToolMatch[] = []
  let total = 0
  if (words.length === 0) return { query, scope, total: 0, matches, truncated: false }

  const subDir = path.join(path.dirname(jsonlPath), sessionId, 'subagents')
  let entries: string[] = []
  try { entries = await readdir(subDir) } catch { /* no agents */ }
  const agentIds = entries.filter(f => f.startsWith('agent-') && f.endsWith('.jsonl')).map(f => f.slice(6, -6))

  const transcripts: Array<{ agentId: string | null; file: string; description?: string }> = [{ agentId: null, file: jsonlPath }]
  for (const id of agentIds) {
    let description: string | undefined
    try { description = JSON.parse(await readFile(path.join(subDir, `agent-${id}.meta.json`), 'utf-8')).description } catch { /* optional */ }
    transcripts.push({ agentId: id, file: path.join(subDir, `agent-${id}.jsonl`), description })
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

import path from 'path'
import { access, readdir, readFile } from 'fs/promises'

/**
 * Where Claude Code keeps the transcripts that belong to a session:
 *
 *   <dir>/<session>.jsonl                                   orchestrator
 *   <dir>/<session>/subagents/agent-<id>.jsonl|.meta.json   Agent / Task sub-agents
 *   <dir>/<session>/subagents/workflows/wf_<run>/agent-<id>.jsonl|.meta.json
 *   <dir>/<session>/subagents/workflows/wf_<run>/journal.jsonl
 *   <dir>/<session>/workflows/wf_<run>.json                 run record, written when the run ends
 *   <dir>/<session>/workflows/scripts/<name>-wf_<run>.js    script persisted from an inline `script`
 */

export const WORKFLOW_RUN_ID_RE = /^wf_[a-z0-9-]{6,}$/
const AGENT_FILE_RE = /^agent-([a-f0-9]+)\.jsonl$/

/** Sidecar next to a sub-agent transcript */
export interface AgentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
  spawnDepth?: number
  model?: string
  /** phase title, set on agents started by a Workflow run */
  workflowPhase?: string
}

export interface SubagentFile {
  id: string
  jsonl: string
  meta: string
  /** wf_ run id when the transcript sits in a workflow run folder */
  workflowId?: string
}

export function sessionDir(jsonlPath: string, sessionId: string): string {
  return path.join(path.dirname(jsonlPath), sessionId)
}

export function subagentsDir(jsonlPath: string, sessionId: string): string {
  return path.join(sessionDir(jsonlPath, sessionId), 'subagents')
}

export function workflowRunDir(jsonlPath: string, sessionId: string, runId: string): string {
  return path.join(subagentsDir(jsonlPath, sessionId), 'workflows', runId)
}

export function workflowRecordPath(jsonlPath: string, sessionId: string, runId: string): string {
  return path.join(sessionDir(jsonlPath, sessionId), 'workflows', `${runId}.json`)
}

async function ls(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

/** Run ids that have a transcript folder */
export async function listWorkflowRunDirs(jsonlPath: string, sessionId: string): Promise<string[]> {
  const entries = await ls(path.join(subagentsDir(jsonlPath, sessionId), 'workflows'))
  return entries.filter(e => WORKFLOW_RUN_ID_RE.test(e))
}

/** Run ids that have a record */
export async function listWorkflowRecordIds(jsonlPath: string, sessionId: string): Promise<string[]> {
  const entries = await ls(path.join(sessionDir(jsonlPath, sessionId), 'workflows'))
  return entries
    .filter(e => e.endsWith('.json'))
    .map(e => e.slice(0, -'.json'.length))
    .filter(id => WORKFLOW_RUN_ID_RE.test(id))
}

function filesIn(dir: string, entries: string[], workflowId?: string): SubagentFile[] {
  const out: SubagentFile[] = []
  for (const e of entries) {
    const m = AGENT_FILE_RE.exec(e)
    if (!m) continue
    const base = path.join(dir, `agent-${m[1]}`)
    out.push({ id: m[1], jsonl: `${base}.jsonl`, meta: `${base}.meta.json`, workflowId })
  }
  return out
}

/** Every sub-agent transcript of a session: the flat folder, then each workflow run folder */
export async function listSubagentFiles(jsonlPath: string, sessionId: string): Promise<SubagentFile[]> {
  const flat = subagentsDir(jsonlPath, sessionId)
  const out = filesIn(flat, await ls(flat))
  for (const runId of await listWorkflowRunDirs(jsonlPath, sessionId)) {
    const dir = workflowRunDir(jsonlPath, sessionId, runId)
    out.push(...filesIn(dir, await ls(dir), runId))
  }
  return out
}

/** Locate one sub-agent transcript by id, wherever it sits */
export async function findSubagentFile(jsonlPath: string, sessionId: string, agentId: string): Promise<SubagentFile | null> {
  const candidates: Array<{ dir: string; workflowId?: string }> = [{ dir: subagentsDir(jsonlPath, sessionId) }]
  for (const runId of await listWorkflowRunDirs(jsonlPath, sessionId)) {
    candidates.push({ dir: workflowRunDir(jsonlPath, sessionId, runId), workflowId: runId })
  }
  for (const c of candidates) {
    const base = path.join(c.dir, `agent-${agentId}`)
    try {
      await access(`${base}.jsonl`)
      return { id: agentId, jsonl: `${base}.jsonl`, meta: `${base}.meta.json`, workflowId: c.workflowId }
    } catch { /* not here */ }
  }
  return null
}

/** The sidecar, or an empty object when it is missing or unreadable */
export async function readAgentMeta(metaPath: string): Promise<AgentMeta> {
  try {
    const parsed = JSON.parse(await readFile(metaPath, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed as AgentMeta : {}
  } catch { return {} }
}

import { NextResponse } from 'next/server'
import path from 'path'
import { access, readFile } from 'fs/promises'
import type { WorkflowRunDetail } from '@/types/claude'
import { findSessionJSONL } from '@/lib/claude-reader'
import { WORKFLOW_RUN_ID_RE, sessionDir, workflowRecordPath, workflowRunDir } from '@/lib/subagent-files'
import { capJson, capText, readWorkflowJournal, readWorkflowRecord, recordPhases, recordStatus } from '@/lib/workflow-runs'

export const dynamic = 'force-dynamic'

const SCRIPT_MAX = 256_000
const JSON_MAX = 64_000
const JOURNAL_RESULT_MAX = 8_000

/** The script the tool persisted for this run, only from the session's own scripts folder */
async function readPersistedScript(jsonlPath: string, sessionId: string, scriptPath: string | undefined): Promise<string | undefined> {
  if (!scriptPath) return undefined
  const scriptsDir = path.join(sessionDir(jsonlPath, sessionId), 'workflows', 'scripts')
  const resolved = path.resolve(scriptPath)
  if (!resolved.startsWith(scriptsDir + path.sep)) return undefined
  try { return await readFile(resolved, 'utf-8') } catch { return undefined }
}

/** Everything the run record and the journal hold about one Workflow run: script, args, result, logs */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  const { id, runId } = await params
  if (!WORKFLOW_RUN_ID_RE.test(runId)) {
    return NextResponse.json({ error: 'Invalid run id' }, { status: 400 })
  }
  const jsonlPath = await findSessionJSONL(id)
  if (!jsonlPath) {
    return NextResponse.json({ error: 'Session JSONL not found' }, { status: 404 })
  }

  const runDir = workflowRunDir(jsonlPath, id, runId)
  const record = await readWorkflowRecord(workflowRecordPath(jsonlPath, id, runId))
  const journal = await readWorkflowJournal(runDir)
  if (!record && journal.length === 0) {
    try { await access(runDir) } catch {
      return NextResponse.json({ error: 'Workflow run not found' }, { status: 404 })
    }
  }

  const script = record?.script ?? await readPersistedScript(jsonlPath, id, record?.scriptPath)
  const startMs = typeof record?.startTime === 'number' ? record.startTime : undefined
  const detail: WorkflowRunDetail = {
    id: runId,
    has_record: !!record,
    name: record?.workflowName ?? runId,
    status: recordStatus(record?.status) ?? (record ? 'unknown' : 'running'),
    summary: record?.summary,
    error: record?.error,
    script_path: record?.scriptPath,
    script: script !== undefined ? capText(script, SCRIPT_MAX) : undefined,
    args: capJson(record?.args, JSON_MAX),
    result: capJson(record?.result, JSON_MAX),
    logs: Array.isArray(record?.logs) ? record.logs.map(l => (typeof l === 'string' ? l : JSON.stringify(l))) : [],
    phases: recordPhases(record ?? undefined),
    progress: (record?.workflowProgress ?? []) as Record<string, unknown>[],
    default_model: record?.defaultModel,
    total_tokens: record?.totalTokens,
    total_tool_calls: record?.totalToolCalls,
    start: startMs !== undefined ? new Date(startMs).toISOString() : undefined,
    end: record?.timestamp,
    duration_ms: record?.durationMs,
    journal: journal.map(e => ({
      type: e.type,
      key: e.key,
      agent_id: e.agentId || undefined,
      label: e.label,
      phase: e.phase,
      result: capJson(e.result, JOURNAL_RESULT_MAX),
    })),
  }
  return NextResponse.json(detail)
}

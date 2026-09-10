import { NextResponse } from 'next/server'
import { findSessionJSONL } from '@/lib/claude-reader'
import { parseSessionReplay } from '@/lib/replay-parser'
import { findSubagentFile } from '@/lib/subagent-files'

export const dynamic = 'force-dynamic'

const AGENT_ID = /^[a-f0-9]{6,32}$/

/** Replay data for one sub-agent transcript, in <session>/subagents/ or a workflow run folder below it */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; agentId: string }> }
) {
  const { id, agentId } = await params
  if (!AGENT_ID.test(agentId)) {
    return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 })
  }
  const jsonlPath = await findSessionJSONL(id)
  if (!jsonlPath) {
    return NextResponse.json({ error: 'Session JSONL not found' }, { status: 404 })
  }
  const file = await findSubagentFile(jsonlPath, id, agentId)
  if (!file) {
    return NextResponse.json({ error: 'Agent transcript not found' }, { status: 404 })
  }
  const replay = await parseSessionReplay(file.jsonl, `${id}/${agentId}`)
  return NextResponse.json(replay)
}

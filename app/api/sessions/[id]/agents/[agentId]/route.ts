import { NextResponse } from 'next/server'
import path from 'path'
import { access } from 'fs/promises'
import { findSessionJSONL } from '@/lib/claude-reader'
import { parseSessionReplay } from '@/lib/replay-parser'

export const dynamic = 'force-dynamic'

const AGENT_ID = /^[a-f0-9]{6,32}$/

/** Replay data for one sub-agent transcript: <session>/subagents/agent-<id>.jsonl */
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
  const agentPath = path.join(path.dirname(jsonlPath), id, 'subagents', `agent-${agentId}.jsonl`)
  try { await access(agentPath) } catch {
    return NextResponse.json({ error: 'Agent transcript not found' }, { status: 404 })
  }
  const replay = await parseSessionReplay(agentPath, `${id}/${agentId}`)
  return NextResponse.json(replay)
}

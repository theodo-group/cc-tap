import { NextResponse } from 'next/server'
import { findSessionJSONL } from '@/lib/claude-reader'
import { searchToolCalls, type SearchScope } from '@/lib/tool-search'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const url = new URL(req.url)
  const q = url.searchParams.get('q') ?? ''
  const scope: SearchScope = url.searchParams.get('scope') === 'all' ? 'all' : 'input'

  const jsonlPath = await findSessionJSONL(id)
  if (!jsonlPath) {
    return NextResponse.json({ error: 'Session JSONL not found' }, { status: 404 })
  }

  const result = await searchToolCalls(jsonlPath, id, q, scope)
  return NextResponse.json(result)
}

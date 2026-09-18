import { NextResponse, type NextRequest } from 'next/server'
import { getAllSessionRecords, type ParsedSession } from '@/lib/claude-reader'
import { sessionCost } from '@/lib/pricing'
import { sliceSession, summarizeRange } from '@/lib/session-ledger'
import { windowFromSearch } from '@/lib/time-window'
import type { SessionSlice, SessionWithFacet, SessionsResponse } from '@/types/claude'

export const dynamic = 'force-dynamic'

/** Public shape of a parsed session */
function toSessionWithFacet(p: ParsedSession): SessionWithFacet {
  return {
    ...p,
    estimated_cost: sessionCost(p),
    slug: p.slug_name,
    ai_title: p.ai_title,
    version: p.cc_version,
    git_branch: p.git_branch,
    has_compaction: p.has_compaction,
    has_thinking: p.has_thinking,
  }
}

/**
 * GET /api/sessions            → every session
 * GET /api/sessions?from&to    → sessions overlapping [from, to] (ISO or ms),
 *                                each with a `slice` of the turns inside it
 */
export async function GET(req: NextRequest) {
  const records = await getAllSessionRecords()
  const window = windowFromSearch(req.nextUrl.search)

  if (!window) {
    const sessions = records.map(r => toSessionWithFacet(r.session))
    const body: SessionsResponse = { sessions, total: sessions.length }
    return NextResponse.json(body)
  }

  const sessions: SessionWithFacet[] = []
  const slices: SessionSlice[] = []
  for (const r of records) {
    const slice = sliceSession(r, window)
    if (!slice) continue
    slices.push(slice)
    sessions.push({ ...toSessionWithFacet(r.session), slice })
  }

  const body: SessionsResponse = {
    sessions,
    total: sessions.length,
    range: summarizeRange(window, slices),
  }
  return NextResponse.json(body)
}

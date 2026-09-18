import { NextResponse } from 'next/server'
import { getAllSessionRecords } from '@/lib/claude-reader'
import type { UsageWindow } from '@/types/claude'

export const dynamic = 'force-dynamic'

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

/**
 * GET /api/usage-windows → the 5h usage windows in which a local request was
 * rejected for hitting the subscription limit, newest first. Built from the
 * `quotaLimits` records the transcripts keep on rate-limited assistant
 * lines. The start is inferred as reset − 5h.
 */
export async function GET() {
  const records = await getAllSessionRecords()
  const byReset = new Map<number, { firstHitAt: number; sessions: Set<string> }>()

  for (const r of records) {
    for (const hit of r.rate_limit_hits) {
      const w = byReset.get(hit.resets_at) ?? { firstHitAt: hit.ts, sessions: new Set<string>() }
      w.firstHitAt = Math.min(w.firstHitAt, hit.ts)
      w.sessions.add(r.session.session_id)
      byReset.set(hit.resets_at, w)
    }
  }

  const windows: UsageWindow[] = [...byReset.entries()]
    .map(([reset, w]) => ({ reset, start: reset - FIVE_HOURS_MS, first_hit_at: w.firstHitAt, sessions: w.sessions.size }))
    .sort((a, b) => b.reset - a.reset)

  return NextResponse.json({ windows })
}

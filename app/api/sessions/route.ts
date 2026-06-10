import { NextResponse } from 'next/server'
import { getAllParsedSessions } from '@/lib/claude-reader'
import { estimateCostFromUsage } from '@/lib/pricing'
import type { SessionWithFacet } from '@/types/claude'

export const dynamic = 'force-dynamic'

export async function GET() {
  const parsed = await getAllParsedSessions()

  const result: SessionWithFacet[] = parsed.map((p) => ({
    ...p,
    estimated_cost: estimateCostFromUsage('claude-opus-4-7', {
      input_tokens: p.input_tokens ?? 0,
      output_tokens: p.output_tokens ?? 0,
      cache_creation_input_tokens: p.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: p.cache_read_input_tokens ?? 0,
    }),
    slug: p.slug_name,
    ai_title: p.ai_title,
    version: p.cc_version,
    git_branch: p.git_branch,
    has_compaction: p.has_compaction,
    has_thinking: p.has_thinking,
  }))

  return NextResponse.json({ sessions: result, total: result.length })
}

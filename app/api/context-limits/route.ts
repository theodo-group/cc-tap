import { NextResponse } from 'next/server'
import { FALLBACK_CONTEXT_LIMIT, getContextLimits } from '@/lib/context-limits'

export const dynamic = 'force-dynamic'

/** Per-model context windows: the vendored defaults merged with ~/.cc-lens/context.json */
export async function GET() {
  return NextResponse.json({ limits: getContextLimits(), fallback: FALLBACK_CONTEXT_LIMIT })
}

import { NextResponse } from 'next/server'
import { getOtelStatus, startOtelIngest } from '@/lib/otel-control'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    await startOtelIngest()
    return NextResponse.json(getOtelStatus())
  } catch (e) {
    return NextResponse.json(
      { running: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}

import { NextResponse } from 'next/server'
import { stopOtelIngest } from '@/lib/otel-control'

export const dynamic = 'force-dynamic'

export async function POST() {
  const result = stopOtelIngest()
  return NextResponse.json(result)
}

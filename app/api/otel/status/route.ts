import { NextResponse } from 'next/server'
import { getOtelStatus } from '@/lib/otel-control'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(getOtelStatus())
}

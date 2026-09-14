import { NextResponse } from 'next/server'
import { findSessionJSONL } from '@/lib/claude-reader'
import { cachedReplay, gzipOf, replayEtag } from '@/lib/replay-cache'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const jsonlPath = await findSessionJSONL(id)

  if (!jsonlPath) {
    return NextResponse.json({ error: 'Session JSONL not found' }, { status: 404 })
  }

  // A reader whose copy is current is told so, and the log is not even parsed
  const etag = await replayEtag(jsonlPath)
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } })
  }

  const entry = await cachedReplay(jsonlPath, id)
  const headers = new Headers({
    'Content-Type': 'application/json',
    ETag: entry.etag,
    // Hold the body, but ask before using it: a live session grows under us
    'Cache-Control': 'no-cache',
    Vary: 'Accept-Encoding',
  })

  // 12 MB of replay is 2.3 MB compressed, and the bytes are made once per
  // version of the log, whoever asks for them.
  if ((req.headers.get('accept-encoding') ?? '').includes('gzip')) {
    const body = gzipOf(entry)
    headers.set('Content-Encoding', 'gzip')
    headers.set('Content-Length', String(body.byteLength))
    return new Response(body as unknown as BodyInit, { headers })
  }

  headers.set('Content-Length', String(entry.json.byteLength))
  return new Response(entry.json as unknown as BodyInit, { headers })
}

/**
 * Parsing a session log, once per version of that log.
 *
 * A 32 MB log takes 205-285 ms to parse and answers 12 MB of JSON; a 96 MB one
 * takes 576 ms and answers 36 MB. The route used to pay that on every request,
 * including the revalidation a page makes when it comes back into focus.
 *
 * A log only ever grows, so its size and mtime name a version exactly. That
 * version is the entry key and the ETag alike: a reader whose copy is current
 * gets 304 and no body, and a reader whose copy is stale gets bytes that were
 * serialized and compressed once, whoever asks for them.
 */
import { stat } from 'fs/promises'
import { gzipSync } from 'zlib'
import { parseSessionReplay } from '@/lib/replay-parser'
import type { ReplayData } from '@/types/claude'

/** Sessions held at once. A long one costs 12 MB parsed plus its bytes; three
 *  covers a reader moving between a session, its agents and back. */
const MAX_SESSIONS = 3

export interface CachedReplay {
  /** the version of the log these bytes were made from */
  etag: string
  replay: ReplayData
  json: Buffer
  /** made on first use: a reader that takes gzip pays for it once per version */
  gzip?: Buffer
}

const cache = new Map<string, CachedReplay>()

/** The version of a log: it only grows, so its size and mtime name it exactly */
export async function replayEtag(jsonlPath: string): Promise<string> {
  const { size, mtimeMs } = await stat(jsonlPath)
  return `"${size.toString(36)}-${Math.trunc(mtimeMs).toString(36)}"`
}

/** The parsed replay of `jsonlPath`, parsed only when its version changed */
export async function cachedReplay(jsonlPath: string, sessionId: string): Promise<CachedReplay> {
  const etag = await replayEtag(jsonlPath)
  const held = cache.get(sessionId)
  if (held?.etag === etag) {
    // Keep it: a Map preserves insertion order, so re-inserting makes it newest
    cache.delete(sessionId)
    cache.set(sessionId, held)
    return held
  }

  const replay = await parseSessionReplay(jsonlPath, sessionId)
  const entry: CachedReplay = { etag, replay, json: Buffer.from(JSON.stringify(replay)) }
  cache.set(sessionId, entry)
  while (cache.size > MAX_SESSIONS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return entry
}

/** The compressed bytes of an entry, made once per version */
export function gzipOf(entry: CachedReplay): Buffer {
  return (entry.gzip ??= gzipSync(entry.json, { level: 6 }))
}

/** Forget everything. For tests, and for a reader that wants a fresh parse. */
export function clearReplayCache(): void {
  cache.clear()
}

/** What the cache holds, for tests and for a health view */
export function replayCacheState(): Array<{ sessionId: string; etag: string; bytes: number; gzipped: boolean }> {
  return [...cache.entries()].map(([sessionId, e]) => ({
    sessionId, etag: e.etag, bytes: e.json.byteLength, gzipped: e.gzip !== undefined,
  }))
}

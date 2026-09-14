import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { cachedReplay, clearReplayCache, gzipOf, replayCacheState, replayEtag } from '@/lib/replay-cache'

let dir: string

const line = (uuid: string, text: string) => JSON.stringify({
  type: 'assistant', uuid, parentUuid: null, timestamp: '2026-01-01T00:00:00Z',
  message: { model: 'claude-opus-5', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
})

function writeLog(name: string, texts: string[]): string {
  const file = path.join(dir, `${name}.jsonl`)
  writeFileSync(file, texts.map((t, i) => line(`u${i}`, t)).join('\n') + '\n')
  return file
}

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'replay-cache-')); clearReplayCache() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('replayEtag', () => {
  it('names the version of a log, and changes when the log grows', async () => {
    const file = writeLog('a', ['one'])
    const first = await replayEtag(file)
    writeFileSync(file, `${line('u1', 'two')}\n`, { flag: 'a' })
    expect(await replayEtag(file)).not.toBe(first)
  })

  it('changes when the log is touched, even at the same size', async () => {
    const file = writeLog('a', ['one'])
    const first = await replayEtag(file)
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    expect(await replayEtag(file)).not.toBe(first)
  })
})

describe('cachedReplay', () => {
  it('parses once for a log that has not changed', async () => {
    const file = writeLog('a', ['hello'])
    const first = await cachedReplay(file, 'a')
    const second = await cachedReplay(file, 'a')
    expect(second.replay).toBe(first.replay)      // the same object, not a new parse
    expect(second.json).toBe(first.json)
  })

  it('parses again once the log grows, and says so in the etag', async () => {
    const file = writeLog('a', ['hello'])
    const first = await cachedReplay(file, 'a')
    const later = new Date(Date.now() + 60_000)
    writeFileSync(file, `${line('u9', 'goodbye')}\n`, { flag: 'a' })
    utimesSync(file, later, later)
    const second = await cachedReplay(file, 'a')
    expect(second.etag).not.toBe(first.etag)
    expect(second.replay).not.toBe(first.replay)
    expect(second.replay.turns).toHaveLength(2)
  })

  it('holds a few sessions and drops the ones left alone longest', async () => {
    for (const name of ['a', 'b', 'c', 'd']) await cachedReplay(writeLog(name, [name]), name)
    expect(replayCacheState().map(e => e.sessionId)).toEqual(['b', 'c', 'd'])
  })

  it('keeps a session that is asked for again', async () => {
    const files = Object.fromEntries(['a', 'b', 'c'].map(n => [n, writeLog(n, [n])]))
    for (const n of ['a', 'b', 'c']) await cachedReplay(files[n], n)
    await cachedReplay(files.a, 'a')                       // 'a' is wanted again
    await cachedReplay(writeLog('d', ['d']), 'd')          // so 'b' goes, not 'a'
    expect(replayCacheState().map(e => e.sessionId)).toEqual(['c', 'a', 'd'])
  })
})

describe('gzipOf', () => {
  it('compresses once per version and answers the same bytes', async () => {
    const entry = await cachedReplay(writeLog('a', ['hello '.repeat(500)]), 'a')
    const first = gzipOf(entry)
    expect(gzipOf(entry)).toBe(first)
    expect(first.byteLength).toBeLessThan(entry.json.byteLength)
    expect(replayCacheState()[0].gzipped).toBe(true)
  })
})

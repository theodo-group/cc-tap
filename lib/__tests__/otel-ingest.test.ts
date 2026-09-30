import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { DatabaseSync } from 'node:sqlite'
import { assembleSseMessage, parseSseEvents } from '@/lib/sse'
import { messageToSse, createIngester, ORPHAN_ERROR, MISSING_RESPONSE_ERROR } from '@/proxy/otel-ingest'
import { createSessionLogs } from '@/proxy/session-log'
import { openStore, parseSseUsage } from '@/proxy/capture-store'

// The final message Claude Code writes to <request-id>.response.json (thinking already redacted by CC).
const MESSAGE = {
  id: 'msg_tool',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [
    { type: 'thinking', thinking: '<REDACTED>', signature: 'sig123' },
    { type: 'text', text: 'Running it.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi', description: 'say hi' } },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 800, output_tokens: 42, service_tier: 'standard' },
}

// Same without thinking: nothing to wait for in the session JSONL.
const PLAIN = { ...MESSAGE, id: 'msg_plain', content: MESSAGE.content.slice(1) }

const SESSION = '7762d588-906e-4801-a31d-f6ae72cc41ad'

function requestBody(extra: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5-5',
    stream: true,
    betas: ['claude-code-20250219'],
    metadata: { user_id: JSON.stringify({ device_id: 'dev1', account_uuid: 'acc1', session_id: SESSION }) },
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.285.17a; cc_entrypoint=sdk-cli; cch=00000;' }, { type: 'text', text: 'You are Claude Code' }],
    messages: [{ role: 'user', content: 'run echo' }],
    tools: [{ name: 'Bash' }, { name: 'Read' }],
    ...extra,
  }
}

describe('messageToSse', () => {
  it('round-trips through the dashboard SSE reassembly', () => {
    expect(assembleSseMessage(messageToSse(MESSAGE))).toEqual(MESSAGE)
  })

  it('omits stop_sequence when the message has none', () => {
    const { stop_sequence: _omit, ...noSeq } = MESSAGE
    void _omit
    expect(assembleSseMessage(messageToSse(noSeq))).toEqual(noSeq)
  })

  it('marks the stream as synthetic without adding an event', () => {
    const sse = messageToSse(MESSAGE)
    expect(sse.startsWith(': cc-tap otel-ingest')).toBe(true)
    const names = parseSseEvents(sse).map((e) => e.event)
    expect(names[0]).toBe('message_start')
    expect(names.at(-1)).toBe('message_stop')
    expect(parseSseEvents(sse).every((e) => !e.parseError)).toBe(true)
  })

  it('carries the usage the proxy would have parsed', () => {
    expect(parseSseUsage(Buffer.from(messageToSse(MESSAGE)))).toEqual({
      input_tokens: 1200, output_tokens: 42, cache_read_tokens: 800, cache_creation_tokens: 300,
    })
  })
})

describe('openStore', () => {
  it('adds the source column to a DB created before it existed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lens-store-'))
    try {
      const old = new DatabaseSync(path.join(tmp, 'inspector.db'))
      // The schema as it was before the source column.
      const schema = fs.readFileSync(path.join(__dirname, '../../proxy/schema.sql'), 'utf8')
      old.exec(schema.replace(/,\n\s*source TEXT[^\n]*/, ''))
      old.exec(`INSERT INTO captures (request_id, timestamp, method, path, request_body_path, request_body_bytes) VALUES ('old', 1, 'POST', '/v1/messages', 'x', 1)`)
      old.close()
      const store = openStore({ root: tmp, source: 'otel' })
      const cols = (store.db.prepare('PRAGMA table_info(captures)').all() as { name: string }[]).map((c) => c.name)
      expect(cols).toContain('source')
      expect(store.db.prepare(`SELECT source FROM captures WHERE request_id = 'old'`).get()).toEqual({ source: null })
      store.close()
      // Reopening is a no-op.
      openStore({ root: tmp }).close()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('createIngester', () => {
  let tmp: string
  let bodies: string
  let projects: string
  let store: ReturnType<typeof openStore>
  const T0 = Date.now()

  const rows = () => store.db.prepare('SELECT * FROM captures ORDER BY timestamp, request_id').all() as Record<string, unknown>[]
  const row = (id: string) => rows().find((r) => r.request_id === id)
  const gunzip = (rel: unknown) => zlib.gunzipSync(fs.readFileSync(path.join(store.payloadsDir, rel as string))).toString()
  const exists = (f: string) => fs.existsSync(path.join(bodies, f))
  const make = (opts: Record<string, number> = {}) =>
    createIngester({ store, bodiesDir: bodies, sessionLogs: createSessionLogs({ projectsDir: projects, rescanMs: 0 }), ...opts })

  const writeRequest = (id: string, body: object = requestBody(), at = T0) => {
    const p = path.join(bodies, `${id}.request.json`)
    fs.writeFileSync(p, JSON.stringify(body))
    fs.utimesSync(p, new Date(at), new Date(at))
  }
  const appendIndex = (entry: Record<string, unknown>) =>
    fs.appendFileSync(path.join(bodies, 'index.jsonl'), JSON.stringify(entry) + '\n')
  const indexLine = (bodyId: string, requestId: string, at = T0 + 1000) => ({
    timestamp: new Date(at).toISOString(), session_id: SESSION, query_source: 'sdk', model: MESSAGE.model,
    request_id: requestId, message_id: MESSAGE.id, request_file: `${bodyId}.request.json`, response_file: `${requestId}.response.json`,
  })
  const answer = (bodyId: string, requestId: string, msg: object = MESSAGE, at?: number) => {
    fs.writeFileSync(path.join(bodies, `${requestId}.response.json`), JSON.stringify(msg))
    appendIndex(indexLine(bodyId, requestId, at))
  }
  // Session JSONL lines, as Claude Code writes them.
  const jsonl = (lines: object[], file = `${SESSION}.jsonl`) => {
    const abs = path.join(projects, '-home-me-proj', file)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.appendFileSync(abs, lines.map((l) => JSON.stringify({ sessionId: SESSION, ...l }) + '\n').join(''))
  }
  const retryLine = (uuid: string, at: number, status: number | null, attempt: number, retryInMs = 500) => ({
    type: 'system', subtype: 'api_error', uuid, timestamp: new Date(at).toISOString(), level: 'error',
    error: status
      ? { status, requestId: `req_fail_${attempt}`, formatted: `${status} overloaded_error`, connection: null }
      : { formatted: 'Connection dropped (ECONNRESET)', connection: { code: 'ECONNRESET' } },
    retryInMs, retryAttempt: attempt, maxRetries: 10, source: 'request_retry',
  })
  const thinkingLine = (msgId: string, index: number, thinking: string, signature: string) => ({
    type: 'assistant', uuid: `u-${msgId}-${index}`, timestamp: new Date(T0).toISOString(), requestId: 'req_x', apiBlockIndex: index,
    message: { id: msgId, role: 'assistant', content: [{ type: 'thinking', thinking, signature }] },
  })

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lens-otel-'))
    bodies = path.join(tmp, 'bodies')
    projects = path.join(tmp, 'projects')
    fs.mkdirSync(bodies)
    fs.mkdirSync(projects)
    store = openStore({ root: path.join(tmp, 'root'), source: 'otel' })
  })
  afterEach(() => {
    store.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('records an index line as a capture the dashboard can read, then deletes its files', () => {
    writeRequest('body-1')
    answer('body-1', 'req_1')
    expect(make().pollIndex(T0 + 2000)).toBe(1)

    expect(row('body-1')).toMatchObject({
      request_id: 'body-1', session_id: SESSION, account_uuid: 'acc1', device_id: 'dev1',
      cc_version: '2.1.285.17a', cc_entrypoint: 'sdk-cli', cc_config_hash: null,
      timestamp: T0, duration_ms: 1000,
      method: 'POST', path: '/v1/messages?beta=true', model: 'claude-opus-5-5', is_streaming: 1,
      status_code: 200, error: null, source: 'otel',
      input_tokens: 1200, output_tokens: 42, cache_read_tokens: 800, cache_creation_tokens: 300,
      system_blocks: 2, message_count: 1, tool_count: 2,
      request_body_path: path.join(SESSION, 'body-1.req.json.gz'),
      response_body_path: path.join(SESSION, 'body-1.res.gz'),
    })
    expect(assembleSseMessage(gunzip(row('body-1')!.response_body_path))).toEqual(MESSAGE)
    expect(JSON.parse(gunzip(row('body-1')!.request_body_path))).toEqual(requestBody())
    expect(exists('body-1.request.json')).toBe(false)
    expect(exists('req_1.response.json')).toBe(false)
  })

  it('stores a non-streaming response as JSON', () => {
    writeRequest('body-ns', requestBody({ stream: false }))
    answer('body-ns', 'req_ns')
    make().pollIndex(T0 + 2000)
    expect(row('body-ns')!.is_streaming).toBe(0)
    expect(JSON.parse(gunzip(row('body-ns')!.response_body_path))).toEqual(MESSAGE)
  })

  it('only reads new lines, waits for a partial line, and is idempotent on replay', () => {
    const ing = make()
    writeRequest('body-1')
    answer('body-1', 'req_1')
    expect(ing.pollIndex(T0 + 2000)).toBe(1)
    expect(ing.pollIndex(T0 + 2000)).toBe(0)

    writeRequest('body-2')
    fs.writeFileSync(path.join(bodies, 'req_2.response.json'), JSON.stringify(MESSAGE))
    const line = JSON.stringify(indexLine('body-2', 'req_2'))
    fs.appendFileSync(path.join(bodies, 'index.jsonl'), line.slice(0, 20))
    expect(ing.pollIndex(T0 + 2000)).toBe(0)
    fs.appendFileSync(path.join(bodies, 'index.jsonl'), line.slice(20) + '\n')
    expect(ing.pollIndex(T0 + 2000)).toBe(1)
    expect(rows()).toHaveLength(2)

    // A fresh ingester replays the whole index: already recorded, files gone, nothing changes.
    const before = rows()
    expect(make().pollIndex(T0 + 5000)).toBe(0)
    expect(rows()).toEqual(before)
  })

  it('waits for a response file that is not complete yet, and gives up after fileWaitMs', () => {
    const ing = make({ fileWaitMs: 10_000 })
    writeRequest('body-1')
    appendIndex(indexLine('body-1', 'req_1'))
    fs.writeFileSync(path.join(bodies, 'req_1.response.json'), JSON.stringify(MESSAGE).slice(0, 30))
    expect(ing.pollIndex(T0 + 1000)).toBe(0)
    fs.writeFileSync(path.join(bodies, 'req_1.response.json'), JSON.stringify(MESSAGE))
    expect(ing.pollIndex(T0 + 2000)).toBe(1)

    writeRequest('body-2')
    appendIndex(indexLine('body-2', 'req_missing'))
    expect(ing.pollIndex(T0 + 3000)).toBe(0)
    expect(ing.pollIndex(T0 + 14_000)).toBe(1)
    expect(row('body-2')).toMatchObject({ status_code: null, error: MISSING_RESPONSE_ERROR, response_body_path: null })
  })

  it('restores redacted thinking from the session JSONL, in the response and in the request history', () => {
    jsonl([thinkingLine('msg_tool', 0, 'I should run echo.', 'sig123'), thinkingLine('msg_prev', 0, 'Earlier thought.', 'sig_prev')])
    const history = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '<REDACTED>', signature: 'sig_prev' }, { type: 'text', text: 'ok' }] },
      { role: 'user', content: 'run echo' },
    ]
    writeRequest('body-1', requestBody({ messages: history }))
    answer('body-1', 'req_1')
    make().pollIndex(T0 + 2000)

    const res = assembleSseMessage(gunzip(row('body-1')!.response_body_path)) as typeof MESSAGE
    expect(res.content[0]).toEqual({ type: 'thinking', thinking: 'I should run echo.', signature: 'sig123' })
    expect(res.content.slice(1)).toEqual(MESSAGE.content.slice(1))
    const req = JSON.parse(gunzip(row('body-1')!.request_body_path))
    expect(req.messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'Earlier thought.', signature: 'sig_prev' })
  })

  it('waits briefly for a session JSONL that is behind, not for a missing one', () => {
    jsonl([{ type: 'user', uuid: 'u1', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'hi' } }])
    const ing = make({ thinkingWaitMs: 3000 })
    writeRequest('body-1')
    answer('body-1', 'req_1')
    expect(ing.pollIndex(T0 + 1000)).toBe(0)
    jsonl([thinkingLine('msg_tool', 0, 'late thought', 'sig123')])
    expect(ing.pollIndex(T0 + 1500)).toBe(1)
    expect((assembleSseMessage(gunzip(row('body-1')!.response_body_path)) as typeof MESSAGE).content[0]).toMatchObject({ thinking: 'late thought' })

    // No JSONL at all for this session: ingested at once, thinking left redacted.
    const other = 'aaaaaaaa-0000-0000-0000-000000000000'
    writeRequest('body-2', requestBody({ metadata: { user_id: JSON.stringify({ session_id: other }) } }))
    answer('body-2', 'req_2')
    expect(ing.pollIndex(T0 + 2000)).toBe(1)
  })

  it('records retried attempts with the status from the session JSONL, idempotently', () => {
    // Attempts 1-3 fail (529, 429, connection reset), attempt 4 succeeds; same body each time.
    writeRequest('a1', requestBody(), T0)
    writeRequest('a2', requestBody(), T0 + 1000)
    writeRequest('a3', requestBody(), T0 + 2000)
    writeRequest('a4', requestBody(), T0 + 3000)
    jsonl([
      retryLine('e1', T0 + 100, 529, 1),
      retryLine('e2', T0 + 1100, 429, 2),
      retryLine('e3', T0 + 2100, null, 3),
    ])
    answer('a4', 'req_ok', PLAIN, T0 + 4000)

    const ing = make()
    ing.tick(T0 + 10_000)
    expect(rows().map((r) => [r.request_id, r.status_code])).toEqual([['a1', 529], ['a2', 429], ['a3', 0], ['a4', 200]])
    expect(row('a1')).toMatchObject({
      duration_ms: 100, response_body_path: null, source: 'otel',
      error: '529 overloaded_error (attempt 1/10, retried in 500 ms; request-id req_fail_1)',
    })
    expect(row('a3')!.error).toBe('Connection dropped (ECONNRESET) (attempt 3/10, retried in 500 ms)')

    // A restart replays the index and the JSONL: same rows.
    const before = rows()
    make().tick(T0 + 20_000)
    expect(rows()).toEqual(before)
  })

  it('waits for the retry before attributing a failure, and prefers the retried body over a concurrent one', () => {
    writeRequest('main-1', requestBody(), T0)
    // A sub-agent call of the same session, sent later and still in flight.
    writeRequest('sub-1', requestBody({ messages: [{ role: 'user', content: 'sub task' }] }), T0 + 500)
    jsonl([retryLine('e1', T0 + 1000, 529, 1, 2000)])

    const ing = make()
    ing.tick(T0 + 1500)
    expect(rows()).toHaveLength(0) // the retry is not due yet
    writeRequest('main-2', requestBody(), T0 + 3000)
    ing.tick(T0 + 6000)
    expect(rows().map((r) => [r.request_id, r.status_code])).toEqual([['main-1', 529]])
  })

  it('records the attempt Claude Code gave up on', () => {
    writeRequest('a1', requestBody(), T0)
    jsonl([{
      type: 'assistant', uuid: 'final', timestamp: new Date(T0 + 400).toISOString(), requestId: 'req_last',
      isApiErrorMessage: true, apiErrorStatus: 500, error: 'server_error',
      message: { id: 'x', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: 500 api_error. Try again.' }] },
    }])
    make().tick(T0 + 1000)
    expect(row('a1')).toMatchObject({ status_code: 500, error: 'API Error: 500 api_error. Try again. (gave up; request-id req_last)', duration_ms: 400 })
  })

  it('records a body nobody claimed after the grace period, and deletes it', () => {
    const ing = make({ graceMs: 60_000 })
    writeRequest('attempt-1', requestBody(), T0)
    writeRequest('attempt-2', requestBody(), T0 + 1000)
    answer('attempt-2', 'req_ok', MESSAGE, T0 + 2000)
    ing.tick(T0 + 3000)
    ing.sweepOrphans(T0 + 30_000)
    expect(row('attempt-1')).toBeUndefined()
    ing.sweepOrphans(T0 + 61_000)
    expect(row('attempt-1')).toMatchObject({ status_code: null, error: ORPHAN_ERROR, response_body_path: null, session_id: SESSION })
    expect(exists('attempt-1.request.json')).toBe(false)
    expect(rows()).toHaveLength(2)
  })

  it('keeps a failed body until the grace period, so a late answer still lands', () => {
    const ing = make({ graceMs: 60_000 })
    writeRequest('slow', requestBody(), T0)
    jsonl([retryLine('e1', T0 + 100, 529, 1, 0)])
    ing.tick(T0 + 3000)
    expect(row('slow')!.status_code).toBe(529)
    expect(exists('slow.request.json')).toBe(true)
    answer('slow', 'req_late', PLAIN, T0 + 5000)
    ing.tick(T0 + 6000)
    expect(row('slow')).toMatchObject({ status_code: 200, error: null })
  })

  it('does not sweep while an index line is waiting for its files', () => {
    const ing = make({ graceMs: 60_000, fileWaitMs: 10_000 })
    writeRequest('body-1', requestBody(), T0)
    appendIndex(indexLine('body-1', 'req_1'))
    ing.tick(T0 + 61_000) // response file missing: the line waits
    ing.sweepOrphans(T0 + 61_000)
    expect(exists('body-1.request.json')).toBe(true)
    expect(row('body-1')).toBeUndefined()
  })

  it('rotates a fully read index and drains the rotated copy before deleting it', () => {
    const ing = make({ rotateBytes: 100, drainMs: 1000 })
    writeRequest('body-1')
    answer('body-1', 'req_1')
    ing.pollIndex(T0 + 2000)
    const rotated = () => fs.readdirSync(bodies).filter((f) => /^index-\d+\.jsonl$/.test(f))
    expect(rotated()).toHaveLength(1)
    expect(exists('index.jsonl')).toBe(false)

    // A line that raced the rename lands in the rotated copy; the next one in a new index.
    writeRequest('body-2')
    fs.writeFileSync(path.join(bodies, 'req_2.response.json'), JSON.stringify(MESSAGE))
    fs.appendFileSync(path.join(bodies, rotated()[0]), JSON.stringify(indexLine('body-2', 'req_2')) + '\n')
    writeRequest('body-3')
    answer('body-3', 'req_3')
    expect(ing.pollIndex(T0 + 2500)).toBe(2)
    expect(rotated()).toHaveLength(2) // the new index was rotated in turn…
    ing.pollIndex(T0 + 4000)
    expect(rotated()).toHaveLength(0) // …and both copies deleted once quiet
    expect(rows()).toHaveLength(3)
  })
})

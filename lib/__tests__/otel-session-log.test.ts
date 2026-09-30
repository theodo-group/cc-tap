import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createSessionLogs, restoreMessage, restoreRequest, parseFailure, describeFailure } from '@/proxy/session-log'

const SESSION = '11111111-2222-3333-4444-555555555555'

describe('createSessionLogs', () => {
  let projects: string
  const main = () => path.join(projects, '-work-proj', `${SESSION}.jsonl`)
  const sub = () => path.join(projects, '-work-proj', SESSION, 'subagents', 'agent-abc.jsonl')
  const append = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, text)
  }

  beforeEach(() => { projects = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lens-slog-')) })
  afterEach(() => { fs.rmSync(projects, { recursive: true, force: true }) })

  it('reads the main log and sub-agent logs incrementally, a partial line only once complete', () => {
    const logs = createSessionLogs({ projectsDir: projects, rescanMs: 0 })
    expect(logs.get(SESSION).found).toBe(false)

    const thinking = JSON.stringify({
      type: 'assistant', uuid: 'a', timestamp: '2026-09-30T05:00:00Z', apiBlockIndex: 1,
      message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'deep', signature: 's1' }] },
    })
    append(main(), thinking + '\n' + thinking.slice(0, 10))
    append(sub(), JSON.stringify({ type: 'system', subtype: 'api_error', uuid: 'e', timestamp: '2026-09-30T05:00:01Z', error: { status: 529 }, retryAttempt: 1, maxRetries: 10, retryInMs: 800 }) + '\n')

    const log = logs.get(SESSION)
    expect(log.found).toBe(true)
    expect(log.thinkingByMsg.get('msg_1')?.get(1)).toMatchObject({ thinking: 'deep' })
    expect(log.thinkingBySig.get('s1')).toBe('deep')
    expect(log.failures).toMatchObject([{ uuid: 'e', status: 529, attempt: 1, retryInMs: 800, final: false }])

    append(main(), thinking.slice(10) + '\n')
    logs.get(SESSION)
    expect(log.thinkingByMsg.size).toBe(1) // the completed line is the same block again
    expect(log.failures).toHaveLength(1)
  })

  it('forgets idle sessions', () => {
    const logs = createSessionLogs({ projectsDir: projects, idleMs: 1000 })
    const first = logs.get(SESSION, 0)
    logs.evictIdle(500)
    expect(logs.get(SESSION, 600)).toBe(first)
    logs.evictIdle(2000)
    expect(logs.get(SESSION, 2100)).not.toBe(first)
  })
})

describe('restoreMessage / restoreRequest', () => {
  const log = {
    thinkingByMsg: new Map([['msg_1', new Map<number, object>([[1, { type: 'redacted_thinking', data: 'opaque' }]])]]),
    thinkingBySig: new Map([['s1', 'by signature']]),
  }

  it('restores by message id + index, else by signature, and counts what is left', () => {
    const msg = {
      id: 'msg_1',
      content: [
        { type: 'thinking', thinking: '<REDACTED>', signature: 's1' },
        { type: 'redacted_thinking', data: '<REDACTED>' },
        { type: 'thinking', thinking: '<REDACTED>', signature: 'unknown' },
        { type: 'text', text: 'hi' },
      ],
    }
    const { msg: out, missing } = restoreMessage(msg, log as never)
    expect(out.content).toEqual([
      { type: 'thinking', thinking: 'by signature', signature: 's1' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'thinking', thinking: '<REDACTED>', signature: 'unknown' },
      { type: 'text', text: 'hi' },
    ])
    expect(missing).toBe(1)
    expect(msg.content[0].thinking).toBe('<REDACTED>') // input untouched
  })

  it('leaves a message without redacted blocks as is', () => {
    const msg = { id: 'm', content: [{ type: 'text', text: 'x' }] }
    expect(restoreMessage(msg, null)).toEqual({ msg, missing: 0 })
  })

  it('restores history thinking in assistant turns only', () => {
    const body = { messages: [
      { role: 'user', content: [{ type: 'thinking', thinking: '<REDACTED>', signature: 's1' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '<REDACTED>', signature: 's1' }] },
    ] }
    const { body: out, changed } = restoreRequest(body, log as never)
    expect(changed).toBe(true)
    expect(out.messages[0]).toBe(body.messages[0])
    expect(out.messages[1].content[0]).toMatchObject({ thinking: 'by signature' })
  })
})

describe('parseFailure / describeFailure', () => {
  it('ignores lines that are not failures', () => {
    expect(parseFailure({ type: 'user', uuid: 'u', timestamp: '2026-09-30T05:00:00Z' })).toBeNull()
    expect(parseFailure({ type: 'system', subtype: 'api_error' })).toBeNull() // no uuid / timestamp
  })

  it('describes a network error without a status', () => {
    const f = parseFailure({
      type: 'system', subtype: 'api_error', uuid: 'e', timestamp: '2026-09-30T05:00:00Z',
      error: { message: 'Connection error.', connection: { code: 'ECONNRESET' } }, retryAttempt: 2, maxRetries: 10, retryInMs: 1100,
    })
    expect(f).toMatchObject({ status: 0, requestId: null })
    expect(describeFailure(f!)).toBe('Connection error. (attempt 2/10, retried in 1100 ms)')
  })
})

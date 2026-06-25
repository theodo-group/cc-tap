import { describe, it, expect } from 'vitest'
import { parseSseEvents, assembleSseMessage } from '@/lib/sse'

// A representative text-only stream, with Anthropic's trailing-space padding on
// each data line (the thing that makes the raw view look "invalid").
const TEXT_STREAM = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"usage":{"input_tokens":2703,"output_tokens":4}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Thomas!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":99}}

event: message_stop
data: {"type":"message_stop"}
`

// A stream that emits a tool_use block via input_json_delta chunks.
const TOOL_STREAM = `event: message_start
data: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" -la\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}

event: message_stop
data: {"type":"message_stop"}
`

describe('parseSseEvents', () => {
  it('parses each event with its name and JSON data, tolerating trailing padding', () => {
    const events = parseSseEvents(TEXT_STREAM)
    expect(events.map((e) => e.event)).toEqual([
      'message_start', 'content_block_start', 'ping',
      'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ])
    expect(events.every((e) => !e.parseError)).toBe(true)
    expect((events[0].data as { type: string }).type).toBe('message_start')
  })

  it('flags unparseable data instead of throwing', () => {
    const events = parseSseEvents('event: weird\ndata: not json{{{\n')
    expect(events).toHaveLength(1)
    expect(events[0].parseError).toBe(true)
    expect(events[0].raw).toBe('not json{{{')
  })

  it('ignores blank trailing blocks', () => {
    expect(parseSseEvents('\n\n\n')).toHaveLength(0)
  })
})

describe('assembleSseMessage', () => {
  it('reassembles text content, final stop_reason, and merged usage', () => {
    const msg = assembleSseMessage(TEXT_STREAM)
    expect(msg).not.toBeNull()
    expect(msg!.model).toBe('claude-opus-4-8')
    expect(msg!.stop_reason).toBe('end_turn')
    expect(msg!.content).toEqual([{ type: 'text', text: 'Hi Thomas!' }])
    // usage keeps message_start fields and overlays message_delta's output_tokens
    expect(msg!.usage).toMatchObject({ input_tokens: 2703, output_tokens: 99 })
  })

  it('builds tool_use.input from accumulated input_json_delta chunks', () => {
    const msg = assembleSseMessage(TOOL_STREAM)
    expect(msg!.stop_reason).toBe('tool_use')
    expect(msg!.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
    ])
  })

  it('returns null when there is no message_start (e.g. an error body)', () => {
    expect(assembleSseMessage('event: error\ndata: {"type":"error"}\n')).toBeNull()
  })
})

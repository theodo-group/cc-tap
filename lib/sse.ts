// Parsing + reassembly of Anthropic Messages SSE streams, for the inspector's
// raw-API view. The proxy stores the response as the literal SSE bytes; these
// helpers turn that back into (a) a structured event list and (b) the final
// assembled Message object — the same accumulation an SDK performs.
//
// Pure + dependency-free so it can run in the client bundle and be unit-tested.

export interface SseEvent {
  /** `event:` name, or `message` if the block omitted one. */
  event: string
  /** Parsed `data:` JSON, or null when the payload isn't valid JSON. */
  data: unknown
  /** Raw `data:` payload (joined, trimmed) — kept for unparseable lines. */
  raw: string
  /** True when `raw` could not be JSON-parsed. */
  parseError?: boolean
}

type JsonObject = Record<string, unknown>

function asObject(v: unknown): JsonObject | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

/**
 * Split a raw SSE stream into events. Anthropic pads each `data:` line with
 * trailing spaces; JSON.parse tolerates that, so payloads parse cleanly.
 */
export function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
      // A leading single space after `data:` is part of the SSE framing, not the payload.
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    }
    if (dataLines.length === 0) continue
    const raw = dataLines.join('\n').trim()
    try {
      events.push({ event, data: JSON.parse(raw), raw })
    } catch {
      events.push({ event, data: null, raw, parseError: true })
    }
  }
  return events
}

/**
 * Reassemble the final Message object from a Messages SSE stream: concatenates
 * text/thinking deltas, builds `tool_use.input` from accumulated
 * `input_json_delta`s, and folds `message_delta` into the final stop_reason +
 * usage. Returns null when the stream has no `message_start` (e.g. an error
 * body), so callers can fall back to the raw view.
 */
export function assembleSseMessage(text: string): JsonObject | null {
  const events = parseSseEvents(text)
  let message: JsonObject | null = null
  const blocks: Record<number, JsonObject> = {}
  const jsonBuf: Record<number, string> = {}

  for (const ev of events) {
    const d = asObject(ev.data)
    if (!d) continue

    switch (d.type) {
      case 'message_start': {
        const m = asObject(d.message)
        if (m) message = { ...m }
        break
      }
      case 'content_block_start': {
        const idx = asNumber(d.index)
        const cb = asObject(d.content_block)
        if (idx !== null && cb) {
          blocks[idx] = { ...cb }
          if (cb.type === 'tool_use') jsonBuf[idx] = ''
        }
        break
      }
      case 'content_block_delta': {
        const idx = asNumber(d.index)
        const delta = asObject(d.delta)
        if (idx === null || !delta || !blocks[idx]) break
        switch (delta.type) {
          case 'text_delta': {
            const t = asString(delta.text)
            if (t !== null) blocks[idx].text = (asString(blocks[idx].text) ?? '') + t
            break
          }
          case 'input_json_delta': {
            const pj = asString(delta.partial_json)
            if (pj !== null) jsonBuf[idx] = (jsonBuf[idx] ?? '') + pj
            break
          }
          case 'thinking_delta': {
            const th = asString(delta.thinking)
            if (th !== null) blocks[idx].thinking = (asString(blocks[idx].thinking) ?? '') + th
            break
          }
          case 'signature_delta': {
            const sg = asString(delta.signature)
            if (sg !== null) blocks[idx].signature = sg
            break
          }
        }
        break
      }
      case 'content_block_stop': {
        const idx = asNumber(d.index)
        if (idx !== null && blocks[idx]?.type === 'tool_use') {
          const buf = jsonBuf[idx]
          if (buf) {
            try { blocks[idx].input = JSON.parse(buf) } catch { blocks[idx].input = buf }
          } else if (blocks[idx].input === undefined) {
            blocks[idx].input = {}
          }
        }
        break
      }
      case 'message_delta': {
        if (message) {
          const delta = asObject(d.delta)
          if (delta) Object.assign(message, delta)
          const usage = asObject(d.usage)
          if (usage) message.usage = { ...(asObject(message.usage) ?? {}), ...usage }
        }
        break
      }
    }
  }

  if (!message) return null
  message.content = Object.keys(blocks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => blocks[i])
  return message
}

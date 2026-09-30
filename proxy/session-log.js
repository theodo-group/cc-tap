/* cc-lens session log reader for the OTel ingester
 * Claude Code's raw body export redacts thinking and says nothing about failed
 * attempts; its session JSONL (<projects>/<slug>/<session>.jsonl, plus the
 * transcripts under <session>/subagents/) has both. This tails those files
 * incrementally and keeps, per session: thinking blocks by message id and by
 * signature, and one failure record per failed API attempt.
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// What Claude Code writes in place of thinking text (and redacted_thinking data).
const REDACTED = '<REDACTED>'

function claudeProjectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
}

/** Every *.jsonl under dir, recursively (sub-agents, workflow agents). */
function listJsonl(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) listJsonl(abs, out)
    else if (e.name.endsWith('.jsonl')) out.push(abs)
  }
  return out
}

/**
 * A failed attempt, from either line Claude Code writes for one:
 * - `type: system, subtype: api_error`: an attempt that is about to be retried;
 * - an assistant line with `isApiErrorMessage`: the attempt it gave up on.
 */
function parseFailure(j) {
  const ts = Date.parse(j.timestamp)
  if (!j.uuid || !Number.isFinite(ts)) return null
  if (j.type === 'system' && j.subtype === 'api_error') {
    const e = j.error ?? {}
    const code = e.connection?.code
    return {
      uuid: j.uuid, ts, final: false,
      status: typeof e.status === 'number' ? e.status : 0,
      requestId: e.requestId ?? null,
      message: String(e.formatted ?? e.message ?? (code ? `connection error (${code})` : 'API error')),
      attempt: j.retryAttempt ?? null, maxRetries: j.maxRetries ?? null,
      retryInMs: typeof j.retryInMs === 'number' ? j.retryInMs : 0,
    }
  }
  if (j.type === 'assistant' && j.isApiErrorMessage) {
    const first = Array.isArray(j.message?.content) ? j.message.content.find(b => b?.type === 'text')?.text : null
    return {
      uuid: j.uuid, ts, final: true,
      status: typeof j.apiErrorStatus === 'number' ? j.apiErrorStatus : 0,
      requestId: j.requestId ?? null,
      message: String(first ?? j.error ?? 'API error').split('\n')[0].slice(0, 300),
      attempt: null, maxRetries: null, retryInMs: 0,
    }
  }
  return null
}

/** Text for the capture row's `error` column. */
function describeFailure(f) {
  const parts = []
  if (f.final) parts.push('gave up')
  else if (f.attempt != null) parts.push(`attempt ${f.attempt}${f.maxRetries != null ? `/${f.maxRetries}` : ''}, retried in ${f.retryInMs} ms`)
  if (f.requestId) parts.push(`request-id ${f.requestId}`)
  return parts.length ? `${f.message} (${parts.join('; ')})` : f.message
}

function createSessionLog(sessionId) {
  return {
    sessionId,
    files: new Map(),        // abs path → { offset, ino }
    found: false,            // the main <session>.jsonl exists
    locatedAt: -Infinity,
    usedAt: 0,
    thinkingByMsg: new Map(), // message.id → Map<block index, block>
    thinkingBySig: new Map(), // signature → thinking text
    failures: [],
  }
}

function scanLine(log, line) {
  // Most lines carry neither; skip the JSON parse for them.
  if (!line.includes('thinking') && !line.includes('api_error') && !line.includes('isApiErrorMessage')) return
  let j
  try { j = JSON.parse(line) } catch { return }
  const failure = parseFailure(j)
  if (failure) log.failures.push(failure)
  const msg = j.type === 'assistant' ? j.message : null
  if (!msg?.id || !Array.isArray(msg.content)) return
  msg.content.forEach((block, i) => {
    if (block?.type !== 'thinking' && block?.type !== 'redacted_thinking') return
    // One line per content block, positioned by apiBlockIndex (older versions: whole message).
    const index = msg.content.length === 1 && typeof j.apiBlockIndex === 'number' ? j.apiBlockIndex : i
    let blocks = log.thinkingByMsg.get(msg.id)
    if (!blocks) log.thinkingByMsg.set(msg.id, (blocks = new Map()))
    blocks.set(index, block)
    if (block.type === 'thinking' && typeof block.signature === 'string' && typeof block.thinking === 'string') {
      log.thinkingBySig.set(block.signature, block.thinking)
    }
  })
}

/** Reads the complete lines each file gained since the last call. */
function readNewLines(log, file) {
  let st
  try { st = fs.statSync(file) } catch { return }
  let state = log.files.get(file)
  if (!state || state.ino !== st.ino || st.size < state.offset) {
    state = { offset: 0, ino: st.ino }
    log.files.set(file, state)
  }
  if (st.size === state.offset) return
  const buf = Buffer.alloc(st.size - state.offset)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, buf, 0, buf.length, state.offset) } finally { fs.closeSync(fd) }
  const end = buf.lastIndexOf(0x0a)
  if (end < 0) return // no complete line yet
  for (const line of buf.toString('utf8', 0, end).split('\n')) {
    if (line) scanLine(log, line)
  }
  state.offset += end + 1
}

/**
 * Session logs by session id, located under projectsDir on first use and
 * re-located every rescanMs (a session file or sub-agent may appear later).
 */
function createSessionLogs({ projectsDir = claudeProjectsDir(), rescanMs = 5_000, idleMs = 30 * 60_000 } = {}) {
  const logs = new Map()

  function locate(log) {
    const name = `${log.sessionId}.jsonl`
    let projects
    try { projects = fs.readdirSync(projectsDir) } catch { return }
    for (const p of projects) {
      const main = path.join(projectsDir, p, name)
      if (!fs.existsSync(main)) continue
      log.found = true
      for (const f of [main, ...listJsonl(path.join(projectsDir, p, log.sessionId, 'subagents'))]) {
        if (!log.files.has(f)) log.files.set(f, { offset: 0, ino: null })
      }
      return
    }
  }

  /** The session's log, brought up to date. */
  function get(sessionId, now = Date.now()) {
    let log = logs.get(sessionId)
    if (!log) logs.set(sessionId, (log = createSessionLog(sessionId)))
    log.usedAt = now
    if (now - log.locatedAt >= rescanMs) {
      log.locatedAt = now
      locate(log)
    }
    for (const file of log.files.keys()) readNewLines(log, file)
    return log
  }

  /** Forgets sessions nobody asked about for idleMs (their thinking text can be large). */
  function evictIdle(now = Date.now()) {
    for (const [id, log] of logs) if (now - log.usedAt >= idleMs) logs.delete(id)
  }

  return { get, evictIdle }
}

// ─── thinking restoration ───────────────────────────────────────────────────

/**
 * Puts the thinking text back into a response message's redacted blocks, by
 * message id + block index, else by signature. Returns the restored message
 * (the input if nothing changed) and how many blocks are still redacted.
 */
function restoreMessage(msg, log) {
  if (!Array.isArray(msg?.content)) return { msg, missing: 0 }
  let missing = 0
  let changed = false
  const byIndex = log?.thinkingByMsg.get(msg.id)
  const content = msg.content.map((block, i) => {
    const redactedThinking = block?.type === 'thinking' && block.thinking === REDACTED
    const redactedData = block?.type === 'redacted_thinking' && block.data === REDACTED
    if (!redactedThinking && !redactedData) return block
    const src = byIndex?.get(i)
    if (redactedThinking) {
      const text = (src?.type === 'thinking' && src.thinking !== REDACTED ? src.thinking : null) ?? log?.thinkingBySig.get(block.signature)
      if (typeof text === 'string') { changed = true; return { ...block, thinking: text } }
    } else if (src?.type === 'redacted_thinking' && typeof src.data === 'string' && src.data !== REDACTED) {
      changed = true
      return { ...block, data: src.data }
    }
    missing++
    return block
  })
  return { msg: changed ? { ...msg, content } : msg, missing }
}

/** Same for the thinking blocks in a request's message history, by signature. */
function restoreRequest(body, log) {
  if (!Array.isArray(body?.messages) || !log) return { body, changed: false }
  let changed = false
  const messages = body.messages.map(m => {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) return m
    let touched = false
    const content = m.content.map(block => {
      if (block?.type !== 'thinking' || block.thinking !== REDACTED) return block
      const text = log.thinkingBySig.get(block.signature)
      if (typeof text !== 'string') return block
      touched = true
      return { ...block, thinking: text }
    })
    if (!touched) return m
    changed = true
    return { ...m, content }
  })
  return { body: changed ? { ...body, messages } : body, changed }
}

module.exports = {
  REDACTED,
  claudeProjectsDir,
  parseFailure,
  describeFailure,
  createSessionLogs,
  restoreMessage,
  restoreRequest,
}

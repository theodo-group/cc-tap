#!/usr/bin/env node
/* cc-lens OpenTelemetry ingester — the default Live Capture mode
 * Claude Code keeps talking to api.anthropic.com and writes each API call's
 * bodies itself when run with OTEL_LOG_RAW_API_BODIES=file:<dir>:
 * <body-id>.request.json as each attempt is sent, <request-id>.response.json
 * plus one index.jsonl line when a response completes. This tails that index
 * into the same captures table + payload layout as the proxy, so the dashboard
 * works as is, then deletes the files it has ingested (Claude Code never does).
 *
 * The session JSONL fills what the export lacks (see session-log.js): thinking
 * text, which the export writes as "<REDACTED>", and failed attempts, which
 * leave a request body with no response. A failure line is matched to such a
 * body by session and time; a body nobody claims within the grace period is
 * recorded as interrupted.
 *
 * Not visible in this mode: HTTP headers, the SSE stream as sent on the wire
 * (streamed responses are re-serialized from the final message and marked as
 * such), and calls other than /v1/messages.
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { parseRequestSummary, parseSseUsage, parseNonStreamUsage, gzipWrite, openStore } = require('./capture-store')
const { createSessionLogs, describeFailure, restoreMessage, restoreRequest } = require('./session-log')

// Claude Code writes this placeholder instead of the real `cch=` hash in the bodies it logs.
const CCH_PLACEHOLDER = '00000'
const SYNTHETIC_SSE_NOTE = ': cc-tap otel-ingest: synthesized from the final message Claude Code logged, not the wire stream\n\n'
const ORPHAN_ERROR = 'no response recorded: the request was interrupted or aborted'
const MISSING_RESPONSE_ERROR = 'response file missing or unreadable'
const INDEX = 'index.jsonl'
const ROTATED = /^index-\d+\.jsonl$/

// ─── pure helpers ────────────────────────────────────────────────────────────

/**
 * Re-serializes a final Messages API object as an SSE stream, one delta per
 * content block, so the dashboard's SSE view and reassembly keep working.
 * assembleSseMessage(messageToSse(m)) deep-equals m.
 */
function messageToSse(msg) {
  const { content = [], usage, ...rest } = msg
  const events = []
  const ev = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { ...rest, content: [], stop_reason: null, ...('stop_sequence' in msg && { stop_sequence: null }), usage: usage ?? {} } })
  content.forEach((block, index) => {
    switch (block.type) {
      case 'text':
        ev('content_block_start', { index, content_block: { ...block, text: '' } })
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: block.text ?? '' } })
        break
      case 'thinking': {
        const { signature, ...shell } = block
        ev('content_block_start', { index, content_block: { ...shell, thinking: '' } })
        ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking ?? '' } })
        if (signature !== undefined) ev('content_block_delta', { index, delta: { type: 'signature_delta', signature } })
        break
      }
      case 'tool_use':
        ev('content_block_start', { index, content_block: { ...block, input: {} } })
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } })
        break
      default:
        // server_tool_use, *_tool_result, redacted_thinking…: whole block up front.
        ev('content_block_start', { index, content_block: block })
    }
    ev('content_block_stop', { index })
  })
  const delta = { stop_reason: msg.stop_reason ?? null, ...('stop_sequence' in msg && { stop_sequence: msg.stop_sequence }) }
  ev('message_delta', { delta, usage: { output_tokens: usage?.output_tokens ?? 0 } })
  ev('message_stop', {})
  return SYNTHETIC_SSE_NOTE + events.join('')
}

const idFromFile = (file, suffix) => (typeof file === 'string' && file.endsWith(suffix) ? path.basename(file, suffix) : null)
const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex')
const unlinkQuiet = abs => { try { fs.unlinkSync(abs) } catch { /* already gone */ } }

// ─── ingester ────────────────────────────────────────────────────────────────

/**
 * Stateful ingester over one bodies dir. Every write is an INSERT OR REPLACE
 * keyed by Claude Code's request body id, so replaying an index (after a
 * restart, or a line retried) is idempotent and a later, better answer (a
 * response for a body first recorded as failed) overwrites an earlier one.
 *
 * - fileWaitMs: how long an index line may wait for its files to be complete
 *   (Claude Code writes the response file and the index line concurrently).
 * - thinkingWaitMs: how long it may wait for the session JSONL to hold the
 *   thinking the export redacted.
 * - graceMs: how long a body without a response stays unclaimed (Claude Code's
 *   API timeout is 10 min) before it is recorded as interrupted and deleted.
 */
function createIngester({
  store, bodiesDir, sessionLogs = createSessionLogs(),
  fileWaitMs = 10_000, thinkingWaitMs = 3_000, graceMs = 15 * 60_000,
  rotateBytes = 1024 * 1024, drainMs = 60_000, scanEveryMs = 2_000, sweepEveryMs = 15_000,
  log = () => {},
}) {
  const db = store.db
  const rowStmt = db.prepare(`SELECT status_code, response_body_path, request_body_path, timestamp FROM captures WHERE request_id = ?`)
  const consumedStmt = db.prepare(`SELECT 1 FROM otel_failures WHERE event_uuid = ?`)
  const consumeStmt = db.prepare(`INSERT OR IGNORE INTO otel_failures (event_uuid, request_id) VALUES (?, ?)`)
  const pruneStmt = db.prepare(`DELETE FROM otel_failures WHERE request_id NOT IN (SELECT request_id FROM captures)`)

  // index.jsonl, plus rotated copies left to drain (a line Claude Code opened
  // the file for just before the rename still lands in the old one).
  const tails = []
  const tailFor = file => ({ file, offset: 0, ino: null, grewAt: Date.now() })
  try {
    for (const f of fs.readdirSync(bodiesDir).filter(f => ROTATED.test(f)).sort()) tails.push(tailFor(path.join(bodiesDir, f)))
  } catch { /* dir not created yet */ }
  let current = tailFor(path.join(bodiesDir, INDEX))
  tails.push(current)
  let blocked = false // an index line is waiting: hold off on sweeping bodies it may claim

  const bodies = new Map()   // body id → { sessionId, mtimeMs, hash, state: 'pending' | 'failed' | 'done' }
  const waitingSince = new Map() // body id → first time its index line had to wait
  const droppedFailures = new Set()
  let lastScanAt = -Infinity
  let lastSweepAt = Date.now() // first sweep only after a scan + reconcile had a chance to run

  const rowFor = bodyId => rowStmt.get(bodyId)
  const isIngested = row => row?.status_code === 200 && row.response_body_path != null

  /** The request body: from its file, else from the payload an earlier record kept. */
  function readRequest(bodyId) {
    const abs = path.join(bodiesDir, `${bodyId}.request.json`)
    try {
      return { buf: fs.readFileSync(abs), mtimeMs: fs.statSync(abs).mtimeMs }
    } catch { /* deleted after an earlier record, or never written */ }
    const row = rowFor(bodyId)
    if (!row) return null
    try {
      return { buf: zlib.gunzipSync(fs.readFileSync(path.join(store.payloadsDir, row.request_body_path))), mtimeMs: row.timestamp }
    } catch {
      return null
    }
  }

  function baseRow(bodyId, req, sessionFallback, now) {
    const summary = parseRequestSummary(req.buf)
    const sessionId = summary.session_id ?? sessionFallback ?? null
    let json = null
    try { json = JSON.parse(req.buf.toString('utf8')) } catch { /* stored as is */ }
    let reqBuf = req.buf
    if (json && sessionId) {
      const { body, changed } = restoreRequest(json, sessionLogs.get(sessionId, now))
      if (changed) reqBuf = Buffer.from(JSON.stringify(body), 'utf8')
    }
    const paths = store.bodyPathsFor(sessionId, bodyId)
    return {
      paths,
      summary,
      row: {
        request_id: bodyId,
        session_id: sessionId, account_uuid: summary.account_uuid, device_id: summary.device_id,
        cc_version: summary.cc_version, cc_entrypoint: summary.cc_entrypoint,
        cc_config_hash: summary.cc_config_hash === CCH_PLACEHOLDER ? null : summary.cc_config_hash,
        timestamp: Math.round(req.mtimeMs), // the file is written as the request is sent
        method: 'POST',
        // The SDK sends betas as ?beta=true + an anthropic-beta header; the logged body keeps them as `betas`.
        path: Array.isArray(json?.betas) ? '/v1/messages?beta=true' : '/v1/messages',
        model: summary.model, is_streaming: summary.is_streaming,
        system_blocks: summary.system_blocks, message_count: summary.message_count, tool_count: summary.tool_count,
        request_body_path: paths.reqRel,
        request_body_bytes: gzipWrite(paths.reqAbs, reqBuf),
      },
    }
  }

  function insertWithoutResponse(bodyId, req, { sessionId = null, statusCode = null, error, durationMs = null }, now) {
    const { row } = baseRow(bodyId, req, sessionId, now)
    store.insert({
      ...row,
      duration_ms: durationMs,
      status_code: statusCode, error,
      input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
      response_body_path: null, response_body_bytes: null,
    })
    log(`POST ${row.path} → ${statusCode ?? '?'} (otel, session=${row.session_id?.slice(0, 8) ?? '—'}: ${error})`)
    return row
  }

  function track(bodyId, meta) {
    const prev = bodies.get(bodyId)
    bodies.set(bodyId, { ...prev, ...meta })
  }

  /** One index.jsonl line = one completed call. 'wait' = retry this line on the next poll. */
  function ingestEntry(entry, now) {
    const bodyId = idFromFile(entry.request_file, '.request.json')
    const resName = typeof entry.response_file === 'string' ? path.basename(entry.response_file) : null
    if (!bodyId || !resName) return 'skip' // nothing to key on
    const resAbs = path.join(bodiesDir, resName)
    const reqAbs = path.join(bodiesDir, `${bodyId}.request.json`)
    if (isIngested(rowFor(bodyId))) {
      // Replay after a restart: done already, only the files may be left.
      unlinkQuiet(reqAbs)
      unlinkQuiet(resAbs)
      return 'skip'
    }

    const since = waitingSince.get(bodyId) ?? now
    const wait = () => { waitingSince.set(bodyId, since); return 'wait' }
    const req = readRequest(bodyId)
    let msg = null
    try { msg = JSON.parse(fs.readFileSync(resAbs, 'utf8')) } catch { /* not written yet, or partially */ }
    if (!req || !msg) {
      if (now - since < fileWaitMs) return wait()
      waitingSince.delete(bodyId)
      if (!req) {
        log(`skipping ${bodyId}: request file missing`)
        unlinkQuiet(resAbs)
        return 'skip'
      }
      insertWithoutResponse(bodyId, req, { sessionId: entry.session_id, error: MISSING_RESPONSE_ERROR }, now)
      track(bodyId, { state: 'done', mtimeMs: req.mtimeMs, hash: sha1(req.buf) })
      unlinkQuiet(reqAbs)
      unlinkQuiet(resAbs)
      return 'ingested'
    }

    const sessionId = parseRequestSummary(req.buf).session_id ?? entry.session_id ?? null
    const sessionLog = sessionId ? sessionLogs.get(sessionId, now) : null
    const restored = restoreMessage(msg, sessionLog)
    // The JSONL is normally written first; give it a moment if it is there but behind.
    if (restored.missing > 0 && sessionLog?.found && now - since < thinkingWaitMs) return wait()
    waitingSince.delete(bodyId)

    const { row, paths, summary } = baseRow(bodyId, req, entry.session_id, now)
    let resBuf
    let usage
    if (summary.is_streaming) {
      resBuf = Buffer.from(messageToSse(restored.msg), 'utf8')
      usage = parseSseUsage(resBuf)
    } else {
      resBuf = Buffer.from(JSON.stringify(restored.msg), 'utf8')
      usage = parseNonStreamUsage(resBuf)
    }
    const endMs = Date.parse(entry.timestamp)
    store.insert({
      ...row,
      duration_ms: Number.isFinite(endMs) ? Math.max(0, endMs - row.timestamp) : null,
      status_code: 200, error: null,
      ...usage,
      response_body_path: paths.resRel,
      response_body_bytes: gzipWrite(paths.resAbs, resBuf),
    })
    // Kept as a twin for failure matching (retries resend the same body) until the sweep.
    track(bodyId, { sessionId: row.session_id, mtimeMs: req.mtimeMs, hash: sha1(req.buf), state: 'done' })
    unlinkQuiet(reqAbs)
    unlinkQuiet(resAbs)
    log(`POST ${row.path} → 200 (otel, session=${row.session_id?.slice(0, 8) ?? '—'}, ${entry.query_source ?? '?'})`)
    return 'ingested'
  }

  /** Reads what a tail gained; returns [ingested count, whether a line is waiting]. */
  function drainTail(tail, now) {
    let st
    try { st = fs.statSync(tail.file) } catch { return [0, false] }
    if (tail.ino !== st.ino || st.size < tail.offset) { tail.offset = 0; tail.ino = st.ino } // replaced or truncated
    if (st.size === tail.offset) return [0, false]
    tail.grewAt = now
    const buf = Buffer.alloc(st.size - tail.offset)
    const fd = fs.openSync(tail.file, 'r')
    try { fs.readSync(fd, buf, 0, buf.length, tail.offset) } finally { fs.closeSync(fd) }
    let ingested = 0
    let pos = 0
    for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, pos)) {
      const line = buf.toString('utf8', pos, nl)
      if (line.trim()) {
        let entry = null
        try { entry = JSON.parse(line) } catch { log(`skipping malformed index line: ${line.slice(0, 80)}`) }
        const r = entry ? ingestEntry(entry, now) : 'skip'
        if (r === 'wait') return [ingested, true]
        if (r === 'ingested') ingested++
      }
      tail.offset += nl + 1 - pos
      pos = nl + 1
    }
    return [ingested, false] // an unterminated last line is re-read next time
  }

  /** Ingests what the index (and rotated copies) gained; rotates a large, fully read index. */
  function pollIndex(now = Date.now()) {
    let ingested = 0
    blocked = false
    for (const tail of [...tails]) {
      const [n, waiting] = drainTail(tail, now)
      ingested += n
      if (waiting) { blocked = true; break } // keep lines in order
      if (tail !== current && now - tail.grewAt >= drainMs) {
        unlinkQuiet(tail.file)
        tails.splice(tails.indexOf(tail), 1)
      }
    }
    if (!blocked && current.offset >= rotateBytes) {
      const rotated = path.join(bodiesDir, `index-${now}.jsonl`)
      try {
        fs.renameSync(current.file, rotated)
        current.file = rotated
        current.grewAt = now
        current = tailFor(path.join(bodiesDir, INDEX))
        tails.push(current)
      } catch (err) {
        log(`index rotation failed: ${err.message}`)
      }
    }
    return ingested
  }

  /** Notes request bodies on disk that the index has not accounted for. */
  function scanBodies(now = Date.now()) {
    let files
    try { files = fs.readdirSync(bodiesDir) } catch { return }
    for (const f of files) {
      const bodyId = idFromFile(f, '.request.json')
      if (!bodyId || bodies.has(bodyId)) continue
      let buf
      let mtimeMs
      try {
        mtimeMs = fs.statSync(path.join(bodiesDir, f)).mtimeMs
        buf = fs.readFileSync(path.join(bodiesDir, f))
      } catch { continue }
      const summary = parseRequestSummary(buf)
      if (!summary.session_id && now - mtimeMs < 5_000) continue // possibly still being written
      // A body an earlier run already recorded keeps that record.
      const row = rowFor(bodyId)
      const state = isIngested(row) ? 'done' : row ? 'failed' : 'pending'
      bodies.set(bodyId, { sessionId: summary.session_id, mtimeMs, hash: sha1(buf), state })
    }
  }

  /**
   * Records the session JSONL's failed attempts against unanswered bodies:
   * the same session, sent before the failure, preferring a body with an
   * identical twin (a retry resends the same body), then the latest one.
   */
  function reconcileFailures(now = Date.now()) {
    const sessions = new Set([...bodies.values()].filter(b => b.state === 'pending' && b.sessionId).map(b => b.sessionId))
    for (const sessionId of sessions) {
      const sessionLog = sessionLogs.get(sessionId, now)
      const mine = [...bodies.entries()].filter(([, b]) => b.sessionId === sessionId)
      for (const f of [...sessionLog.failures].sort((a, b) => a.ts - b.ts)) {
        if (droppedFailures.has(f.uuid) || consumedStmt.get(f.uuid)) continue
        // Wait for the retry to be sent, so its twin can point at the right body.
        if (!f.final && now < f.ts + f.retryInMs + 2_000) continue
        const candidates = mine.filter(([, b]) => b.state === 'pending' && b.mtimeMs <= f.ts + 50 && b.mtimeMs >= f.ts - graceMs)
        const twin = b => mine.some(([, o]) => o !== b && o.hash === b.hash)
        candidates.sort(([, a], [, b]) => (twin(b) - twin(a)) || (b.mtimeMs - a.mtimeMs))
        const [bodyId, body] = candidates[0] ?? []
        if (!bodyId) {
          if (now - f.ts > graceMs) droppedFailures.add(f.uuid) // its body is gone
          continue
        }
        const req = readRequest(bodyId)
        if (!req) { bodies.delete(bodyId); continue }
        insertWithoutResponse(bodyId, req, {
          sessionId, statusCode: f.status, error: describeFailure(f), durationMs: Math.max(0, Math.round(f.ts - req.mtimeMs)),
        }, now)
        consumeStmt.run(f.uuid, bodyId)
        body.state = 'failed'
      }
    }
  }

  /**
   * Past the grace period: a body still unclaimed is recorded as interrupted,
   * and every tracked body file is deleted (its payload is in the store).
   * Skipped while an index line waits, since that line may still claim one.
   */
  function sweepOrphans(now = Date.now()) {
    if (blocked) return
    for (const [bodyId, b] of bodies) {
      if (now - b.mtimeMs < graceMs) continue
      const reqAbs = path.join(bodiesDir, `${bodyId}.request.json`)
      if (b.state === 'pending' && !rowFor(bodyId)) {
        const req = readRequest(bodyId)
        if (req) insertWithoutResponse(bodyId, req, { sessionId: b.sessionId, error: ORPHAN_ERROR }, now)
      }
      unlinkQuiet(reqAbs)
      bodies.delete(bodyId)
    }
    // Responses whose index line never came (Claude Code exited in between).
    let files = []
    try { files = fs.readdirSync(bodiesDir) } catch { /* */ }
    for (const f of files) {
      if (!f.endsWith('.response.json')) continue
      const abs = path.join(bodiesDir, f)
      try { if (now - fs.statSync(abs).mtimeMs >= graceMs) unlinkQuiet(abs) } catch { /* */ }
    }
    pruneStmt.run()
    sessionLogs.evictIdle(now)
  }

  /** One polling step: index, then (throttled) failures, then (throttled) cleanup. */
  function tick(now = Date.now()) {
    const ingested = pollIndex(now)
    if (!blocked && now - lastScanAt >= scanEveryMs) {
      lastScanAt = now
      scanBodies(now)
      reconcileFailures(now)
    }
    if (now - lastSweepAt >= sweepEveryMs) {
      lastSweepAt = now
      sweepOrphans(now)
    }
    return ingested
  }

  return { pollIndex, scanBodies, reconcileFailures, sweepOrphans, tick }
}

// ─── main ────────────────────────────────────────────────────────────────────

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function main() {
  const bodiesDir = path.resolve(process.env.CC_LENS_OTEL_BODIES_DIR || path.join(os.homedir(), '.cc-lens', 'otel-bodies'))
  const graceMs = Number(process.env.CC_LENS_OTEL_GRACE_MS || 15 * 60_000)
  const log = msg => process.stderr.write(`[cc-lens-otel] ${msg}\n`)

  const store = openStore({ source: 'otel' })
  // Same file the dashboard reads for status (lib/otel-control.ts). One ingester per machine.
  const statePath = path.join(store.root, 'otel-ingest.json')
  try {
    const other = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (other.pid !== process.pid && isAlive(other.pid)) {
      log(`already running (pid ${other.pid}), exiting`)
      store.close()
      process.exit(0)
    }
  } catch { /* no state file */ }
  fs.mkdirSync(bodiesDir, { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, bodiesDir, startedAt: Date.now() }, null, 2))

  const ingester = createIngester({ store, bodiesDir, graceMs, log })
  const tick = () => {
    try {
      if (ingester.tick() > 0) store.enforceRetention()
    } catch (err) {
      log(`poll failed: ${err.message}`)
    }
  }
  tick()
  const timer = setInterval(tick, 500)

  log(`bodies dir   = ${bodiesDir}`)
  log(`inspector.db = ${store.dbPath}`)
  log(`Run Claude Code with: OTEL_LOG_RAW_API_BODIES=file:${bodiesDir} claude`)
  store.enforceRetention()

  const shutdown = () => {
    clearInterval(timer)
    try {
      if (JSON.parse(fs.readFileSync(statePath, 'utf8')).pid === process.pid) fs.unlinkSync(statePath)
    } catch { /* */ }
    try { store.close() } catch { /* */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (require.main === module) main()

module.exports = { messageToSse, createIngester, CCH_PLACEHOLDER, ORPHAN_ERROR, MISSING_RESPONSE_ERROR }

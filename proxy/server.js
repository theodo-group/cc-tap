#!/usr/bin/env node
/* cc-lens inspector proxy
 * Forwards every request to api.anthropic.com and captures request+response
 * bodies to ~/.cc-lens/payloads/<sessionId>/<requestId>.{req,res}.gz, with
 * a SQLite index at ~/.cc-lens/inspector.db.
 *
 * Auth model: blind passthrough. The user must set ANTHROPIC_API_KEY (and
 * point CC at this proxy via ANTHROPIC_BASE_URL) so CC sends a valid
 * x-api-key / Authorization header — the proxy forwards it untouched.
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { DatabaseSync } = require('node:sqlite')

// ─── config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.CC_LENS_PROXY_PORT || 8089)
const UPSTREAM = process.env.CC_LENS_UPSTREAM || 'https://api.anthropic.com'
const HOME = os.homedir()
const ROOT = path.join(HOME, '.cc-lens')
const DB_PATH = path.join(ROOT, 'inspector.db')
const PAYLOADS_DIR = path.join(ROOT, 'payloads')
const RETENTION_BYTES = Number(process.env.CC_LENS_RETENTION_BYTES || 1024 * 1024 * 1024) // 1 GB
const RETENTION_DAYS = Number(process.env.CC_LENS_RETENTION_DAYS || 30)

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
])

// ─── setup ───────────────────────────────────────────────────────────────────

fs.mkdirSync(ROOT, { recursive: true })
fs.mkdirSync(PAYLOADS_DIR, { recursive: true })

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))

const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO captures (
    request_id, session_id, account_uuid, device_id,
    cc_version, cc_entrypoint, cc_config_hash,
    timestamp, duration_ms, method, path, model, is_streaming,
    status_code, error,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    system_blocks, message_count, tool_count,
    request_body_path, response_body_path,
    request_body_bytes, response_body_bytes
  ) VALUES (
    @request_id, @session_id, @account_uuid, @device_id,
    @cc_version, @cc_entrypoint, @cc_config_hash,
    @timestamp, @duration_ms, @method, @path, @model, @is_streaming,
    @status_code, @error,
    @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
    @system_blocks, @message_count, @tool_count,
    @request_body_path, @response_body_path,
    @request_body_bytes, @response_body_bytes
  )
`)

const oldestSessionsStmt = db.prepare(`
  SELECT session_id, MIN(timestamp) AS oldest, SUM(request_body_bytes + COALESCE(response_body_bytes, 0)) AS bytes
  FROM captures
  WHERE session_id IS NOT NULL
  GROUP BY session_id
  ORDER BY oldest ASC
`)
const deleteSessionStmt = db.prepare(`DELETE FROM captures WHERE session_id = ?`)
const totalBytesStmt = db.prepare(`SELECT COALESCE(SUM(request_body_bytes + COALESCE(response_body_bytes, 0)), 0) AS bytes FROM captures`)
const oldByDateStmt = db.prepare(`SELECT request_id, session_id, request_body_path, response_body_path FROM captures WHERE timestamp < ?`)
const deleteOldStmt = db.prepare(`DELETE FROM captures WHERE timestamp < ?`)

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseBilling(text) {
  // First system block carries: x-anthropic-billing-header: cc_version=...; cc_entrypoint=...; cch=...;
  const out = { cc_version: null, cc_entrypoint: null, cc_config_hash: null }
  if (!text || typeof text !== 'string') return out
  const m = text.match(/x-anthropic-billing-header:\s*([^\n]+)/i)
  if (!m) return out
  for (const seg of m[1].split(';')) {
    const [k, v] = seg.trim().split('=')
    if (!k) continue
    if (k === 'cc_version')    out.cc_version    = v
    if (k === 'cc_entrypoint') out.cc_entrypoint = v
    if (k === 'cch')           out.cc_config_hash = v
  }
  return out
}

function parseRequestSummary(buf) {
  // Best-effort: extract identifying fields from a JSON request body.
  // Errors swallowed — capture must succeed even if parse fails.
  const out = {
    session_id: null, account_uuid: null, device_id: null,
    cc_version: null, cc_entrypoint: null, cc_config_hash: null,
    model: null, is_streaming: 0,
    system_blocks: null, message_count: null, tool_count: null,
  }
  if (!buf || buf.length === 0) return out
  try {
    const json = JSON.parse(buf.toString('utf8'))
    out.model = json.model ?? null
    out.is_streaming = json.stream ? 1 : 0
    out.system_blocks = Array.isArray(json.system) ? json.system.length : null
    out.message_count = Array.isArray(json.messages) ? json.messages.length : null
    out.tool_count    = Array.isArray(json.tools) ? json.tools.length : null
    if (json.metadata && typeof json.metadata.user_id === 'string') {
      try {
        const meta = JSON.parse(json.metadata.user_id)
        out.session_id   = meta.session_id ?? null
        out.account_uuid = meta.account_uuid ?? null
        out.device_id    = meta.device_id ?? null
      } catch { /* ignore */ }
    }
    // Pull billing header from the first system block if present.
    if (Array.isArray(json.system)) {
      for (const block of json.system) {
        const text = typeof block === 'string' ? block : block?.text
        const billing = parseBilling(text)
        if (billing.cc_version) {
          Object.assign(out, billing)
          break
        }
      }
    }
  } catch { /* malformed JSON — that's fine, we still captured the bytes */ }
  return out
}

function parseSseUsage(buf) {
  // Walk SSE bytes looking for `event: message_start` and `event: message_delta`
  // payloads. Aggregate the usage object.
  const out = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null }
  if (!buf || buf.length === 0) return out
  const text = buf.toString('utf8')
  for (const block of text.split('\n\n')) {
    const dataLine = block.split('\n').find(l => l.startsWith('data:'))
    if (!dataLine) continue
    try {
      const json = JSON.parse(dataLine.slice(5).trim())
      const usage = json.message?.usage || json.usage
      if (!usage) continue
      if (typeof usage.input_tokens === 'number')              out.input_tokens          = usage.input_tokens
      if (typeof usage.output_tokens === 'number')             out.output_tokens         = usage.output_tokens
      if (typeof usage.cache_read_input_tokens === 'number')   out.cache_read_tokens     = usage.cache_read_input_tokens
      if (typeof usage.cache_creation_input_tokens === 'number') out.cache_creation_tokens = usage.cache_creation_input_tokens
    } catch { /* skip */ }
  }
  return out
}

function parseNonStreamUsage(buf) {
  if (!buf || buf.length === 0) return { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null }
  try {
    const json = JSON.parse(buf.toString('utf8'))
    const u = json.usage || {}
    return {
      input_tokens: u.input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      cache_read_tokens: u.cache_read_input_tokens ?? null,
      cache_creation_tokens: u.cache_creation_input_tokens ?? null,
    }
  } catch {
    return { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null }
  }
}

function gzipWrite(absPath, buf) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  const gz = zlib.gzipSync(buf, { level: 6 })
  fs.writeFileSync(absPath, gz)
  return gz.length
}

function bodyPathsFor(sessionId, requestId) {
  const sid = sessionId || 'unknown'
  const dir = path.join(PAYLOADS_DIR, sid)
  return {
    reqAbs: path.join(dir, `${requestId}.req.json.gz`),
    resAbs: path.join(dir, `${requestId}.res.gz`),
    reqRel: path.join(sid, `${requestId}.req.json.gz`),
    resRel: path.join(sid, `${requestId}.res.gz`),
  }
}

// ─── retention ───────────────────────────────────────────────────────────────

let lastRetentionAt = 0
function enforceRetention() {
  const now = Date.now()
  if (now - lastRetentionAt < 60_000) return // throttle: at most once a minute
  lastRetentionAt = now

  // 1. Drop captures older than RETENTION_DAYS.
  const cutoff = now - RETENTION_DAYS * 86_400_000
  const oldRows = oldByDateStmt.all(cutoff)
  if (oldRows.length > 0) {
    for (const row of oldRows) {
      try { fs.unlinkSync(path.join(PAYLOADS_DIR, row.request_body_path)) } catch { /* */ }
      if (row.response_body_path) {
        try { fs.unlinkSync(path.join(PAYLOADS_DIR, row.response_body_path)) } catch { /* */ }
      }
    }
    deleteOldStmt.run(cutoff)
  }

  // 2. Drop oldest sessions until total bytes ≤ RETENTION_BYTES.
  let total = totalBytesStmt.get().bytes
  if (total <= RETENTION_BYTES) return
  const sessions = oldestSessionsStmt.all()
  for (const s of sessions) {
    if (total <= RETENTION_BYTES) break
    try {
      fs.rmSync(path.join(PAYLOADS_DIR, s.session_id || 'unknown'), { recursive: true, force: true })
    } catch { /* */ }
    deleteSessionStmt.run(s.session_id)
    total -= s.bytes
  }
}

// ─── server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()

  // Buffer request body (Anthropic /v1/messages bodies are reasonable in size — up to a few MB)
  const reqChunks = []
  req.on('data', c => reqChunks.push(c))
  req.on('end', async () => {
    const reqBody = Buffer.concat(reqChunks)

    // Forward headers untouched, drop hop-by-hop and host
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue
      if (k.toLowerCase() === 'host') continue
      headers[k] = v
    }

    const upstreamUrl = `${UPSTREAM}${req.url}`

    let upstream
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: reqBody.length > 0 ? reqBody : undefined,
      })
    } catch (err) {
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'cc-lens-proxy upstream fetch failed', detail: String(err?.message || err) }))
      // Persist what we have
      const summary = parseRequestSummary(reqBody)
      const paths = bodyPathsFor(summary.session_id, requestId)
      const reqGzBytes = reqBody.length > 0 ? gzipWrite(paths.reqAbs, reqBody) : 0
      try {
        insertStmt.run({
          request_id: requestId,
          session_id: summary.session_id, account_uuid: summary.account_uuid, device_id: summary.device_id,
          cc_version: summary.cc_version, cc_entrypoint: summary.cc_entrypoint, cc_config_hash: summary.cc_config_hash,
          timestamp: startedAt, duration_ms: Date.now() - startedAt,
          method: req.method, path: req.url,
          model: summary.model, is_streaming: summary.is_streaming,
          status_code: 0, error: String(err?.message || err),
          input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
          system_blocks: summary.system_blocks, message_count: summary.message_count, tool_count: summary.tool_count,
          request_body_path: paths.reqRel, response_body_path: null,
          request_body_bytes: reqGzBytes, response_body_bytes: null,
        })
      } catch { /* */ }
      return
    }

    // Mirror status + headers back to client. fetch() decodes content-encoding
    // automatically, so we strip that header and content-length / transfer-encoding.
    res.statusCode = upstream.status
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase()
      if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') return
      res.setHeader(k, v)
    })

    if (!upstream.body) {
      res.end()
      // Persist
      const summary = parseRequestSummary(reqBody)
      const paths = bodyPathsFor(summary.session_id, requestId)
      const reqGzBytes = reqBody.length > 0 ? gzipWrite(paths.reqAbs, reqBody) : 0
      insertStmt.run({
        request_id: requestId,
        session_id: summary.session_id, account_uuid: summary.account_uuid, device_id: summary.device_id,
        cc_version: summary.cc_version, cc_entrypoint: summary.cc_entrypoint, cc_config_hash: summary.cc_config_hash,
        timestamp: startedAt, duration_ms: Date.now() - startedAt,
        method: req.method, path: req.url,
        model: summary.model, is_streaming: summary.is_streaming,
        status_code: upstream.status, error: null,
        input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
        system_blocks: summary.system_blocks, message_count: summary.message_count, tool_count: summary.tool_count,
        request_body_path: paths.reqRel, response_body_path: null,
        request_body_bytes: reqGzBytes, response_body_bytes: 0,
      })
      enforceRetention()
      return
    }

    // Tee the response body: forward to client + accumulate to buffer.
    // ReadableStream.tee() gives us two independent readers over the same data.
    const [forwardStream, captureStream] = upstream.body.tee()

    // Forward branch — pipe straight to the client response.
    Readable.fromWeb(forwardStream).pipe(res)

    // Capture branch — accumulate, then persist on completion.
    ;(async () => {
      const resChunks = []
      const reader = captureStream.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) resChunks.push(Buffer.from(value))
      }
      const resBody = Buffer.concat(resChunks)
      const summary = parseRequestSummary(reqBody)
      const isStream = summary.is_streaming === 1 ||
        (upstream.headers.get('content-type') || '').includes('text/event-stream')
      const usage = isStream ? parseSseUsage(resBody) : parseNonStreamUsage(resBody)
      const paths = bodyPathsFor(summary.session_id, requestId)
      const reqGzBytes = reqBody.length > 0 ? gzipWrite(paths.reqAbs, reqBody) : 0
      const resGzBytes = resBody.length > 0 ? gzipWrite(paths.resAbs, resBody) : 0
      try {
        insertStmt.run({
          request_id: requestId,
          session_id: summary.session_id, account_uuid: summary.account_uuid, device_id: summary.device_id,
          cc_version: summary.cc_version, cc_entrypoint: summary.cc_entrypoint, cc_config_hash: summary.cc_config_hash,
          timestamp: startedAt, duration_ms: Date.now() - startedAt,
          method: req.method, path: req.url,
          model: summary.model, is_streaming: isStream ? 1 : 0,
          status_code: upstream.status, error: null,
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
          cache_read_tokens: usage.cache_read_tokens, cache_creation_tokens: usage.cache_creation_tokens,
          system_blocks: summary.system_blocks, message_count: summary.message_count, tool_count: summary.tool_count,
          request_body_path: paths.reqRel,
          response_body_path: resBody.length > 0 ? paths.resRel : null,
          request_body_bytes: reqGzBytes, response_body_bytes: resGzBytes,
        })
        process.stderr.write(`[cc-lens-proxy] ${req.method} ${req.url} → ${upstream.status} (${Date.now() - startedAt}ms, session=${summary.session_id?.slice(0,8) ?? '—'})\n`)
      } catch (err) {
        process.stderr.write(`[cc-lens-proxy] insert failed: ${err.message}\n`)
      }
      enforceRetention()
    })().catch(err => {
      process.stderr.write(`[cc-lens-proxy] capture failed: ${err.message}\n`)
    })
  })

  req.on('error', err => {
    process.stderr.write(`[cc-lens-proxy] request error: ${err.message}\n`)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[cc-lens-proxy] listening on http://localhost:${PORT}\n`)
  process.stderr.write(`[cc-lens-proxy] inspector.db = ${DB_PATH}\n`)
  process.stderr.write(`[cc-lens-proxy] payloads     = ${PAYLOADS_DIR}\n`)
  enforceRetention()
})

function shutdown() {
  try { server.close() } catch { /* */ }
  try { db.close() } catch { /* */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

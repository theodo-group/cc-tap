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
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const {
  parseRequestSummary, parseSseUsage, parseNonStreamUsage, gzipWrite, openStore,
} = require('./capture-store')

// ─── config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.CC_LENS_PROXY_PORT || 8089)
const UPSTREAM = process.env.CC_LENS_UPSTREAM || 'https://api.anthropic.com'

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
])

// ─── setup ───────────────────────────────────────────────────────────────────

const store = openStore()
const { bodyPathsFor, enforceRetention } = store

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
        store.insert({
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
      store.insert({
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
        store.insert({
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
  process.stderr.write(`[cc-lens-proxy] inspector.db = ${store.dbPath}\n`)
  process.stderr.write(`[cc-lens-proxy] payloads     = ${store.payloadsDir}\n`)
  enforceRetention()
})

function shutdown() {
  try { server.close() } catch { /* */ }
  try { store.close() } catch { /* */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

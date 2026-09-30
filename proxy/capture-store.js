/* cc-lens capture store
 * What every capture path shares: the SQLite index at ~/.cc-lens/inspector.db,
 * the gzipped payload layout under ~/.cc-lens/payloads/<sessionId>/, request
 * parsing, and retention. Used by the reverse proxy (server.js) and by the
 * OpenTelemetry ingester (otel-ingest.js), so both feed the same UI.
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')

// ─── parsing ─────────────────────────────────────────────────────────────────

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

const NO_USAGE = () => ({ input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null })

function parseSseUsage(buf) {
  // Walk SSE bytes looking for `event: message_start` and `event: message_delta`
  // payloads. Aggregate the usage object.
  const out = NO_USAGE()
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
  if (!buf || buf.length === 0) return NO_USAGE()
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
    return NO_USAGE()
  }
}

// ─── store ───────────────────────────────────────────────────────────────────

/** Brings a DB created by an older version up to schema.sql (CREATE IF NOT EXISTS skips existing tables). */
function migrate(db) {
  const has = () => db.prepare(`PRAGMA table_info(captures)`).all().some(c => c.name === 'source')
  if (has()) return
  try {
    db.exec(`ALTER TABLE captures ADD COLUMN source TEXT`)
  } catch (err) {
    if (!has()) throw err // lost the race to the other writer: fine
  }
}

function gzipWrite(absPath, buf) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  const gz = zlib.gzipSync(buf, { level: 6 })
  fs.writeFileSync(absPath, gz)
  return gz.length
}

/**
 * Opens ~/.cc-lens/inspector.db (creating it and the payloads dir), and returns
 * the write side both capture paths need. `root` is overridable for tests;
 * `source` is recorded on every row this writer inserts.
 */
function openStore({
  root = path.join(os.homedir(), '.cc-lens'),
  source = 'proxy',
  retentionBytes = Number(process.env.CC_LENS_RETENTION_BYTES || 1024 * 1024 * 1024), // 1 GB
  retentionDays = Number(process.env.CC_LENS_RETENTION_DAYS || 30),
} = {}) {
  // Required lazily: node:sqlite prints an ExperimentalWarning on some Node
  // versions, and the pure parsers above must stay importable without it.
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = path.join(root, 'inspector.db')
  const payloadsDir = path.join(root, 'payloads')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(payloadsDir, { recursive: true })

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))
  migrate(db)

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO captures (
      request_id, session_id, account_uuid, device_id,
      cc_version, cc_entrypoint, cc_config_hash,
      timestamp, duration_ms, method, path, model, is_streaming,
      status_code, error,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      system_blocks, message_count, tool_count,
      request_body_path, response_body_path,
      request_body_bytes, response_body_bytes, source
    ) VALUES (
      @request_id, @session_id, @account_uuid, @device_id,
      @cc_version, @cc_entrypoint, @cc_config_hash,
      @timestamp, @duration_ms, @method, @path, @model, @is_streaming,
      @status_code, @error,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
      @system_blocks, @message_count, @tool_count,
      @request_body_path, @response_body_path,
      @request_body_bytes, @response_body_bytes, @source
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

  function bodyPathsFor(sessionId, requestId) {
    const sid = sessionId || 'unknown'
    const dir = path.join(payloadsDir, sid)
    return {
      reqAbs: path.join(dir, `${requestId}.req.json.gz`),
      resAbs: path.join(dir, `${requestId}.res.gz`),
      reqRel: path.join(sid, `${requestId}.req.json.gz`),
      resRel: path.join(sid, `${requestId}.res.gz`),
    }
  }

  let lastRetentionAt = 0
  function enforceRetention() {
    const now = Date.now()
    if (now - lastRetentionAt < 60_000) return // throttle: at most once a minute
    lastRetentionAt = now

    // 1. Drop captures older than retentionDays.
    const cutoff = now - retentionDays * 86_400_000
    const oldRows = oldByDateStmt.all(cutoff)
    if (oldRows.length > 0) {
      for (const row of oldRows) {
        try { fs.unlinkSync(path.join(payloadsDir, row.request_body_path)) } catch { /* */ }
        if (row.response_body_path) {
          try { fs.unlinkSync(path.join(payloadsDir, row.response_body_path)) } catch { /* */ }
        }
      }
      deleteOldStmt.run(cutoff)
    }

    // 2. Drop oldest sessions until total bytes ≤ retentionBytes.
    let total = totalBytesStmt.get().bytes
    if (total <= retentionBytes) return
    const sessions = oldestSessionsStmt.all()
    for (const s of sessions) {
      if (total <= retentionBytes) break
      try {
        fs.rmSync(path.join(payloadsDir, s.session_id || 'unknown'), { recursive: true, force: true })
      } catch { /* */ }
      deleteSessionStmt.run(s.session_id)
      total -= s.bytes
    }
  }

  return {
    db,
    root,
    dbPath,
    payloadsDir,
    bodyPathsFor,
    insert: row => insertStmt.run({ ...row, source }),
    enforceRetention,
    close: () => db.close(),
  }
}

module.exports = {
  parseBilling,
  parseRequestSummary,
  parseSseUsage,
  parseNonStreamUsage,
  gzipWrite,
  openStore,
}

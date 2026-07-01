import path from 'path'
import os from 'os'
import fs from 'fs'
import zlib from 'zlib'
import { DatabaseSync } from 'node:sqlite'
import type { CaptureRow, CaptureSummary, CaptureDetail, AnthropicRequestBody } from '@/types/inspector'

const ROOT = path.join(os.homedir(), '.cc-lens')
const DB_PATH = path.join(ROOT, 'inspector.db')
const PAYLOADS_DIR = path.join(ROOT, 'payloads')

let _db: DatabaseSync | null = null

function getDb(): DatabaseSync | null {
  if (_db) return _db
  // A readOnly open on a missing file throws, so bail early and treat the
  // inspector as absent until the proxy has created the DB.
  if (!fs.existsSync(DB_PATH)) return null
  _db = new DatabaseSync(DB_PATH, { readOnly: true })
  _db.exec('PRAGMA journal_mode = WAL')
  return _db
}

export function inspectorAvailable(): boolean {
  return fs.existsSync(DB_PATH)
}

function rowToSummary(r: CaptureRow): CaptureSummary {
  return {
    request_id: r.request_id,
    session_id: r.session_id,
    timestamp: r.timestamp,
    duration_ms: r.duration_ms,
    method: r.method,
    path: r.path,
    model: r.model,
    is_streaming: r.is_streaming === 1,
    status_code: r.status_code,
    error: r.error,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_creation_tokens: r.cache_creation_tokens,
    system_blocks: r.system_blocks,
    message_count: r.message_count,
    tool_count: r.tool_count,
    request_body_bytes: r.request_body_bytes,
    response_body_bytes: r.response_body_bytes,
    cc_version: r.cc_version,
  }
}

export function listCapturesBySession(sessionId: string, limit = 500): CaptureSummary[] {
  const db = getDb()
  if (!db) return []
  const rows = db
    .prepare(`SELECT * FROM captures WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?`)
    .all(sessionId, limit) as unknown as CaptureRow[]
  return rows.map(rowToSummary)
}

export function listRecentCaptures(limit = 100): CaptureSummary[] {
  const db = getDb()
  if (!db) return []
  const rows = db
    .prepare(`SELECT * FROM captures ORDER BY timestamp DESC LIMIT ?`)
    .all(limit) as unknown as CaptureRow[]
  return rows.map(rowToSummary)
}

export function getCapture(requestId: string): CaptureDetail | null {
  const db = getDb()
  if (!db) return null
  const row = db
    .prepare(`SELECT * FROM captures WHERE request_id = ?`)
    .get(requestId) as CaptureRow | undefined
  if (!row) return null

  const summary = rowToSummary(row)
  let request_body: AnthropicRequestBody | null = null
  try {
    const reqAbs = path.join(PAYLOADS_DIR, row.request_body_path)
    if (fs.existsSync(reqAbs)) {
      const buf = zlib.gunzipSync(fs.readFileSync(reqAbs))
      request_body = JSON.parse(buf.toString('utf8')) as AnthropicRequestBody
    }
  } catch { /* leave null */ }

  let response_body: unknown = null
  let response_text: string | null = null
  if (row.response_body_path) {
    try {
      const resAbs = path.join(PAYLOADS_DIR, row.response_body_path)
      if (fs.existsSync(resAbs)) {
        const buf = zlib.gunzipSync(fs.readFileSync(resAbs))
        response_text = buf.toString('utf8')
        if (!summary.is_streaming) {
          try {
            response_body = JSON.parse(response_text)
          } catch {
            // keep raw text
          }
        }
      }
    } catch { /* leave null */ }
  }

  return { summary, request_body, response_body, response_text }
}

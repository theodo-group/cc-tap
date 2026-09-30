/* Turns a baseline run (wire traffic, no cc-tap) and a cc-tap run (what cc-tap
 * stored) into comparable attempt lists, normalizes the few fields that differ
 * between ANY two runs of Claude Code, and diffs the rest field by field.
 */
import { assembleSseMessage } from '@/lib/sse'
import type { RunResult } from './run-claude'

type Json = Record<string, unknown>

// ─── volatile fields: the ONLY normalization applied ─────────────────────────
//
// Each of these differs between two runs of Claude Code even with cc-tap out
// of the picture, or is a documented, lossless re-encoding by the capture path.
// Anything not listed here must be byte-for-byte equal (after JSON parsing).
export const VOLATILE_FIELDS = [
  {
    field: 'system[0] billing header `cch=`',
    why: 'per-request integrity hash of the body; the OTel export always writes cch=00000',
  },
  {
    field: 'system[0] billing header `cc_prompt_id=`',
    why: 'a fresh UUID per user prompt, so per run',
  },
  {
    field: 'system[0] billing header `cc_prev_req=`',
    why: 'the request-id the fake API returned for the previous response; its sequence number depends on how many other calls (settings, policy limits) the run made',
  },
  {
    field: 'metadata.user_id `device_id` and `session_id`',
    why: 'device id is generated per HOME and session id per run; each run gets its own HOME',
  },
  {
    field: 'the run\'s HOME path, anywhere in the body',
    why: 'each run has its own HOME (e.g. the memory directory path in the system prompt); the working directory is shared',
  },
  {
    field: 'betas: `anthropic-beta` header vs `betas` body field, compared as a set',
    why: 'the SDK sends betas as a header; the OTel export logs them as a body field (proxy mode stores no headers, so its betas are read from the header it forwarded to the fake API)',
  },
  {
    field: 'response: fields the SDK fills with defaults (see SDK_DEFAULT_RESPONSE_FIELDS)',
    why: 'the OTel export logs the SDK\'s final message object, which adds null/zero defaults for fields the (fake) API did not send; only allowed when the wire response lacks the field',
  },
  {
    field: 'failed attempts: status only',
    why: 'the OTel export has no body for a failed attempt; cc-tap records its status and error from the session JSONL',
  },
] as const

/** Response keys (dotted) the SDK adds with default values when the API omits them. */
export const SDK_DEFAULT_RESPONSE_FIELDS = new Set([
  'stop_details',
  'usage.output_tokens_details', 'usage.server_tool_use', 'usage.service_tier', 'usage.cache_creation',
  'usage.inference_geo', 'usage.iterations', 'usage.speed', 'usage.fallback_credit',
])

const BILLING_VOLATILE = /\b(cch|cc_prompt_id|cc_prev_req)=[^;\s]*/g

function normalizeRequest(body: Json, home: string): Json {
  const text = home ? JSON.stringify(body).split(home).join('<HOME>') : JSON.stringify(body)
  const out = JSON.parse(text) as Json
  if (Array.isArray(out.system)) {
    out.system = out.system.map(b => {
      const block = b as Json
      return typeof block?.text === 'string' && block.text.includes('x-anthropic-billing-header')
        ? { ...block, text: block.text.replace(BILLING_VOLATILE, (_m, k) => `${k}=<volatile>`) }
        : block
    })
  }
  const meta = out.metadata as Json | undefined
  if (meta && typeof meta.user_id === 'string') {
    try {
      const u = JSON.parse(meta.user_id) as Json
      for (const k of ['device_id', 'session_id']) if (k in u) u[k] = `<${k}>`
      out.metadata = { ...meta, user_id: u }
    } catch { /* compared as is */ }
  }
  return out
}

// ─── attempts ────────────────────────────────────────────────────────────────

export interface Attempt {
  status: number | null
  betas: string[] | null
  request: Json
  response: Json | null
}

const splitBetas = (h: unknown) => (typeof h === 'string' ? h.split(',').map(s => s.trim()).filter(Boolean) : null)

function responseMessage(status: number | null, raw: string | null): Json | null {
  if (status !== 200 || !raw) return null
  try {
    return raw.trimStart().startsWith('{') ? JSON.parse(raw) : assembleSseMessage(raw)
  } catch {
    return { unparseable: raw.slice(0, 200) }
  }
}

export function attemptsFromWire(run: RunResult): Attempt[] {
  return run.wire.map(c => {
    const body = { ...(c.body ?? {}) }
    let betas = splitBetas(c.headers['anthropic-beta'])
    if (Array.isArray(body.betas)) { betas = body.betas as string[]; delete body.betas }
    return { status: c.response.status, betas, request: normalizeRequest(body, run.home), response: responseMessage(c.response.status, c.response.body) }
  })
}

export function attemptsFromCaptures(run: RunResult): Attempt[] {
  return run.captures.map(c => {
    const body = { ...(c.request ?? {}) }
    let betas: string[] | null = null
    if (Array.isArray(body.betas)) {
      betas = body.betas as string[]
      delete body.betas
    } else if (c.row.source !== 'otel') {
      // The proxy forwards the body untouched but stores no headers: read the header it forwarded.
      const text = JSON.stringify(c.request)
      const forwarded = run.wire.find(w => JSON.stringify(w.body) === text)
      betas = splitBetas(forwarded?.headers['anthropic-beta'])
    }
    const status = typeof c.row.status_code === 'number' ? c.row.status_code : null
    return { status, betas, request: normalizeRequest(body, run.home), response: responseMessage(status, c.response) }
  })
}

// ─── diff ────────────────────────────────────────────────────────────────────

/** What the suite asserts, one test per category. */
export const CATEGORIES = [
  'attempts', 'model', 'system', 'tools', 'messages', 'betas',
  'max_tokens', 'thinking', 'output_config', 'context_management',
  'other request fields', 'response',
] as const
export type Category = (typeof CATEGORIES)[number]

export interface Diff {
  category: Category
  path: string
  baseline: unknown
  capture: unknown
  attempts: number[]
}

const REQUEST_KEY_CATEGORIES = new Set<string>(['model', 'system', 'tools', 'messages', 'max_tokens', 'thinking', 'output_config', 'context_management'])
const categoryOf = (key: string): Category => (REQUEST_KEY_CATEGORIES.has(key) ? (key as Category) : 'other request fields')

const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Json)[k])]))
  return v
}

function walk(a: unknown, b: unknown, path: string, out: { path: string; baseline: unknown; capture: unknown }[], allowExtra?: (p: string) => boolean) {
  if (same(a, b)) return
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)
  if (!bothObjects) { out.push({ path, baseline: a, capture: b }); return }
  if (Array.isArray(a) && Array.isArray(b) && path.endsWith('.tools')) {
    // Tools by name, so one missing tool doesn't cascade into every later index.
    const names = (x: unknown[]) => x.map(t => (t as Json)?.name)
    if (!same(names(a), names(b))) out.push({ path: `${path} (names, in order)`, baseline: names(a), capture: names(b) })
    const byName = new Map(b.map(t => [(t as Json)?.name, t]))
    for (const t of a) {
      const other = byName.get((t as Json)?.name)
      if (other !== undefined) walk(t, other, `${path}[${String((t as Json)?.name)}]`, out)
    }
    return
  }
  const keys = new Set([...Object.keys(a as Json), ...Object.keys(b as Json)])
  for (const k of keys) {
    const p = Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`
    const av = (a as Json)[k]
    const bv = (b as Json)[k]
    if (av === undefined && allowExtra?.(p)) continue
    walk(av, bv, p, out, allowExtra)
  }
}

export function diffAttempts(baseline: Attempt[], capture: Attempt[]): Diff[] {
  const merged = new Map<string, Diff>()
  const add = (category: Category, path: string, b: unknown, c: unknown, attempt: number) => {
    const key = `${category}\0${path}\0${JSON.stringify(b)}\0${JSON.stringify(c)}`
    const d = merged.get(key)
    if (d) d.attempts.push(attempt)
    else merged.set(key, { category, path, baseline: b, capture: c, attempts: [attempt] })
  }

  const statuses = (x: Attempt[]) => x.map(a => a.status)
  if (!same(statuses(baseline), statuses(capture))) add('attempts', 'status of each /v1/messages attempt', statuses(baseline), statuses(capture), -1)

  for (let i = 0; i < Math.min(baseline.length, capture.length); i++) {
    const b = baseline[i]
    const c = capture[i]
    const bs = [...(b.betas ?? [])].sort()
    const cs = [...(c.betas ?? [])].sort()
    if (b.betas === null || c.betas === null || !same(bs, cs)) {
      add('betas', 'betas (only in baseline / only in capture)', bs.filter(x => !cs.includes(x)), c.betas === null ? '(none recorded)' : cs.filter(x => !bs.includes(x)), i)
    }
    for (const key of new Set([...Object.keys(b.request), ...Object.keys(c.request)])) {
      const out: { path: string; baseline: unknown; capture: unknown }[] = []
      walk(b.request[key], c.request[key], `request.${key}`, out)
      for (const d of out) add(categoryOf(key), d.path, d.baseline, d.capture, i)
    }
    if (b.response || c.response) {
      const out: { path: string; baseline: unknown; capture: unknown }[] = []
      walk(b.response, c.response, 'response', out, p => SDK_DEFAULT_RESPONSE_FIELDS.has(p.replace(/^response\./, '')))
      for (const d of out) add('response', d.path, d.baseline, d.capture, i)
    }
  }
  const order = (c: Category) => CATEGORIES.indexOf(c)
  return [...merged.values()].sort((x, y) => order(x.category) - order(y.category))
}

// ─── report ──────────────────────────────────────────────────────────────────

const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s)

function showValue(v: unknown): string {
  return v === undefined ? '(absent)' : clip(JSON.stringify(v))
}

/** Changed lines of `a` → `b` in order (longest common subsequence), unchanged lines dropped. */
function changedLines(a: string[], b: string[]): string[] {
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++ }
    else if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) out.push(`-${a[i++]}`)
    else out.push(`+${b[j++]}`)
  }
  return out
}

/** Lines of a value for a line diff: text split on newlines, a list of strings one item per line. */
function asLines(v: unknown): string[] | null {
  if (typeof v === 'string' && v.includes('\n')) return v.split('\n')
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v as string[]
  return null
}

/** The diffs as the body of a ```diff block: `-` baseline, `+` capture, one `#` header per field. */
export function formatGitDiff(diffs: Diff[]): string {
  const lines: string[] = []
  for (const d of diffs) {
    const where = d.attempts[0] === -1 ? '' : ` [attempt ${d.attempts.join(', ')}]`
    if (lines.length) lines.push('')
    lines.push(` # ${d.category}: ${d.path}${where}`)
    const a = d.baseline === undefined ? [] : asLines(d.baseline)
    const b = d.capture === undefined ? [] : asLines(d.capture)
    if (a && b && (a.length || b.length)) {
      // Betas arrive as "only in baseline" / "only in capture", so every line is a change.
      const changed = changedLines(a, b).map(l => clip(l, 200))
      const minus = changed.filter(l => l.startsWith('-'))
      const plus = changed.filter(l => l.startsWith('+'))
      lines.push(...minus.slice(0, 12), ...(minus.length > 12 ? [`-… ${minus.length - 12} more lines`] : []))
      lines.push(...plus.slice(0, 12), ...(plus.length > 12 ? [`+… ${plus.length - 12} more lines`] : []))
    } else {
      lines.push(`-${showValue(d.baseline)}`, `+${showValue(d.capture)}`)
    }
  }
  return lines.join('\n')
}

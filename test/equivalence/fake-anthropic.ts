/* A fake Anthropic API for the equivalence suite.
 *
 * - `http://127.0.0.1:<httpPort>`: plain HTTP, the upstream of cc-tap's proxy mode.
 * - `https://127.0.0.1:<tlsPort>`: TLS with a certificate for api.anthropic.com,
 *   signed by a throwaway CA generated at runtime (nothing private is committed).
 * - `http://127.0.0.1:<mitmPort>`: an HTTPS CONNECT proxy that routes
 *   api.anthropic.com to the TLS server. With HTTPS_PROXY + NODE_EXTRA_CA_CERTS,
 *   Claude Code keeps its default base URL and believes it talks to
 *   api.anthropic.com: that is the "without cc-tap" baseline.
 *
 * Every request is recorded (headers, decoded body, exact response sent).
 * /v1/messages follows a fixed script, keyed on the conversation rather than
 * on a call counter so that extra calls (e.g. auto-mode classifier calls behind
 * a proxy) don't shift it:
 *   main-loop call #1 → 429, #2 → 529, then thinking + tool_use(Bash "echo hi");
 *   the call carrying that tool_result → final text; any other call → short text.
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'

export const TOOL_USE_ID = 'toolu_equiv_bash_1'
export const THINKING_TEXT = 'EQUIVALENCE-THINKING: the user wants echo hi, run it with Bash.'
export const THINKING_SIGNATURE = 'c2lnbmF0dXJlLWVxdWl2YWxlbmNl'
export const FINAL_TEXT = 'Done: it printed hi.'

type Json = Record<string, unknown>

export interface WireResponse {
  status: number
  contentType: string
  headers: Record<string, string>
  body: string
}

export interface WireCall {
  seq: number
  at: number
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Json | null
  /** How the script classified the call. */
  kind: 'main' | 'final' | 'aux' | 'other'
  response: WireResponse
}

export interface FakeAnthropic {
  httpUrl: string
  mitmUrl: string
  caPath: string
  calls: WireCall[]
  /** Forget recorded calls and restart the script (between runs). */
  reset(): void
  close(): Promise<void>
}

// ─── certificates ────────────────────────────────────────────────────────────

/** Generates a CA + an api.anthropic.com leaf into `dir` with the openssl CLI. */
export function createTestCa(dir: string): { caPath: string; keyPath: string; certPath: string } {
  fs.mkdirSync(dir, { recursive: true })
  const p = (f: string) => path.join(dir, f)
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', p('ca.key'), '-out', p('ca.pem'),
    '-subj', '/CN=cc-tap equivalence test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', p('srv.key'), '-out', p('srv.csr'), '-subj', '/CN=api.anthropic.com'])
  fs.writeFileSync(p('srv.ext'), 'subjectAltName=DNS:api.anthropic.com\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n')
  run(['x509', '-req', '-in', p('srv.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial',
    '-days', '2', '-out', p('srv.pem'), '-extfile', p('srv.ext')])
  return { caPath: p('ca.pem'), keyPath: p('srv.key'), certPath: p('srv.pem') }
}

// ─── scripted responses ──────────────────────────────────────────────────────

const sse = (events: [string, Json][]) =>
  events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('')

function messageStart(id: string, model: string, usage: Json): [string, Json] {
  return ['message_start', {
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  }]
}

function textReply(id: string, model: string, text: string): WireResponse {
  return {
    status: 200, contentType: 'text/event-stream', headers: {},
    body: sse([
      messageStart(id, model, { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }),
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['ping', {}],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }],
      ['message_stop', {}],
    ]),
  }
}

function toolReply(id: string, model: string): WireResponse {
  return {
    status: 200, contentType: 'text/event-stream', headers: {},
    body: sse([
      messageStart(id, model, { input_tokens: 240, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 }),
      ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: THINKING_TEXT } }],
      ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: THINKING_SIGNATURE } }],
      ['content_block_stop', { index: 0 }],
      ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: TOOL_USE_ID, name: 'Bash', input: {} } }],
      ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo hi', description: 'Print hi' }) } }],
      ['content_block_stop', { index: 1 }],
      ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } }],
      ['message_stop', {}],
    ]),
  }
}

function errorReply(status: number, type: string): WireResponse {
  return {
    status, contentType: 'application/json',
    // retry-after: 0 keeps Claude Code's retry fast (it honours the header).
    headers: { 'retry-after': '0', 'x-should-retry': 'true' },
    body: JSON.stringify({ type: 'error', error: { type, message: `fake ${type}` } }),
  }
}

const hasBashTool = (b: Json) => Array.isArray(b.tools) && b.tools.some(t => (t as Json)?.name === 'Bash')
const answersTool = (b: Json) => JSON.stringify(b.messages ?? []).includes(`"tool_use_id":"${TOOL_USE_ID}"`)

// ─── server ──────────────────────────────────────────────────────────────────

const listen = (server: net.Server) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

export async function startFakeAnthropic({ certDir }: { certDir: string }): Promise<FakeAnthropic> {
  const { caPath, keyPath, certPath } = createTestCa(certDir)
  const calls: WireCall[] = []
  let seq = 0
  let mainAttempts = 0

  function script(method: string, url: string, body: Json | null): { kind: WireCall['kind']; response: WireResponse } {
    if (!(method === 'POST' && url.startsWith('/v1/messages') && !url.includes('count_tokens') && body && Array.isArray(body.messages))) {
      return { kind: 'other', response: { status: 200, contentType: 'application/json', headers: {}, body: '{}' } }
    }
    const model = typeof body.model === 'string' ? body.model : 'claude-test'
    if (answersTool(body)) return { kind: 'final', response: textReply('msg_equiv_final', model, FINAL_TEXT) }
    if (!hasBashTool(body)) return { kind: 'aux', response: textReply(`msg_equiv_aux_${seq}`, model, 'ok') }
    mainAttempts++
    if (mainAttempts === 1) return { kind: 'main', response: errorReply(429, 'rate_limit_error') }
    if (mainAttempts === 2) return { kind: 'main', response: errorReply(529, 'overloaded_error') }
    return { kind: 'main', response: toolReply('msg_equiv_tool', model) }
  }

  function handler(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      let raw = Buffer.concat(chunks)
      const enc = req.headers['content-encoding']
      try {
        if (enc === 'gzip') raw = zlib.gunzipSync(raw)
        else if (enc === 'br') raw = zlib.brotliDecompressSync(raw)
        else if (enc === 'deflate') raw = zlib.inflateSync(raw)
      } catch { /* keep as is */ }
      let body: Json | null = null
      try { body = JSON.parse(raw.toString('utf8')) } catch { /* not JSON */ }
      const n = ++seq
      const { kind, response } = script(req.method ?? 'GET', req.url ?? '/', body)
      calls.push({ seq: n, at: Date.now(), method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body, kind, response })
      res.writeHead(response.status, {
        'content-type': response.contentType,
        'request-id': `req_equiv_${String(n).padStart(3, '0')}`,
        ...response.headers,
      })
      res.end(response.body)
    })
  }

  const httpServer = http.createServer(handler)
  const tlsServer = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler)
  const sockets = new Set<net.Socket>()
  const mitm = http.createServer((_req, res) => { res.writeHead(502); res.end() })
  const [httpPort, tlsPort] = [await listen(httpServer), await listen(tlsServer)]
  mitm.on('connect', (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    if ((req.url ?? '').split(':')[0] !== 'api.anthropic.com') {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const up = net.connect(tlsPort, '127.0.0.1', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      up.write(head)
      up.pipe(sock)
      sock.pipe(up)
    })
    sockets.add(up)
    up.on('close', () => sockets.delete(up))
    up.on('error', () => sock.destroy())
    sock.on('error', () => up.destroy())
  })
  const mitmPort = await listen(mitm)

  const close = (s: http.Server) => new Promise<void>(resolve => { s.closeAllConnections?.(); s.close(() => resolve()) })
  return {
    httpUrl: `http://127.0.0.1:${httpPort}`,
    mitmUrl: `http://127.0.0.1:${mitmPort}`,
    caPath,
    calls,
    reset() {
      calls.length = 0
      mainAttempts = 0
    },
    async close() {
      for (const s of sockets) s.destroy()
      await Promise.all([close(httpServer), close(tlsServer), close(mitm)])
    },
  }
}

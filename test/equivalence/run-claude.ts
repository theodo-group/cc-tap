/* Runs the real Claude Code CLI once against the fake Anthropic API, in one of
 * the ways cc-tap can be set up (or without cc-tap), and returns both what
 * reached the wire and what cc-tap stored.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import type { FakeAnthropic, WireCall } from './fake-anthropic'

// Clean environments: only what is listed here reaches the child.
type Env = Record<string, string | undefined>
const REPO = path.resolve(__dirname, '..', '..')
export const PROMPT = 'Run the shell command echo hi with the Bash tool, then say what it printed.'

/**
 * - baseline:  no cc-tap. Default base URL; traffic reaches the fake only through HTTPS_PROXY.
 * - otel:      cc-tap's default capture: OTEL_LOG_RAW_API_BODIES=file:<dir> + the ingester.
 * - proxy:     reverse proxy, the pre-#20 command (ANTHROPIC_BASE_URL only).
 * - proxy-env: reverse proxy with the env cc-tap suggests today (ENABLE_TOOL_SEARCH=true too).
 */
export type Mode = 'baseline' | 'otel' | 'proxy' | 'proxy-env'

/** How each mode runs Claude Code, for the report (on top of the shared clean environment). */
export const MODE_SETUP: Record<Mode, string> = {
  baseline: '`claude` with its default base URL (reaches the fake API through HTTPS_PROXY + NODE_EXTRA_CA_CERTS)',
  otel: '`OTEL_LOG_RAW_API_BODIES=file:<dir> claude` + `proxy/otel-ingest.js`',
  proxy: '`ANTHROPIC_BASE_URL=http://localhost:<port> claude` + `proxy/server.js`',
  'proxy-env': '`ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://localhost:<port> claude` + `proxy/server.js`',
}

export interface StoredCapture {
  row: Record<string, unknown>
  request: Record<string, unknown> | null
  response: string | null
}

export interface RunResult {
  mode: Mode
  /** This run's HOME (holds ~/.claude and ~/.cc-lens). */
  home: string
  exitCode: number | null
  stdout: string
  stderr: string
  serviceLog: string
  /** /v1/messages calls the fake API received during this run. */
  wire: WireCall[]
  /** /v1/messages rows cc-tap stored (empty for the baseline), oldest first. */
  captures: StoredCapture[]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const isMessagesPath = (p: string) => p.startsWith('/v1/messages') && !p.includes('count_tokens')

async function freePort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as net.AddressInfo).port
  await new Promise<void>(r => srv.close(() => r()))
  return port
}

interface Service { child: ChildProcess; log: () => string }

function startService(script: string, env: Env): Service {
  let log = ''
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'proxy', script)], {
    env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', d => { log += d })
  child.stderr!.on('data', d => { log += d })
  return { child, log: () => log }
}

async function stopProcess(child: ChildProcess, group = false) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(r => child.once('exit', () => r()))
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (group && child.pid) process.kill(-child.pid, sig)
      else child.kill(sig)
    } catch { /* already gone */ }
  }
  kill('SIGTERM')
  const done = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])
  if (!done) { kill('SIGKILL'); await exited }
}

async function waitFor(what: string, cond: () => boolean, timeoutMs: number, log: () => string) {
  const until = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}\n--- service log ---\n${log()}`)
    await sleep(250)
  }
}

function readCaptures(lensRoot: string): StoredCapture[] {
  const dbPath = path.join(lensRoot, 'inspector.db')
  if (!fs.existsSync(dbPath)) return []
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(`SELECT * FROM captures ORDER BY timestamp, rowid`).all() as Record<string, unknown>[]
    const payload = (rel: unknown) => {
      if (typeof rel !== 'string') return null
      try { return zlib.gunzipSync(fs.readFileSync(path.join(lensRoot, 'payloads', rel))).toString('utf8') } catch { return null }
    }
    return rows
      .filter(r => isMessagesPath(String(r.path)))
      .map(row => {
        const req = payload(row.request_body_path)
        let request: Record<string, unknown> | null = null
        try { request = req ? JSON.parse(req) : null } catch { /* kept null */ }
        return { row, request, response: payload(row.response_body_path) }
      })
  } finally {
    db.close()
  }
}

export interface RunOptions {
  fake: FakeAnthropic
  /** Shared by every run, so the system prompt's working directory is identical. */
  workDir: string
  /** Per-run scratch dir: HOME (and so ~/.claude and ~/.cc-lens) lives here. */
  runDir: string
  claudeBin?: string
  timeoutMs?: number
}

export async function runClaude(mode: Mode, { fake, workDir, runDir, claudeBin = 'claude', timeoutMs = 180_000 }: RunOptions): Promise<RunResult> {
  const home = path.join(runDir, 'home')
  const lensRoot = path.join(home, '.cc-lens')
  fs.mkdirSync(home, { recursive: true })
  fake.reset()

  // The same clean environment for every mode; only the cc-tap specific variables differ.
  const base: Env = {
    HOME: home,
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    ANTHROPIC_API_KEY: 'sk-ant-test-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NODE_EXTRA_CA_CERTS: fake.caPath,
    HTTPS_PROXY: fake.mitmUrl,
    NO_PROXY: '127.0.0.1,localhost',
  }
  const serviceEnv: Env = { HOME: home, PATH: process.env.PATH }

  let service: Service | null = null
  const extra: Env = {}
  if (mode === 'otel') {
    const bodiesDir = path.join(lensRoot, 'otel-bodies')
    service = startService('otel-ingest.js', { ...serviceEnv, CC_LENS_OTEL_BODIES_DIR: bodiesDir })
    extra.OTEL_LOG_RAW_API_BODIES = `file:${bodiesDir}`
  } else if (mode === 'proxy' || mode === 'proxy-env') {
    const port = await freePort()
    service = startService('server.js', { ...serviceEnv, CC_LENS_PROXY_PORT: String(port), CC_LENS_UPSTREAM: fake.httpUrl })
    const s = service
    await waitFor('the proxy to listen', () => s.log().includes('listening on'), 15_000, s.log)
    extra.ANTHROPIC_BASE_URL = `http://localhost:${port}`
    if (mode === 'proxy-env') extra.ENABLE_TOOL_SEARCH = 'true'
  }

  let stdout = ''
  let stderr = ''
  let exitCode: number | null = null
  try {
    if (service) {
      const s = service
      await sleep(300)
      if (s.child.exitCode !== null) throw new Error(`cc-tap ${mode} service exited early:\n${s.log()}`)
    }
    const child = spawn(claudeBin, ['-p', PROMPT, '--allowedTools', 'Bash'], {
      cwd: workDir, env: { ...base, ...extra } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    child.stdout!.on('data', d => { stdout += d })
    child.stderr!.on('data', d => { stderr += d })
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('exit', code => resolve(code))
      child.once('error', reject)
    })
    const timer = setTimeout(() => { stderr += `\n[equivalence] killed after ${timeoutMs} ms\n`; void stopProcess(child, true) }, timeoutMs)
    try {
      exitCode = await exited
    } finally {
      clearTimeout(timer)
      await stopProcess(child, true) // stray tool subprocesses
    }

    const wireCount = () => fake.calls.filter(c => isMessagesPath(c.url)).length
    if (service) {
      const s = service
      // Every /v1/messages attempt the fake saw must end up stored, failures with their status.
      await waitFor(`${wireCount()} stored /v1/messages captures`, () => {
        const caps = readCaptures(lensRoot)
        return caps.length >= wireCount() && caps.every(c => c.row.status_code != null)
      }, 45_000, () => `${s.log()}\n--- claude stderr ---\n${stderr}`)
    }
  } finally {
    if (service) await stopProcess(service.child)
  }

  return {
    mode, home, exitCode, stdout, stderr,
    serviceLog: service?.log() ?? '',
    wire: fake.calls.filter(c => isMessagesPath(c.url)).map(c => structuredClone(c)),
    captures: readCaptures(lensRoot),
  }
}

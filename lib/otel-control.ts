import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { isAlive, resolveProxyScript } from './proxy-control'

// The ingester (proxy/otel-ingest.js) writes this file once it is running and
// removes it on exit; the dashboard only reads it.
const ROOT = path.join(os.homedir(), '.cc-lens')
const STATE_FILE = path.join(ROOT, 'otel-ingest.json')

export const DEFAULT_BODIES_DIR = path.join(ROOT, 'otel-bodies')

export interface OtelState {
  pid: number
  bodiesDir: string
  startedAt: number
}

export interface OtelStatus {
  running: boolean
  pid?: number
  startedAt?: number
  bodiesDir: string
  /** What to run Claude Code with so the ingester sees its calls. */
  command: string
}

/** `OTEL_LOG_RAW_API_BODIES=file:<dir> claude`, with $HOME in place of the home dir. */
export function otelCommand(bodiesDir: string, home = os.homedir()): string {
  const dir = bodiesDir === home || bodiesDir.startsWith(home + path.sep)
    ? '$HOME' + bodiesDir.slice(home.length)
    : bodiesDir
  return `OTEL_LOG_RAW_API_BODIES=file:${dir} claude`
}

function bodiesDirFromEnv(): string {
  return path.resolve(process.env.CC_LENS_OTEL_BODIES_DIR || DEFAULT_BODIES_DIR)
}

function readState(): OtelState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as OtelState
  } catch {
    return null
  }
}

function running(): OtelState | null {
  const s = readState()
  if (!s) return null
  if (!isAlive(s.pid)) {
    // Killed without its shutdown handler running.
    try { fs.unlinkSync(STATE_FILE) } catch { /* fine */ }
    return null
  }
  return s
}

export function getOtelStatus(): OtelStatus {
  const s = running()
  const bodiesDir = s?.bodiesDir ?? bodiesDirFromEnv()
  const base = { bodiesDir, command: otelCommand(bodiesDir) }
  return s ? { running: true, pid: s.pid, startedAt: s.startedAt, ...base } : { running: false, ...base }
}

/**
 * Spawns the ingester as a detached child. Idempotent: if already running,
 * returns the existing state without respawning.
 */
export async function startOtelIngest(): Promise<OtelState> {
  const existing = running()
  if (existing) return existing

  const script = resolveProxyScript('otel-ingest.js')
  if (!script) {
    throw new Error('proxy/otel-ingest.js not found in cwd or ~/.cc-lens/')
  }

  // --disable-warning=ExperimentalWarning: see startProxy.
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CC_LENS_OTEL_BODIES_DIR: bodiesDirFromEnv() },
  })
  child.unref()
  if (!child.pid) {
    throw new Error('failed to spawn the OTel ingester (no PID)')
  }

  // Ready once it has written its state file (at most ~3s).
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const s = readState()
    if (s?.pid === child.pid) return s
    if (!isAlive(child.pid)) break
    await new Promise(r => setTimeout(r, 75))
  }
  try { process.kill(child.pid, 'SIGTERM') } catch { /* */ }
  throw new Error(`OTel ingester spawned (pid=${child.pid}) but did not start within 3s`)
}

export function stopOtelIngest(): { stopped: boolean; pid?: number } {
  const s = readState()
  if (!s) return { stopped: false }
  try {
    process.kill(s.pid, 'SIGTERM')
  } catch {
    // Already dead — fall through to clear state
  }
  try { fs.unlinkSync(STATE_FILE) } catch { /* the ingester removed it */ }
  return { stopped: true, pid: s.pid }
}

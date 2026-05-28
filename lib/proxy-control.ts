import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'

const ROOT = path.join(os.homedir(), '.cc-lens')
const PID_FILE = path.join(ROOT, 'proxy.json')

export interface ProxyState {
  pid: number
  port: number
  startedAt: number
}

export interface ProxyStatus {
  running: boolean
  pid?: number
  port?: number
  startedAt?: number
}

// ─── port discovery ──────────────────────────────────────────────────────────

export function findFreePort(start = 8089): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      const server = net.createServer()
      server.unref()
      server.on('error', () => {
        if (p < start + 100) tryPort(p + 1)
        else reject(new Error(`no free port near ${start}`))
      })
      server.listen(p, '127.0.0.1', () => {
        server.close(() => resolve(p))
      })
    }
    tryPort(start)
  })
}

// ─── PID file ────────────────────────────────────────────────────────────────

function readState(): ProxyState | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) as ProxyState
  } catch {
    return null
  }
}

function writeState(s: ProxyState): void {
  fs.mkdirSync(ROOT, { recursive: true })
  fs.writeFileSync(PID_FILE, JSON.stringify(s, null, 2))
}

function clearState(): void {
  try { fs.unlinkSync(PID_FILE) } catch { /* fine */ }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    // EPERM means process exists but we can't signal it — still alive
    return err.code === 'EPERM'
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Returns the current proxy state, reconciling stale PID files.
 * If the PID file points to a dead process, it's deleted and we report not-running.
 */
export function getStatus(): ProxyStatus {
  const s = readState()
  if (!s) return { running: false }
  if (!isAlive(s.pid)) {
    clearState()
    return { running: false }
  }
  return { running: true, pid: s.pid, port: s.port, startedAt: s.startedAt }
}

/**
 * Spawns the proxy as a detached child. Idempotent: if already running,
 * returns the existing state without respawning.
 */
export async function startProxy(): Promise<ProxyState> {
  const existing = getStatus()
  if (existing.running) {
    return { pid: existing.pid!, port: existing.port!, startedAt: existing.startedAt! }
  }

  const port = await findFreePort(8089)
  const script = resolveProxyScript()
  if (!script) {
    throw new Error('proxy/server.js not found in cwd or ~/.cc-lens/')
  }

  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CC_LENS_PROXY_PORT: String(port) },
  })
  child.unref()

  if (!child.pid) {
    throw new Error('failed to spawn proxy (no PID)')
  }

  // Wait briefly for the proxy to bind to the port (at most ~2s).
  const ok = await waitForListen(port, 2000)
  if (!ok) {
    try { process.kill(child.pid, 'SIGTERM') } catch { /* */ }
    throw new Error(`proxy spawned (pid=${child.pid}) but did not bind to :${port} within 2s`)
  }

  const state: ProxyState = { pid: child.pid, port, startedAt: Date.now() }
  writeState(state)
  return state
}

export function stopProxy(): { stopped: boolean; pid?: number } {
  const s = readState()
  if (!s) return { stopped: false }
  try {
    process.kill(s.pid, 'SIGTERM')
  } catch {
    // Already dead — fall through to clear state
  }
  clearState()
  return { stopped: true, pid: s.pid }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function resolveProxyScript(): string | null {
  // 1. cwd-relative (works for both `npm run dev` and `npx cc-tap` since
  //    bin/cli.js cd's into CACHE_DIR before spawning Next.)
  const cwdPath = path.join(process.cwd(), 'proxy', 'server.js')
  if (fs.existsSync(cwdPath)) return cwdPath
  // 2. CACHE_DIR fallback (defensive — covers the case where Next is started
  //    from elsewhere by an end user.)
  const cachePath = path.join(ROOT, 'proxy', 'server.js')
  if (fs.existsSync(cachePath)) return cachePath
  return null
}

function waitForListen(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise(resolve => {
    const tryConnect = () => {
      const sock = net.createConnection(port, '127.0.0.1')
      sock.once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() >= deadline) resolve(false)
        else setTimeout(tryConnect, 75)
      })
    }
    tryConnect()
  })
}

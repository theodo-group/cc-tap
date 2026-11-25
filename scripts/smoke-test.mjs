#!/usr/bin/env node
// Installs a packed cc-tap tarball in an empty directory, starts it in demo
// mode and checks that the dashboard and its API answer. This catches a bundle
// that builds but does not run once installed, as 0.7.0 did.
//
// Usage: node scripts/smoke-test.mjs <path-to-tarball>

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tarball = process.argv[2] && path.resolve(process.argv[2])
if (!tarball || !fs.existsSync(tarball)) {
  console.error('Usage: node scripts/smoke-test.mjs <path-to-tarball>')
  process.exit(2)
}

const PORT = Number(process.env.SMOKE_PORT) || 4319
const TIMEOUT_MS = 60_000
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tap-smoke-'))
const home = path.join(work, 'home')
const stubs = path.join(work, 'stubs')
fs.mkdirSync(home)
fs.mkdirSync(stubs)

// The CLI opens a browser once the server is up. Shadow the openers so the
// test opens nothing, on a laptop or in CI.
for (const name of ['open', 'xdg-open']) {
  fs.writeFileSync(path.join(stubs, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}

const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--silent', tarball], {
  cwd: work, stdio: 'inherit', shell: process.platform === 'win32',
})
if (install.status !== 0) fail('npm install of the tarball failed')

const cli = path.join(work, 'node_modules', 'cc-tap', 'bin', 'cli.js')
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PATH: `${stubs}${path.delimiter}${process.env.PATH}`,
}
delete env.CLAUDE_CONFIG_DIR
delete env.CC_TAP_BASE_PATH

let output = ''
const child = spawn(process.execPath, [cli, '--demo', '--port', String(PORT)], {
  cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => { output += d })
child.stderr.on('data', (d) => { output += d })
child.on('exit', (code) => { if (!done) fail(`cc-tap exited early with code ${code}`) })

let done = false
const base = `http://127.0.0.1:${PORT}`

async function get(route) {
  const res = await fetch(base + route, { signal: AbortSignal.timeout(10_000) })
  return { status: res.status, body: await res.text() }
}

async function waitForServer() {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    try { if ((await get('/')).status === 200) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  fail(`no answer on ${base} after ${TIMEOUT_MS / 1000}s`)
}

function finish(code) {
  done = true
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  process.exit(code)
}

function fail(message) {
  console.error(`smoke test failed: ${message}`)
  if (output) console.error(`--- cc-tap output ---\n${output.slice(-4000)}`)
  finish(1)
}

await waitForServer()

const page = await get('/')
if (!/<html/i.test(page.body)) fail('/ did not return an HTML page')

const sessions = await get('/api/sessions')
if (sessions.status !== 200) fail(`/api/sessions returned ${sessions.status}`)
let count
try {
  const json = JSON.parse(sessions.body)
  count = (Array.isArray(json) ? json : json.sessions)?.length
} catch { fail('/api/sessions did not return JSON') }
if (!count) fail('/api/sessions returned no demo session')

console.log(`smoke test passed: dashboard up on ${base}, ${count} demo sessions served`)
finish(0)

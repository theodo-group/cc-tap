#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

// Copies .next/static, public/, and proxy/ into .next/standalone/ so that
// `node .next/standalone/server.js` can serve a fully self-contained app.
// Next emits .next/static and public alongside .next/standalone but does not
// copy them in. The inspector proxy (proxy/server.js + schema.sql) is spawned
// as a separate process from the standalone dir, so it must be copied in too —
// Next's output tracing does not reliably include it (and never its schema.sql).

const fs   = require('fs')
const path = require('path')

const root         = path.join(__dirname, '..')
const standaloneDir = path.join(root, '.next', 'standalone')
const staticSrc    = path.join(root, '.next', 'static')
const staticDst    = path.join(standaloneDir, '.next', 'static')
const publicSrc    = path.join(root, 'public')
const publicDst    = path.join(standaloneDir, 'public')
const proxySrc     = path.join(root, 'proxy')
const proxyDst     = path.join(standaloneDir, 'proxy')

if (!fs.existsSync(standaloneDir)) {
  console.error(`[cc-tap] .next/standalone not found. Did \`next build\` run with output: 'standalone'?`)
  process.exit(1)
}

if (fs.existsSync(staticSrc)) {
  fs.cpSync(staticSrc, staticDst, { recursive: true, force: true })
}
if (fs.existsSync(publicSrc)) {
  fs.cpSync(publicSrc, publicDst, { recursive: true, force: true })
}
// Ship the full proxy dir (server.js + schema.sql). The proxy uses Node's
// built-in node:sqlite, so there's no native module to copy or resolve.
if (fs.existsSync(proxySrc)) {
  fs.cpSync(proxySrc, proxyDst, { recursive: true, force: true })
}

console.log('[cc-tap] standalone bundle prepared at .next/standalone')

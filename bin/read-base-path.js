/* eslint-disable @typescript-eslint/no-require-imports */

// The prefix the standalone build serves under (CC_TAP_BASE_PATH at build time), empty
// at the root. It is baked into the build, so the CLI reads it back from Next's manifest.
const fs   = require('fs')
const path = require('path')

function readBasePath(standaloneDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(standaloneDir, '.next', 'routes-manifest.json'), 'utf8'))
  return manifest.basePath ?? ''
}

module.exports = { readBasePath }

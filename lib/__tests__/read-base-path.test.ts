import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBasePath } from '../../bin/read-base-path.js'

describe('readBasePath (the prefix the CLI opens and calls)', () => {
  let dir = ''

  function standaloneWith(manifest: unknown) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tap-standalone-'))
    fs.mkdirSync(path.join(dir, '.next'))
    fs.writeFileSync(path.join(dir, '.next', 'routes-manifest.json'), JSON.stringify(manifest))
    return dir
  }

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('reads the prefix the build was made for', () => {
    expect(readBasePath(standaloneWith({ version: 3, basePath: '/relay/cc-tap' }))).toBe('/relay/cc-tap')
  })

  it('is empty for a build made for the root', () => {
    expect(readBasePath(standaloneWith({ version: 3, basePath: '' }))).toBe('')
  })
})

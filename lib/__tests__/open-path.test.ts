import { describe, expect, it } from 'vitest'
import { openPath } from '../../bin/open-path.js'

describe('openPath (cc-tap --open)', () => {
  it('keeps a plain app path, with or without a query', () => {
    expect(openPath('/sessions/5f1c7e2a-1111-4222-8333-944455556666')).toBe('/sessions/5f1c7e2a-1111-4222-8333-944455556666')
    expect(openPath('/sessions/abc?from=2026-09-25T08%3A00&to=x')).toBe('/sessions/abc?from=2026-09-25T08%3A00&to=x')
    expect(openPath('/')).toBe('/')
  })

  it('refuses anything that could reach the shell or leave the app', () => {
    for (const bad of ['sessions/x', '/x"; rm -rf ~', '/x`id`', '/x $(id)', '/x y', 'https://evil.test', '//evil.test', '/../etc', '/x\nls', true, undefined, 42]) {
      expect(openPath(bad as never)).toBe('')
    }
  })
})

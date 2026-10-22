import { afterEach, describe, expect, it, vi } from 'vitest'

async function fetchedUrl(basePath: string | undefined, path: string) {
  vi.resetModules()
  if (basePath !== undefined) vi.stubEnv('CC_TAP_BASE_PATH', basePath)
  const fetch = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const { apiFetch } = await import('../base-path')
  await apiFetch(path, { method: 'POST' })
  return fetch.mock.calls[0]
}

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('asks for the path as written when cc-tap is built for the root', async () => {
    expect(await fetchedUrl(undefined, '/api/sessions?from=1')).toEqual(['/api/sessions?from=1', { method: 'POST' }])
  })

  it('asks for the path under the prefix cc-tap is built for', async () => {
    expect(await fetchedUrl('/relay/cc-tap', '/api/sessions?from=1')).toEqual(['/relay/cc-tap/api/sessions?from=1', { method: 'POST' }])
  })
})

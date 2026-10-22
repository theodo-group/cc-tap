// The prefix cc-tap is built under (CC_TAP_BASE_PATH), empty at the root. Next adds it to
// its assets, links and router calls but not to a fetch, so every fetch goes through here.
const basePath = process.env.CC_TAP_BASE_PATH ?? ''

export function apiFetch(path: string, init?: RequestInit) {
  return fetch(`${basePath}${path}`, init)
}

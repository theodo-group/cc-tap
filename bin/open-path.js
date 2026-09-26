/* eslint-disable @typescript-eslint/no-require-imports */

// `--open <path>`: the page the browser lands on instead of the overview, e.g.
// `/sessions/<id>` for a tool that hands cc-tap one session to look at. The URL
// reaches a shell (open / start / xdg-open), so only a plain app path is taken:
// a leading slash, then letters, digits and `/ _ - . ~`, and an optional query of
// the same plus `= & %`. Anything else is refused and the overview opens.
const OPEN_PATH = /^\/[A-Za-z0-9/_\-.~]*(\?[A-Za-z0-9_\-.~=&%]*)?$/

function openPath(value) {
  return typeof value === 'string' && OPEN_PATH.test(value) && !value.startsWith('//') && !value.includes('..') ? value : ''
}

module.exports = { openPath }

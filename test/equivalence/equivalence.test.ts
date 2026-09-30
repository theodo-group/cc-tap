/* Equivalence suite: does what cc-tap captures equal what Claude Code sends to
 * Anthropic when cc-tap is not involved?
 *
 * Claude Code changes its requests when ANTHROPIC_BASE_URL points at a
 * non-Anthropic host (tool search off, auto-mode safeguards, other betas, a
 * truncated billing header). This suite runs the real `claude` CLI against a
 * fake Anthropic API (see fake-anthropic.ts), once without cc-tap (baseline:
 * default base URL, reached through an HTTPS_PROXY MITM) and once per capture
 * mode, and compares what cc-tap STORED (inspector.db + payloads) to the
 * baseline's wire traffic, with the same assertions and the same normalization
 * (compare.ts VOLATILE_FIELDS) for every mode.
 *
 * - otel must be equivalent: no difference at all.
 * - proxy / proxy-env are known not to be: KNOWN_DIFFERENCES lists, per mode,
 *   the categories that differ. They are asserted to differ, so CI stays green
 *   while the report shows exactly what differs, and the suite fails when
 *   Claude Code changes behavior in either direction.
 *
 * Run: npm run test:equivalence (needs `claude` on PATH and `openssl`; no network,
 * no API key). Opt-in, not part of `npm test`. Writes the proof report to
 * test-results/equivalence/equivalence-report.md (and prints it), next to each
 * run's raw wire traffic and captures (<mode>.run.json). $CC_TAP_EQUIVALENCE_OUT
 * overrides the directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { FINAL_TEXT, THINKING_SIGNATURE, THINKING_TEXT, TOOL_USE_ID, startFakeAnthropic, type FakeAnthropic } from './fake-anthropic'
import { runClaude, type Mode, type RunResult } from './run-claude'
import { CATEGORIES, attemptsFromCaptures, attemptsFromWire, diffAttempts, formatGitDiff, type Category, type Diff } from './compare'
import { buildReport, type ModeResult } from './report'

const CLAUDE = process.env.CLAUDE_BIN || 'claude'
const OUT = path.resolve(process.env.CC_TAP_EQUIVALENCE_OUT || path.join(__dirname, '..', '..', 'test-results', 'equivalence'))

/**
 * What differs from the baseline behind cc-tap's reverse proxy (observed with
 * Claude Code 2.1.285). A custom ANTHROPIC_BASE_URL makes Claude Code:
 * - system:   truncate the billing header (no cch, prompt id...), merge two system
 *             blocks and change their cache_control;
 * - tools:    change the Bash tool description; without ENABLE_TOOL_SEARCH=true it
 *             also turns tool search off (no ToolSearch, every tool loaded up front);
 * - messages: add auto-mode guidance (and, without tool search, drop the deferred
 *             tools list) in the injected context;
 * - betas:    send another anthropic-beta set (afk-mode, dangerous-tool-use...);
 * - other request fields: add `safeguards` (auto-mode classifier), drop `diagnostics`.
 * The README ("Proxy mode") and components/proxy/capture-controls.tsx carry the
 * user-facing caveat; keep them in line with this list.
 */
const KNOWN_DIFFERENCES: Record<Exclude<Mode, 'baseline'>, Category[]> = {
  otel: [],
  proxy: ['system', 'tools', 'messages', 'betas', 'other request fields'],
  'proxy-env': ['system', 'tools', 'messages', 'betas', 'other request fields'],
}

const MODES = Object.keys(KNOWN_DIFFERENCES) as Exclude<Mode, 'baseline'>[]

let fake: FakeAnthropic
let tmp: string
let workDir: string
let baseline: RunResult
let claudeVersion = ''
const results: ModeResult[] = []

function saveRun(run: RunResult) {
  fs.writeFileSync(path.join(OUT, `${run.mode}.run.json`), JSON.stringify(run, null, 1))
}

function describeRun(run: RunResult) {
  return `exit=${run.exitCode}\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr.slice(-4000)}\n--- cc-tap log ---\n${run.serviceLog.slice(-4000)}`
}

beforeAll(async () => {
  claudeVersion = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim()
  fs.mkdirSync(OUT, { recursive: true })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tap-equivalence-'))
  workDir = path.join(tmp, 'work')
  fs.mkdirSync(workDir)
  fake = await startFakeAnthropic({ certDir: path.join(tmp, 'certs') })
  baseline = await runClaude('baseline', { fake, workDir, runDir: path.join(tmp, 'baseline'), claudeBin: CLAUDE })
  saveRun(baseline)
})

afterAll(async () => {
  if (baseline && results.length) {
    const report = buildReport({ claudeVersion, baseline, results })
    const file = path.join(OUT, 'equivalence-report.md')
    fs.writeFileSync(file, report)
    process.stdout.write(`${report}\n[equivalence] report written to ${file}\n`)
  }
  await fake?.close()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

describe('baseline (no cc-tap) exercises the scenario', () => {
  it('runs to completion', () => {
    expect(baseline.exitCode, describeRun(baseline)).toBe(0)
    expect(baseline.stdout).toContain(FINAL_TEXT)
  })

  it('retries 429 then 529, then gets thinking + tool_use, then the final answer', () => {
    expect(baseline.wire.map(c => `${c.kind}:${c.response.status}`)).toEqual(['main:429', 'main:529', 'main:200', 'final:200'])
  })

  it('sends the thinking block back with the tool result', () => {
    const last = JSON.stringify(baseline.wire.at(-1)?.body?.messages)
    expect(last).toContain(THINKING_TEXT)
    expect(last).toContain(THINKING_SIGNATURE)
    expect(last).toContain(TOOL_USE_ID)
  })
})

describe.each(MODES)('cc-tap %s capture vs baseline', mode => {
  const known = new Set<Category>(KNOWN_DIFFERENCES[mode])
  let run: RunResult
  let diffs: Diff[] = []

  beforeAll(async () => {
    run = await runClaude(mode, { fake, workDir, runDir: path.join(tmp, mode), claudeBin: CLAUDE })
    saveRun(run)
    diffs = diffAttempts(attemptsFromWire(baseline), attemptsFromCaptures(run))
    results.push({ mode, known: [...known], run, diffs })
  })

  it('runs to completion and stores every /v1/messages attempt', () => {
    expect(run.exitCode, describeRun(run)).toBe(0)
    expect(run.stdout).toContain(FINAL_TEXT)
    expect(run.captures.length, describeRun(run)).toBe(run.wire.length)
  })

  it.each(CATEGORIES)('%s', category => {
    const found = diffs.filter(d => d.category === category)
    if (known.has(category)) {
      if (found.length === 0) {
        throw new Error(
          `${mode}: "${category}" now matches the baseline, so Claude Code no longer changes it in this mode. ` +
          `Remove it from KNOWN_DIFFERENCES['${mode}'] in test/equivalence/equivalence.test.ts, and update the proxy caveat ` +
          `(README "Proxy mode", components/proxy/capture-controls.tsx).`,
        )
      }
      return
    }
    if (found.length > 0) {
      throw new Error(`${mode}: stored capture differs from the baseline wire traffic on "${category}" (- baseline, + capture):\n${formatGitDiff(found)}`)
    }
  })
})

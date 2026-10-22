import path from 'path'
import os from 'os'
import fs from 'fs'

// The sample generator is plain CommonJS shared with the CLI's `--demo` flag.
// A static require keeps it in the server bundle's file trace.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generate } = require('../bin/generate-sample.js') as {
  generate: (outDir: string, opts: { days: number; seed: number }) => unknown
}

/**
 * Populate a fictional dataset and point the reader at it, so a hosted deploy
 * (e.g. Vercel) shows a full dashboard instead of an empty one. Triggered by
 * the CC_LENS_DEMO env var. The data lands in the OS temp dir — the only
 * writable location on serverless — and is regenerated per cold start.
 *
 * No-op if CLAUDE_CONFIG_DIR is already set (the CLI's `--demo` path does its
 * own generation and points us at it), or if CC_LENS_DEMO is unset.
 */
export function setupDemoData(): void {
  if (!process.env.CC_LENS_DEMO || process.env.CLAUDE_CONFIG_DIR) return

  const demoDir = path.join(os.tmpdir(), 'cc-lens-demo', '.claude')
  try {
    // Skip regeneration if a previous invocation on this instance already built it.
    if (!fs.existsSync(path.join(demoDir, 'stats-cache.json'))) {
      generate(demoDir, { days: 90, seed: 42 })
    }
    process.env.CLAUDE_CONFIG_DIR = demoDir
  } catch (err) {
    console.error('[cc-lens] failed to set up demo data:', err)
  }
}

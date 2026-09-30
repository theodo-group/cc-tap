import { defineConfig } from 'vitest/config'
import path from 'path'

// Equivalence suite: runs the real Claude Code CLI against a fake Anthropic API,
// with and without cc-tap. Kept out of `npm test`: needs `claude` on PATH and takes minutes.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    include: ['test/equivalence/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})

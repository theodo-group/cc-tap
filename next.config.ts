import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

// When run via `npx`, a lockfile also exists above this package (npx cache root).
// Without an explicit root, Turbopack can pick the wrong workspace and fail to resolve
// `.next/dev/.../build-manifest.json` for the app.
const packageRoot = path.dirname(fileURLToPath(import.meta.url));

// CC_TAP_BASE_PATH=/relay/cc-tap builds an app served under that prefix, for a proxy that
// forwards it as-is. Unset, cc-tap serves at the root. Baked in at build time: the client
// reads it through `env` (lib/base-path.ts), the CLI from the build's routes manifest.
const basePath = process.env.CC_TAP_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  basePath,
  env: { CC_TAP_BASE_PATH: basePath },
  // A prefixed build answers nothing at the root, so send `/` to the prefix: a health check
  // or bookmark on the bare port lands on the app. Next allows `basePath: false` here,
  // unlike in a rewrite.
  async redirects() {
    return basePath ? [{ source: '/', destination: basePath, basePath: false, permanent: false }] : [];
  },
  // Asked for rather than inherited: the session routes answer megabytes of
  // JSON, and a replay of 12 MB travels as 2.3 MB compressed.
  compress: true,
  // Produces .next/standalone/ with a self-contained server.js + minimal node_modules,
  // so `npx cc-tap` can launch immediately without `npm install` on first run.
  output: 'standalone',
  outputFileTracingRoot: packageRoot,
  outputFileTracingExcludes: {
    '*': [
      '.claude/**',
      '.git/**',
      'node_modules/.cache/**',
      '**/*.md',
      '**/*.png',
      '**/*.jpg',
    ],
  },
  // The demo bootstrap (instrumentation.ts) generates sample data at runtime via
  // this script, so make sure it ships with the server bundle on a deploy.
  outputFileTracingIncludes: {
    '*': ['./bin/generate-sample.js'],
  },
  turbopack: {
    root: packageRoot,
  },
};

export default nextConfig;

import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

// When run via `npx`, a lockfile also exists above this package (npx cache root).
// Without an explicit root, Turbopack can pick the wrong workspace and fail to resolve
// `.next/dev/.../build-manifest.json` for the app.
const packageRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Produces .next/standalone/ with a self-contained server.js + minimal node_modules,
  // so `npx cc-tap` can launch immediately without `npm install` on first run.
  output: 'standalone',
  // better-sqlite3 is a native addon (used by the inspector DB and the proxy).
  // Keep it external so it's require()'d from node_modules at runtime — both by
  // Next's server graph and by the separately-spawned proxy/server.js — rather
  // than being bundled by webpack (which breaks native .node binaries).
  serverExternalPackages: ['better-sqlite3'],
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
  turbopack: {
    root: packageRoot,
  },
};

export default nextConfig;

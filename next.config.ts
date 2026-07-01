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

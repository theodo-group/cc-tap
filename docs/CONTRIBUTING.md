# Contributing to Claude Code Lens

Thanks for helping improve `cc-tap`. This project reads private local Claude Code data, so contributions should preserve the local-first, no-telemetry model.

## Development Setup

Requirements:

- Node.js 24 or newer
- npm
- Claude Code data in `~/.claude/` for realistic local testing

Install and run:

```bash
npm install
npm run dev
```

Open the local URL shown by Next.js, usually <http://localhost:3000>.

Run the same lint, test, and build checks as CI before opening a code PR:

```bash
npm run lint
npm test
npm run build
```

When changing CLI packaging, proxy bundling, or build-path behavior, also run
`npm run build:dist` and smoke-test `node bin/cli.js` from that standalone build.
Documentation-only changes should be checked for relative links, command names,
and agreement with the implementation; they do not require a new application build.

## Project Structure

- `app/`: Next.js app routes and API routes
- `components/`: shared UI and dashboard components
- `lib/claude-reader.ts`: local Claude Code file readers
- `lib/replay-parser.ts`: session JSONL replay parsing
- `lib/pricing.ts`: token and cost estimation
- `lib/agent-timeline.ts`, `lib/workflow-runs.ts`: agent/workflow investigation
- `lib/session-ledger.ts`, `lib/reported-cost.ts`: per-turn and reported costs
- `lib/redact.ts`: Team export allowlist
- `lib/__tests__/`: Vitest coverage
- `proxy/`: raw API forwarding and local capture storage
- `types/claude.ts`: shared app types
- `bin/cli.js`: published `cc-tap` CLI entrypoint

## Contribution Guidelines

- Keep ordinary use local-first and free of telemetry or required hosted services.
  Team pushes and proxy forwarding are explicit network flows; document changes
  to their destinations, data, and consent rather than introducing silent uploads.
- Treat `~/.claude/` content as private user data.
- Bind local servers to loopback by default unless the user explicitly opts into another host.
- Prefer small PRs with a clear user-facing outcome.
- Add focused tests when changing parsing, pricing, import/export, or filesystem behavior.
- Preserve compatibility with missing, partial, or malformed Claude Code files.
- Avoid broad refactors unless they directly support the change.

## Testing Changes Manually

For parser or filesystem changes, test at least these cases:

- default `~/.claude/`
- custom `CLAUDE_CONFIG_DIR`
- missing config directory
- empty projects directory
- malformed JSONL line
- sessions with tool calls, compaction, and cache tokens

Example custom profile run:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work npm run dev
```

## Pull Request Checklist

- [ ] Local browsing keeps user data local; any explicit sharing/capture flow is documented.
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] User-facing behavior is documented when relevant.
- [ ] Screenshots or short recordings are included for visible UI changes.
- [ ] Parser/filesystem changes handle missing or malformed local files.
- [ ] README, roadmap, and limitations agree on whether a capability is delivered,
      partial, or proposed; unreleased changes are not presented as npm releases.

## Reporting Security Issues

Please do not open a public issue for vulnerabilities involving private data exposure. See [SECURITY.md](SECURITY.md) for reporting guidance.

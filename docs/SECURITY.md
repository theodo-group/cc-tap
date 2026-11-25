# Security Policy

Claude Code Lens reads local Claude Code files that may contain sensitive prompts, file paths, command output, tool results, and project history. Security and privacy regressions are treated as high priority.

## Supported Versions

The latest published npm version and the current `main` branch receive security fixes.

## Reporting a Vulnerability

If you find a vulnerability, please report it privately instead of opening a public issue.

- GitHub Security Advisories are preferred when available.
- If advisories are unavailable, arrange a private reporting channel with the
  Theodo Group fork maintainers. The original author credited in `package.json`
  is not necessarily the security contact for this fork.

Please include:

- affected version or commit
- operating system
- reproduction steps
- whether private Claude Code data can be read, modified, exposed, or uploaded
- any relevant logs or screenshots with sensitive content redacted

## Security Principles

- No telemetry.
- No account system.
- No required hosted backend for local browsing.
- No separate API key requirement for reading local history; the capture proxy
  forwards Claude Code's upstream authentication.
- Local history stays local during browsing. Team exports/pushes are explicit
  sharing flows; Live Capture forwards requests upstream and stores local copies.
- The packaged CLI binds to `127.0.0.1` by default.
- LAN access requires an explicit `--host 0.0.0.0` (or `CC_LENS_HOST=0.0.0.0`) opt-in.
- The Team push token protects the push endpoint, not every dashboard/API route.
  A network-accessible instance needs appropriate network/access controls.

## Local Files Read

`cc-tap` reads data from the active Claude Code config directory. By default this is `~/.claude/`; users can override it with `CLAUDE_CONFIG_DIR`.

Known reads include:

- `projects/<slug>/*.jsonl`
- Sub-agent transcripts and Workflow records/scripts under session directories
- `stats-cache.json`
- `usage-data/session-meta/`
- `history.jsonl`
- `todos/`
- `plans/`
- `projects/*/memory/`
- `settings.json`

## Local Files Written

The app should avoid modifying Claude Code source data unless a feature explicitly requires it and the UI makes that clear.

Known write behavior:

- The CLI/runtime may prepare package runtime files outside `~/.claude/` as described in the README.
- The Memory page can edit memory files through the local API.
- Export creates a downloaded `.cclens.json` file when the user requests it.
- Team export creates redacted metrics; an optional hub stores explicitly pushed
  exports in its team directory.
- Live Capture stores gzipped request/response bodies in `~/.cc-lens/payloads/`
  and a SQLite index in `~/.cc-lens/inspector.db`. Compression is not encryption.
- Demo mode writes fictional history under `~/.cc-lens/demo/.claude/`.
- Import is preview-only and does not write merged sessions back into `~/.claude/`.

## Network Behavior

The dashboard is designed to run locally. It does not need a hosted backend or telemetry endpoint.

Known opt-in network flows include proxy forwarding to Anthropic and Team
pushes to the chosen hub. See [Privacy](./PRIVACY.md) for exported fields,
capture retention, and network exposure.

When reviewing changes, pay special attention to:

- new `fetch` calls to external origins
- analytics SDKs
- crash reporting SDKs
- remote image or script loading
- server routes that expose local file contents
- changes to host binding or CORS behavior

## Safe Review Checklist

Before releasing changes that touch filesystem, export/import, session replay, settings, or memory:

- confirm the server still binds locally by default
- verify network calls stay within the documented, explicitly requested flows
- verify path traversal protections on API routes
- verify user-controlled paths cannot escape the configured Claude directory
- test malformed JSONL and missing files
- inspect generated exports for unintended sensitive fields
- preserve the Team allowlist and distinguish metrics redaction from general exports
- review capture payload/index storage and retention together

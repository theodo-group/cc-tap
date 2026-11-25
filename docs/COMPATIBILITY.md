# Compatibility

This project tracks Claude Code's local data files. Compatibility is best-effort because those files are not a stable public API.

## Supported Runtime

- Node.js 24 or newer (required by the built-in `node:sqlite` module).
- npm.
- macOS and Linux are the most-tested environments.
- Windows is supported in the CLI and docs, but needs more broad testing.

## Supported Claude Code Data

`cc-tap` currently reads:

- `~/.claude/projects/<slug>/*.jsonl`
- `~/.claude/projects/<slug>/<session>/subagents/`, including `workflows/wf_*/`
- `~/.claude/projects/<slug>/<session>/workflows/`
- `~/.claude/stats-cache.json`
- `~/.claude/usage-data/session-meta/`
- `~/.claude/history.jsonl`
- `~/.claude/todos/`
- `~/.claude/plans/`
- `~/.claude/projects/*/memory/`
- `~/.claude/settings.json`

You can point `cc-tap` at another Claude Code config directory:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work npx cc-tap
```

The CLI banner shows the active directory. Without local history, use
`npx cc-tap --demo` to explore fictional sessions. Existing `~/.cc-lens/` storage
and `CC_LENS_*` variables retain their names for compatibility.

The inspector proxy forwards Anthropic API traffic; support for other providers
or changed Claude Code request behavior should be verified rather than assumed.
See [Live Capture limitations](./LIMITATIONS.md#live-capture).

## Compatibility Policy

- Missing files should produce empty states, not crashes.
- Malformed JSONL lines should be skipped.
- New Claude Code fields should be ignored until `cc-tap` uses them.
- Old sessions should still appear when enough metadata exists to identify the session.

## Reporting Compatibility Issues

Open a bug report and include:

- `cc-tap` version
- operating system
- Node.js version
- whether you use `CLAUDE_CONFIG_DIR`
- which page is wrong or empty
- a redacted example of the affected local file shape, if safe to share

Do not paste private prompts, source code, command output, secrets, or full session transcripts into public issues.

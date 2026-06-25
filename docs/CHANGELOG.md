# Changelog

All notable changes to this project will be documented in this file.

This project follows a simple changelog format:

- `Added` for new features
- `Changed` for updates to existing behavior
- `Fixed` for bug fixes
- `Security` for vulnerability fixes or privacy hardening

## 0.6.0

Syncs upstream [Arindam200/cc-lens v0.4.0](https://github.com/Arindam200/cc-lens/releases/tag/v0.4.0) into the cc-tap fork, on top of the existing raw-API inspector + Live Capture.

### Changed

- Adopted upstream's prebuilt standalone run-model: the CLI now boots `.next/standalone/server.js` (instant start, no install/compile on first run) instead of syncing source and running `next dev`. The inspector proxy is bundled into the standalone output (`proxy/` + native `better-sqlite3`) and still launches on demand from the dashboard.
- Sessions and costs are now priced by actual per-model usage; pricing defaults refreshed (adds Fable 5 and Opus 4.8) with `~/.cc-lens/pricing.json` overrides.
- Faster cold scans of `~/.claude`: parsed-JSONL caching by mtime, line-by-line streaming, and bounded-concurrency parsing.

### Added

- Insights page with savings detectors that attach dollar estimates: low cache hit rate, premium models on short sessions, compaction thrash, and subscription plan fit.
- Monthly budget (stored in `~/.cc-lens/config.json`) with pacing projection, plus daily spend spike detection surfaced on Insights and Costs.
- Team feature adoption view: per-member use of plan mode, agents, skills, MCP, and web, with cost per session and idle badges.
- MCP server governance inventory on the Team page, built from tool counts already present in redacted exports.
- `cc-tap digest` command that prints a formatted summary (spend, top projects or members, savings, budget pace, spike alerts) in the terminal; supports `--days` and `--team`. Slack/webhook delivery is reserved for the managed version.
- Wrapped page: a yearly shareable stats card with PNG download, containing only aggregates.
- Contributor guide for local development and PR expectations.
- Security policy for private vulnerability reporting and local data handling.
- Privacy documentation describing local files, export behavior, and network expectations.
- GitHub issue templates for bug reports and feature requests.
- GitHub Actions CI for lint and production build checks.
- Roadmap, known limitations, and compatibility documentation for open-source users.

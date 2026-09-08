# Changelog

All notable changes to this project will be documented in this file.

This project follows a simple changelog format:

- `Added` for new features
- `Changed` for updates to existing behavior
- `Fixed` for bug fixes
- `Security` for vulnerability fixes or privacy hardening

## Unreleased

### Added

- **Agents tab on the session page.** A flame-style timeline of the orchestrator and every sub-agent it launched: one row per agent, bars colored by outcome (completed, failed or killed, running, unknown), orange ticks for human prompts on the orchestrator row and for `SendMessage` nudges on agent rows, nested sub-agents that expand on click, a duration column, and a clock axis that collapses idle gaps longer than 30 minutes. Clicking a row opens a details sheet (type, model, tokens, cost, prompt) with a link that jumps to the launching turn in the Replay tab. The tab only appears when the session has agent transcripts.
- New API route `GET /api/sessions/[id]/agents` backed by `lib/agent-timeline.ts`, which reads the orchestrator JSONL plus the `<session>/subagents/*.jsonl` and `.meta.json` files, and links agents to their launching `Agent` tool call, parent agent, and `task-notification` status.
- **Context-management markers.** The agents payload now carries `context_events`: compactions (from `compact_boundary` lines), `/clear` commands, and rewinds. A rewind has no marker in the log, so it is detected as a fork in the `parentUuid` chain; the discarded turns are flagged `discarded` in the replay data, shown dimmed under a "REWIND" band, and still counted in cost. The flame chart draws each event as a dashed vertical line and lists them under the chart.
- **Time window.** Drag across the flame chart, or use the window bar above the stat cards (presets for activity blocks and prompt-to-prompt ranges, plus editable from/to fields), to focus on a range. Every metric on the page follows the window: stat cards, sidebar, token chart, the replay list, the Agents badge and summary. The range is stored in the URL as `?from=&to=` so a link can be shared.

### Fixed

- The flame chart hover card could describe a different row than the one under the cursor. Each row now owns its hover and click through a full-width band, and the card is positioned by the chart wrapper.

## 0.8.0

Fixes `npx cc-tap` being broken at 0.7.0.

### Changed

- The inspector reader (`lib/inspector-db.ts`) and the proxy writer (`proxy/server.js`) now use Node's built-in `node:sqlite` (`DatabaseSync`) instead of `better-sqlite3`. No native addon means nothing for Turbopack to externalize, no platform-specific `.node` binary to ship, and no cross-platform lockfile or CI handling.
- Dropped the `better-sqlite3` and `@types/better-sqlite3` dependencies, and removed `serverExternalPackages` from the Next config.
- Reverted the `prepare-standalone` shim-rewrite workaround added for the native addon.
- **Breaking:** requires Node.js 24 or newer (`node:sqlite` is unflagged there). `@types/node` bumped to `^24`.

### Fixed

- `npx cc-tap` failed at 0.7.0 with `Cannot find module 'better-sqlite3-<hash>'` from `/api/activity`. Turbopack externalized the native package by copying it to a hashed shim under `.next/node_modules/` and rewriting server chunks to require the hashed name; that shim resolved in a local checkout but lived outside `.next/standalone` and was never published.
- Suppressed `node:sqlite`'s load-time `ExperimentalWarning` on every spawned Next server (`bin/cli.js`) and proxy (`lib/proxy-control.ts`).

## 0.7.0

### Added

- Live tab: an **Assembled** response view that reconstructs the final message from the SSE stream (concatenated text, `tool_use` inputs built from `input_json_delta`, final `stop_reason` + merged usage), shown as pretty-printed JSON.
- **Response Assembled** download (top action strip and the Response card) — saves the reassembled message as JSON, alongside the existing raw **Response SSE** download.

### Changed

- Live tab: the raw SSE response is now pretty-printed per event (padding trimmed, `data:` JSON indented, consecutive `ping`s collapsed) and no longer wraps mid-token. An **Assembled / Raw SSE** toggle switches between the two views.

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

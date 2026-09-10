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
- **Tool call filters.** In the Agents tab, add any number of filters such as `pnpm ci-verify`. Every word must appear, case-insensitively, in the tool name and input, and a quoted part such as `"pnpm ci-verify"` must appear as that exact phrase; a per-filter toggle also searches the tool results. Each filter is a colored layer: bars at every matching call, spanning the call to its result on the orchestrator and agent rows, a count per row in the right column (collapsed parents roll up their sub-agents as `own+children`), a total in the chip, and a combined match list that jumps to the launching turn or opens the agent. Counts follow the selected window. Filters live in the URL as `?f=` and `?fr=`.
- New API route `GET /api/sessions/[id]/search?q=&scope=input|all` backed by `lib/tool-search.ts`, which scans the orchestrator and every sub-agent transcript.
- **Sub-agent conversation in the drawer.** Opening an agent from the flame chart or the match list now shows its full transcript under the details, rendered with the Replay turn cards and paged 60 turns at a time. New route `GET /api/sessions/[id]/agents/[agentId]` parses `<session>/subagents/agent-<id>.jsonl` with the replay parser.
- **Time cursor.** Moving the pointer over the Agents chart draws a vertical line at that instant with its clock time, and the hover card shows the exact time under the pointer.
- **Zoom to window.** With a window selected, the Agents chart zooms by default: only the selected range is drawn, on a linear scale, and rows outside it are hidden. A toggle switches back to the whole session with out-of-window rows dimmed. Dragging while zoomed narrows the window further.
- **Workflow runs in the Agents tab.** Runs of the `Workflow` tool (multi-agent orchestration scripts) now appear in the flame chart as group rows, interleaved with plain sub-agents: a bar colored by run status, its phases drawn as alternating segments, orange ticks where an agent failed or was blocked, a pulse while it runs, and a `· N agents · M failed` suffix while collapsed. Expanding a run lists its agents by phase (`P2 · label`), with a hollow dashed bar for agents blocked before they started. Clicking a run opens a drawer with its status, attempts, agent counts, tokens, cost, a **Failures** list up front (each with the recorded reason, such as a session limit or a safety-classifier block), the phases with clickable agent chips, a link to the launching turn, and collapsible Args, Result, Logs, Journal and Script sections loaded on demand. The agent drawer shows the agent's phase, state, attempt, error, result preview, and a link back to its run; agents without a transcript show the reason instead of a conversation.
- New API route `GET /api/sessions/[id]/workflows/[runId]` backed by `lib/workflow-runs.ts`, which reads the run record (`<session>/workflows/wf_<id>.json`, with `script`, `args` and `result` size-capped) and the resume journal (`<session>/subagents/workflows/wf_<id>/journal.jsonl`).
- `lib/agent-timeline.ts` reads workflow agent transcripts from `<session>/subagents/workflows/wf_<id>/`, joins them with the run record's `workflowProgress` (label, phase, state, error, tokens, tool calls, attempt) and with the journal for agents the record does not list (an earlier attempt of a resumed run, a run still going), and synthesizes rows for agents that never got a transcript. Run status comes from the record, else from the `task-notification` of its latest task, else from transcript freshness. The timeline payload carries the new `workflows` list, and `AgentRun` gains optional `workflow_*` fields.
- Sub-agent transcripts are now located through `lib/subagent-files.ts` (flat folder plus every run folder), shared by the timeline, the tool-call search and the per-agent transcript route. Search matches carry a `workflow_id`.
- Transcript scans are cached per file by mtime and size, and read with bounded concurrency; a session with 170 workflow transcripts loads its Agents tab in about a second cold and well under 100 ms afterwards.

### Changed

- The `Workflow` (and `Agent`) tool calls count toward the agents session facet and the "Agents" tool category, so workflow-only sessions get the agents badge in the session table.

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

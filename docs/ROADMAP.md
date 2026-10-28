# Roadmap

`cc-tap` is a local-first tool for understanding Claude Code sessions, agents,
context, and usage. It should remain useful without an account or hosted backend.

The capabilities below exist on `main`; this is not a list of npm release
contents. See [CHANGELOG.md](./CHANGELOG.md) for released and unreleased changes.
Proposed work is a direction for review, not a dated delivery commitment.

## Delivered on Main

- **Session investigation**: searchable, virtualised replays, parsed-response
  caching, tool inputs/results, and jumps to a turn or time.
- **Agents and workflows**: nested timelines, workflow status and failures,
  transcript drawers, time windows, and tool-call filters.
- **Context analysis**: orchestrator and sub-agent curves in tokens or percentage
  of context limit, with links back to the conversation.
- **Live Capture**: local inspector proxy, Live view, and per-session Raw API tab.
  The proxy has [behavioral limitations](./LIMITATIONS.md#live-capture).
- **Cost accounting**: response deduplication, sub-agent totals, request-level
  pricing, local pricing overrides, unpriced-model warnings, and Claude Code's
  reported session cost when a complete record is available.
- **Demo mode**: `npx cc-tap --demo` with fictional session history.
- **Automated tests**: parser, pricing, replay/search, agents/workflows, team,
  and CLI helper coverage in `lib/__tests__/`, run in CI with lint and build.
- **Team aggregation**: redacted metrics exports, shared-folder analytics,
  optional push hub, adoption metrics, and MCP inventory.
- **Insights and budgets**: savings suggestions, monthly budget pacing, and
  spend-spike detection.
- **Usage and digest**: usage headroom and `cc-tap digest` for personal or team scope.
- **Wrapped**: yearly aggregate stats card.
- **Integration**: `--open` and builds served under `CC_TAP_BASE_PATH`.

## Proposed Next Priorities

### 1. Validate Capture Fidelity

- Reproduce differences between a normal Claude Code session and proxy capture;
  review [PR #21](https://github.com/theodo-group/cc-tap/pull/21), which proposes
  OTel body-export ingestion as an alternative.
- Document the selected mode's coverage, storage lifecycle, and whether response
  data is captured verbatim or reconstructed before making it the default.
- Check Live, Raw API, Agents, and Context visually after upstream UI changes.

### 2. Observe Current Users (Gemba)

- Observe regular, occasional, and former users completing a real investigation
  on their own setup: launch, find a session, identify the cause, and take action.
- Include context/agent debugging, unexpected cost, and live-capture tasks.
- Record the task, expected result, friction, consequence, and workaround.
  Use recurring, consequential problems to choose the next improvements.
- Aim for five observed sessions and three ranked problems with concrete
  evidence. This is a research plan; no user findings are asserted here.

### 3. Make First Use and Maintenance Clear

- Validate first-run states for missing, unreadable, empty, and custom Claude Code
  directories, and make the active data source easy to identify.
- Keep README examples, privacy guidance, roadmap status, and release notes aligned
  with shipped behavior. Distinguish `main` from the published package.
- Expand compatibility fixtures for old and new transcript formats and add
  real-world Windows validation.

## Candidates After User Research

- Selected-session export with configurable redaction beyond the existing Team
  metrics export. General `.cclens.json` exports remain private.
- Replay export and clearer pricing provenance/date in the UI.
- A maintained public sample dashboard.
- Local custom metrics without changes to core dashboard code.

Managed/enterprise ideas are described separately in [TEAM-WORKSPACE-PLAN.md](./TEAM-WORKSPACE-PLAN.md)
and [MANAGED-PLAN.md](./MANAGED-PLAN.md). Those plans do not imply availability in
the open-source package; Slack/webhook delivery is not implemented here.

## Non-Goals

- Hosted sync or telemetry by default.
- Automatic upload of raw Claude Code transcripts.
- Replacing Claude Code's files or acting as their source of truth.

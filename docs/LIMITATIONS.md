# Known Limitations

`cc-tap` reads local Claude Code files directly. Those formats can change and are
not a stable public API. This document describes current `main`; see
[CHANGELOG.md](./CHANGELOG.md) for released and unreleased changes.

## Data Accuracy

- Costs are usage diagnostics, not invoice totals or subscription charges.
- A session uses Claude Code's reported `cost-state` total only when that record
  covers all its turns and has no unknown model cost. Running, interrupted, older,
  or incompletely covered sessions use table estimates and are labelled as such.
- Estimated costs depend on recorded usage and `lib/pricing.ts`. Unknown models
  borrow a fallback/prefix rate and are flagged; provider pricing can change.
- Local `~/.cc-lens/pricing.json` overrides are supported. They are cached for the
  process lifetime, so restart after editing. They do not replace accepted
  reported session totals.
- Aggregates that lack a per-turn ledger, including team exports and stats-cache
  fallbacks, cannot apply every request-level pricing modifier.
- Older sessions may lack model, usage, branch, or compaction metadata.
- Duration is inferred from timestamps; it is not a direct measurement of active
  work. Language, line, and file-change counts depend on what Claude Code recorded.
- Context percentages use configured model limits, not a recorded negotiated
  context window. Unknown models use defaults. Local limits can be overridden in
  `~/.cc-lens/context.json`; restart after editing.

## Live Capture

- Only traffic routed through the local inspector proxy is captured. Start it
  and launch Claude Code with the command shown in the Live Capture popover;
  existing sessions do not gain retrospective raw API payloads.
- A custom `ANTHROPIC_BASE_URL` can change Claude Code's behavior, including its
  tools and request parameters. `ENABLE_TOOL_SEARCH=true` addresses tool search,
  but does not establish equivalence with a normal session.
- [PR #21](https://github.com/theodo-group/cc-tap/pull/21) proposes capture from
  Claude Code's OTel body export. It is pending work, not the current default.
  Its proposed reconstructed SSE must not be confused with raw wire events.
- Raw captures contain sensitive content and create a separate local copy in
  `~/.cc-lens/`. Compression is not redaction or encryption. See
  [Privacy](./PRIVACY.md#live-capture) for retention defaults.

## Import, Export, and Team Mode

- General `.cclens.json` exports may contain sensitive metadata and command
  history. They do not use the Team export redaction allowlist.
- Import is preview-only: it does not merge sessions back into `~/.claude/`.
- Team metrics exports and aggregation are implemented. Prompts are excluded by
  default; the opt-in `titles` level includes first prompts. Project names,
  member identity, and usage patterns can still be sensitive.
- Team data is only as fresh and complete as members' exports/pushes. Local
  history cannot account for cloud-only sessions that never reach the machine.
- Multiple machines need distinct machine labels. See [Team mode](./TEAM.md).
- Arbitrary selected-session redaction and replay export remain future work.

## Compatibility and Runtime

- Node.js 24+ is required, including when using `npx cc-tap`.
- macOS and Linux are the most-tested environments; Windows needs broader
  real-world validation. See [Compatibility](./COMPATIBILITY.md).
- Parser tests exist, but do not guarantee compatibility with every Claude Code
  version. Missing fields can produce partial panels.
- Large histories still require a cold scan; session and replay caches reduce
  repeated work but do not eliminate the initial read.
- The packaged CLI binds to `127.0.0.1` by default. `--host 0.0.0.0` exposes the
  dashboard's private local data to the network; a hub push token protects the
  push endpoint, not the whole dashboard.
- Sub-path hosting requires a source build with `CC_TAP_BASE_PATH`. The published
  root build cannot acquire a prefix at runtime.

Demo mode, replay search, parser tests, local pricing overrides, and team
aggregation are already implemented. See [Roadmap](./ROADMAP.md) for proposed work.

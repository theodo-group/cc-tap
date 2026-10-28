# Privacy

`cc-tap` is a local-first dashboard for Claude Code data. It requires no account
or telemetry. Capture, downloads, and team sharing have different data flows;
local-first does not mean that an explicitly requested push stays on the machine.

## Local History

By default, cc-tap reads `~/.claude/`. Set `CLAUDE_CONFIG_DIR` to use another
profile. The dashboard may display:

- Session metadata, prompts, assistant responses, and thinking.
- Tool calls and results, token usage, and costs.
- Project paths, git branches, and language signals.
- Command history, todos, plans, memories, settings, skills, plugins, and MCP config.
- Sub-agent transcripts and Workflow records/scripts.

These files can contain private prompts, source code, command output, credentials
included in content, and workflow details. Ordinary local-history browsing does
not upload them to a hosted analytics service.

## Live Capture

Live Capture starts a local proxy. When you launch Claude Code with the provided
`ANTHROPIC_BASE_URL` command, the proxy forwards its requests to Anthropic
(`api.anthropic.com` by default) and saves request/response bodies locally. This
includes authentication passthrough needed for the upstream request; the
dashboard itself does not need a separate API key for reading local history.

Captures may include system prompts, tool schemas, conversation history, thinking,
and tool results. They are stored as gzipped bodies in `~/.cc-lens/payloads/`, with
an index in `~/.cc-lens/inspector.db`. Gzip is compression, not encryption or
redaction. Downloaded raw request/response files should be treated as private.

The proxy defaults to 30-day retention and a 1 GiB compressed-body budget. It
prunes old captures and then oldest sessions when enforcing these limits;
enforcement runs at startup and during capture, at most once per minute, rather
than as a background deletion service when the proxy is stopped. Set
`CC_LENS_RETENTION_DAYS` and `CC_LENS_RETENTION_BYTES` before starting the proxy to
change the limits. These limits do not delete separately downloaded exports.

Proxy capture can affect Claude Code's behavior. See
[Known limitations](./LIMITATIONS.md#live-capture). OTel body-export ingestion is
proposed in [PR #21](https://github.com/theodo-group/cc-tap/pull/21) and is not the
current capture flow.

## Exports and Team Sharing

| Action | Data and destination |
| --- | --- |
| General Export (`.cclens.json`) | Downloads stats, session metadata, facets, and recent command history. Treat the file as private; Team redaction does not apply. |
| Team export (`.cclens-team.json`) | Downloads an allowlisted metrics file. Sharing the file or placing it in a synced folder makes it available to that destination's readers. |
| `cc-tap push --to <hub-url>` | Builds a Team export and sends it to the hub you specify. The hub stores a redacted copy for team aggregation. |
| Wrapped PNG | Downloads an aggregate yearly stats card; review it before sharing. |

Team exports exclude prompts, tool-result content, full project paths, and command
history by default. They retain project folder names, tool counts, session IDs,
duration/usage metrics, hour-granularity session timestamps, and the supplied
member name, optional email, and machine label. These are redacted metrics, not
anonymous data. The opt-in `titles` level adds each session's first prompt.

Inspect exports before sharing, particularly with `titles` enabled. The hub
re-applies the redaction allowlist on receipt. See [Team mode](./TEAM.md) and
`lib/redact.ts` for the fields and sharing options.

## Network Access

The packaged CLI binds to `127.0.0.1` by default. `--host 0.0.0.0` or
`CC_LENS_HOST=0.0.0.0` makes the dashboard reachable from other devices. It serves
private local data and includes APIs that write memory files. A Team push token
authenticates pushes; it does not add access control to every dashboard route.
Use suitable network/access controls when making a hub reachable.

The `push` command sends data to the selected hub; use HTTPS or another protected
transport for remote sharing. Live Capture forwards requests upstream. npm also
needs network access to download the package and dependencies on first use.
There is no default upload to a cc-tap telemetry or cloud-sync service.

## Local Writes and Imports

- The Memory page can edit memory files in the active Claude Code config directory.
- Live Capture writes its index and payloads; runtime caches/configuration use
  `~/.cc-lens/`.
- Demo mode generates fictional history in `~/.cc-lens/demo/.claude/` instead of
  reading real session history.
- A team hub stores received metrics in its configured team directory.
- Import is preview-only and does not write merged sessions into `~/.claude/`.

Existing `~/.cc-lens/`, `CC_LENS_*`, and `.cclens.json` names are retained for
compatibility even though the CLI command is `cc-tap`.

## How To Verify

Review network behavior and the export allowlist in source:

```bash
rg 'fetch\(|analytics|telemetry|sentry|posthog|segment|amplitude|https?://' app components lib bin proxy
```

After installing dependencies, local-history browsing can be checked offline
with `npm run dev`. Live Capture's upstream calls and remote team pushes require
network access. Never post private transcripts or raw captures in public issues;
see [Security](./SECURITY.md) for private reporting.

# Roadmap

Last reviewed 2026-11-24. Nothing here has a delivery date. The order is the commitment.

## What cc-tap is for

cc-tap is a debugger for agentic Claude Code sessions. It answers three questions about a session. What did the agents do, where did the context go, and what did it cost.

The repo holds two products. We inherited a personal stats dashboard from cc-lens, with costs, activity, the usage gauge and Wrapped. Theodo then built the session investigation tools on top of it. Those are the agents and workflow timeline, the context curves, tool-call filters, conversation search, raw API capture and cost that matches what Claude Code reports. Nearly every commit since the fork went to the second product, and the roadmap follows that. The stats pages stay and get fixes. They get no new features.

The first users are Theodo engineers. Public adoption is welcome, and we don't plan work to chase it.

cc-tap stays local. It needs no account and no hosted backend.

## Now

These four items unblock the rest. Do them first, in this order.

1. Release 0.12. The published package predates the fixes to 1-hour cache write pricing and reported session cost, so it shows wrong costs. Then publish to npm from CI when someone pushes a tag. Releases should stop depending on someone remembering to run a command.
2. Capture payloads from Claude Code's OTel export instead of the proxy. [PR #21](https://github.com/theodo-group/cc-tap/pull/21) does this and needs review. Today Live Capture points `ANTHROPIC_BASE_URL` at a local proxy, and Claude Code behaves differently behind it. The PR measured 20 tools instead of 12, extra classifier calls and different beta headers. A capture that differs from a normal session can't be trusted for debugging. Split the PR if 2,887 lines is too much for one review.
3. Take ownership of the project's name. `MANAGED.md`, `MANAGED-PLAN.md` and `BUILD-IN-PUBLIC.md` describe the upstream author's plan for a hosted paid product, and nobody at Theodo owns that plan. Move them out of `docs/` or delete them. Fix the package author and the sidebar footer link, which still name upstream. Plan the move from `~/.cc-lens` to `~/.cc-tap` and keep reading the old directory.
4. Watch five Theodo engineers debug a real session on their own machine. Write down the task, where they got stuck and what they did instead. Use the three problems that come up most to reorder the next section.

## Next

### Hidden calls

People have found Claude Code spending tokens on requests they never saw. One example is a background call that summarises the whole conversation into one line, over and over. The session transcript doesn't record those calls, so cc-tap can't show them today.

With OTel capture in place, cc-tap sees every model request. The export also tags each request with a `query_source` that says what triggered it. The ingest logs that field and throws it away.

- Store `query_source` with each capture.
- Match each capture to the transcript by message ID. A capture with no transcript line is a hidden call.
- Add a panel to the session page that groups hidden calls by purpose and shows count, tokens, cost and how often they fire. A click opens the request in the Raw API tab so the user can read the prompt.
- Show the hidden share of spend on the Costs page.

Two things need checking before we build the panel.

- We haven't confirmed that the OTel export contains every background call. Run one session through both the export and an intercepting proxy and compare the two lists. If the export misses calls, this feature needs the proxy described under Later.
- Claude Code's reported session cost covers everything the process spent. The transcript only covers what it logged. The gap between the two might reveal hidden spend on old sessions with no capture at all. The gap also contains pricing error, so measure it on a few captured sessions before showing it to anyone.

### Session diagnosis

The session page has the data to explain a bad session and leaves the user to find the explanation. Add a findings list at the top of each session. It names the most expensive turns, the tool results that filled the context, retry storms, failed agents and the turns where the cache broke. Each finding links to the turn. The Insights page does this per account today. This does it per session.

### Request diff

Show what changed between two consecutive captured requests. The first use is finding the edit that invalidated the prompt cache.

### Shareable session

Export one session as a redacted bundle that a colleague opens with `npx cc-tap --open`. Today the only way to show someone a session is to share your screen.

### Compare two sessions

Put two sessions side by side with cost, turns, context growth and tool mix. Use it to judge a model change, a `CLAUDE.md` edit or a new skill on the same task.

### Group the navigation

Sort the 18 sidebar entries into about four groups and put the session tools first.

### Guard against format changes

Claude Code changes its transcript format without notice. Keep one fixture session per Claude Code version and parse them all in CI. Add a smoke test for each API route.

## Later

Pick from this list after the five observations. None of it is committed.

- An intercepting proxy using `HTTPS_PROXY` and a local CA, to replace the `ANTHROPIC_BASE_URL` proxy as the advanced capture mode. It keeps the real URL and sees response headers, raw SSE, timing and calls outside `/v1/messages`. It needs a CA on the user's machine and strict redaction of tokens, and it must chain to corporate proxies. Check first that Claude Code behaves the same behind it.
- Real usage figures in place of the estimated gauge. This depends on the rate-limit headers the intercepting proxy would capture, if they carry what we expect.
- Stable deep links and a read-only API, so another tool can embed cc-tap. `--open` and `CC_TAP_BASE_PATH` are the first two pieces.
- Team reporting per client project, built on the existing redacted exports.
- A live board of running sessions and agents across a machine.

## What we won't build

- More personal stats pages.
- A hosted service, telemetry, or any automatic upload of transcripts.
- An import that writes into `~/.claude/`. Claude Code owns those files.

## Already on main

The session page has a searchable replay, an Agents tab with workflow runs, a Context tab, time windows and tool-call filters. Live Capture and the Raw API tab work through the local proxy. Cost uses Claude Code's reported total when one covers the session, and flags any model that has no price entry. Team mode has redacted exports, a shared-folder view, a push hub and `cc-tap digest`. The CLI has `--demo`, `--open` and builds under a path prefix. [CHANGELOG.md](./CHANGELOG.md) has the detail.

# Build in Public — cc-lens

Short, builder-tone posts for Twitter/X. One feature per post. Record a quick screen + face video, drop it on the placeholder, post it.

## What actually travels (read before posting)

The Claude Code audience scrolls past "I built a feature." It stops for:

1. **A pain everyone shares.** Hitting the limit mid-task. Not knowing what you spent. Losing track of what the agent did. Lead with the pain, in the first line, in plain words.
2. **A number that makes them check their own.** "I spent $X this month and had no idea" makes people open the tool just to see theirs. Reveal a real stat from your own data.
3. **"Anthropic doesn't expose this, so I built it anyway."** Reverse-engineering something the official tool hides is instant engineering cred. People respect the hack and quote-tweet it.
4. **Honesty as a flex.** Saying "this is approximate and hacky" out loud makes the smart replies defend you instead of dunking on you. It also invites the "actually here's how you'd do it properly" crowd, which is engagement.

Rules:
- First line is the hook. No "Today I added...". Start mid-pain.
- One concrete number or one concrete demo per post. Not both, not zero.
- The video is the proof. Keep the text short enough that the video has to be watched.
- Soft CTA only: `npx cc-lens`. Repo link goes in the first reply, never the main tweet (links kill reach).
- **Every post is a standalone tweet with its own video.** Not a thread, not "part 2 of." Someone who sees only this one tweet, with no context, should fully get it and want the tool. No "follow-up", no "as I mentioned", no assumed prior post.

Project one-liner (pin it):
> cc-lens reads your `~/.claude/` and shows what you actually did with Claude Code. No cloud, no account, no API key. `npx cc-lens`

---

## ★ LEAD POST — the usage gauge (your best viral shot, post first)

> Claude Code shows your usage % once, in the terminal, then forgets it. It never writes the limit, the percentage, or the reset time to disk. I checked. It's all server-side.
>
> So I reverse-engineered it from your local history. cc-lens now shows your 5h and 7d headroom in the top bar, all reconstructed on your machine.
>
> It's approximate and a little cursed. It's also saved me from hitting the wall twice this week.

`[VIDEO PLACEHOLDER: top-bar pill, then open /usage. Show the 5h + 7d gauges. End on the pill filling toward the cap.]`

*Why it can travel: limit anxiety is the single most universal Claude Code pain, and "I reverse-engineered the thing they hide" is a quote-tweet magnet. The "approximate and a little cursed" line disarms the well-actually crowd and turns them into defenders.*

---

## Post 2 — calibrate it to the real number

> Claude Code's real usage % lives only on the server, so any local estimate of it is a guess. I gave the guess a ground truth.
>
> In cc-lens you type the % Claude Code shows you once, and it back-solves your cap so the gauge tracks the official figure from then on. An approximation you can pin to reality. Good enough to plan a session around.

`[VIDEO PLACEHOLDER: open /usage in cc-lens, paste the % from Claude Code, watch the cap calibrate and the gauge snap to match.]`

*Why it can travel: stands alone as "I made a guess accurate," and quietly answers the obvious "how is this even accurate?" objection without needing the prior post.*

---

## Post 3 — it warns you before the wall

> Knowing you're at 80% is useless. Knowing you'll hit 100% in 40 minutes at this pace is the thing.
>
> cc-lens now projects where your spend lands by the time the window resets, and pings you before you slam into the cap. So you can move the heavy refactor to after the reset instead of finding out the hard way.

`[VIDEO PLACEHOLDER: pace projection line climbing toward the cap, then the "on track to hit cap" warning state.]`

*Why it can travel: reframes a boring gauge into "it sees the future." The "after the reset" workflow tip is the kind of thing people screenshot.*

---

## Post 4 — the cost number (reveal post)

> I run Claude Code on a flat plan, so I never thought about cost. Then I added cost tracking to cc-lens and saw the API-equivalent number for the month.
>
> [your real number here, e.g. "$612. On a $20 plan."]
>
> It breaks it down per model and per project. If you're on Max, you're getting away with something. Go look at yours.

`[VIDEO PLACEHOLDER: costs page, land on the big monthly number first, then the per-model and per-project breakdown.]`

*Why it can travel: a real number from your own usage makes people open the tool to check theirs, which is the whole game. "You're getting away with something" is shareable and flattering to the reader. Fill in a real figure before posting.*

---

## Post 5 — the cache savings nobody sees

> Hidden stat in your Claude Code usage: cache reads.
>
> Every turn the agent re-reads your context. Paying full input price for that would be brutal. Caching makes it cheap, and cc-lens now shows exactly how much that saved you. Mine was [number]. You never see this anywhere else.

`[VIDEO PLACEHOLDER: costs page, zoom straight to the cache savings panel and the saved figure.]`

*Why it can travel: teaches the audience something about how Claude Code actually bills, with a number attached. "You never see this anywhere else" earns the bookmark.*

---

## Post 6 — replay what the agent actually did

> "Wait, what did it just change across those 40 tool calls?"
>
> cc-lens replays any past Claude Code session like a recording. Rendered markdown, grouped tool calls, tokens and cost per turn, compaction events marked inline. Scrub back through exactly what the agent did, after the fact.

`[VIDEO PLACEHOLDER: search a session, open replay, scroll the turns, expand a tool call, point at the per-turn cost badge.]`

*Why it can travel: "what did the agent actually do" is a real anxiety once sessions get long. The replay demo is the most visually satisfying clip you have, lean on the video here.*

---

## Post 7 — your own habits, called out

> Built an engine that reads your Claude Code history and tells you where you're wasting value.
>
> Cache you're not reusing, a model you're overpaying for, compaction patterns, plan-fit. It caught two habits I'd swear I didn't have. It's just pattern-matching on local data, but it reads like a code review of how you use the agent.

`[VIDEO PLACEHOLDER: insights page, scroll the cards, read one real finding from your own data out loud.]`

*Why it can travel: "a tool that roasts how you use Claude Code" is a fun, relatable frame. Reading a real finding about yourself makes it feel honest, not salesy.*

---

## Post 8 — the tools the agent reaches for

> Ran the numbers on which tools Claude Code actually uses across all my sessions.
>
> cc-lens ranks every tool, colored by category, with MCP servers broken out per server and slash-command usage tracked. The split between Bash, file edits, and MCP says a lot about how you actually work.

`[VIDEO PLACEHOLDER: tools page, ranking bar, hover a category, scroll to the MCP and skill breakdown.]`

*Why it can travel: data about a shared tool invites people to compare ("my Bash count is unhinged"). Good for replies.*

---

## Post 9 — the late-night confession

> The activity calendar in cc-lens just exposed me. My best Claude Code sessions are all after midnight.
>
> GitHub-style heatmap, streaks, peak hours, day-of-week. Reads your whole history. Mildly attacked by my own dashboard.

`[VIDEO PLACEHOLDER: activity page, hover heatmap cells, show the streak counter and the late peak-hours bar.]`

*Why it can travel: self-deprecating + relatable. "Attacked by my own dashboard" is a quotable frame and lowers the salesy feel.*

---

## Post 10 — Wrapped for Claude Code

> Made a Wrapped card for your Claude Code year.
>
> Sessions, tokens, spend, favorite tools, most active projects, one shareable image, all from local data. Built it for fun. It's also the easiest way to see a year of agent work in one glance.

`[VIDEO PLACEHOLDER: generate the Wrapped card, reveal the highlights, end on the shareable image.]`

*Why it can travel: "Wrapped" is a known format people love to share their own version of. If others post theirs, that's free distribution. Consider posting this near year-end for max effect.*

---

## Post 11 — why it's all local (the trust post)

> cc-lens reads your Claude Code data straight off disk and ships nothing anywhere. No account, no API key, no server.
>
> Your prompts and code are in those files. A dashboard that uploads them to "see your stats" is the opposite of what I want. `npx cc-lens` reads, renders, done. Stays on your machine.

`[VIDEO PLACEHOLDER: terminal, run npx cc-lens, dashboard opens, no login screen. Point at "no telemetry".]`

*Why it can travel: privacy is a values post that the audience strongly agrees with and amplifies. Good one to pin. Lower viral ceiling than the usage post, but high trust payoff.*

---

## 0.4.0 Release Campaign

A self-contained set for the 0.4.0 push: one roundup, then one standalone post per feature. More voice, more swagger, still honest. Same rule as everything above: each is its own tweet with its own video, not a thread. Insights and Wrapped also have evergreen versions earlier in this doc, the ones below are the release-framed cuts for the 0.4.0 moment.

### Post R0 — the release roundup

> cc-lens 0.4.0 is out and this one got obsessive about one question: what is Claude Code actually costing me, and where am I wasting it.
>
> - Insights that find the waste for you
> - Monthly budgets with spend-spike alerts
> - A `digest` command for the terminal diehards
> - Team adoption + MCP governance
> - And a Wrapped card, because obviously
>
> Still reads only your local `~/.claude/`. Still ships nothing anywhere. `npx cc-lens`

`[VIDEO PLACEHOLDER: 30s fast montage. Insights cards, budget pacing, digest in terminal, Wrapped card. End on the version number.]`

*Why it can travel: a release roundup is your one allowed "list" post. The framing ("got obsessive about where I'm wasting money") gives it a spine instead of being a changelog. Pin it as the 0.4.0 anchor.*

---

### Post R1 — Insights (the savings engine)

> New in cc-lens 0.4.0: I built a thing that reads my Claude Code history and tells me where I'm burning money for no reason.
>
> Low cache hit rate. Reaching for the expensive model on a two-message task. Compaction thrash. Wrong plan for how I actually use it. Each one comes with a dollar figure attached.
>
> It found stuff. I did not enjoy being right about myself.

`[VIDEO PLACEHOLDER: Insights page, scroll the detector cards, stop on one with a real dollar estimate and read it out.]`

*Why it can travel: "a tool that audits how you waste money on Claude Code" is a strong, specific hook. The self-roast last line is the personality. Dollar figures make it concrete.*

---

### Post R2 — Budgets and spike alerts

> Gave cc-lens a monthly budget in 0.4.0. Set a number, it paces you against it and tells you if you're trending over.
>
> The part I actually wanted: spend-spike detection. One day jumps way above your normal and it flags it, so a runaway agent loop doesn't quietly become your most expensive Tuesday ever.

`[VIDEO PLACEHOLDER: set a monthly budget, show the pacing projection, then point at a flagged daily spend spike.]`

*Why it can travel: "your most expensive Tuesday ever" is the relatable, slightly funny image of a runaway agent. Everyone's had one. The spike-alert framing is a real fear with a tidy fix.*

---

### Post R3 — the digest command

> For the people who live in the terminal: `cc-lens digest`.
>
> 0.4.0 added a one-liner that prints your Claude Code week right there in the shell. Spend, top projects, savings, budget pace, spike alerts. No browser, no dashboard, just the numbers where you already are. `--days` and `--team` flags if you want to slice it.

`[VIDEO PLACEHOLDER: clean terminal, type cc-lens digest, the formatted summary prints. Maybe show --days 7.]`

*Why it can travel: CLI people are a loud, loyal crowd that loves a clean terminal output shot. "No browser, just the numbers where you already are" is the exact pitch they bookmark.*

---

### Post R4 — team adoption view

> If your team runs Claude Code, 0.4.0 has something for you.
>
> cc-lens now shows per-member adoption: who's actually using plan mode, agents, skills, MCP, web, with cost per session and idle badges. Not for surveillance, for spotting who quietly figured out the workflow that everyone else should copy.

`[VIDEO PLACEHOLDER: Team adoption view, scroll members, hover the plan-mode / agents / MCP columns, point at an idle badge.]`

*Why it can travel: team leads and engineering managers are an underserved, high-intent audience here. The "find who cracked the workflow, not who to blame" framing keeps it positive and shareable instead of creepy.*

---

### Post R5 — MCP governance

> 0.4.0 adds an MCP server inventory across your team in cc-lens.
>
> Which servers are actually wired up, who's using them, all built from data already in the redacted exports. If you've ever wondered whether half your team forgot the MCP setup exists, now you can just look.

`[VIDEO PLACEHOLDER: MCP governance inventory on the Team page, scroll the server list and usage.]`

*Why it can travel: MCP is hot and under-tooled right now. "Governance" sounds dry, but "did half my team forget MCP exists" is the relatable version that lands. Niche but high-intent.*

---

### Post R6 — Wrapped (release cut)

> Sneaking this into 0.4.0: a Wrapped card for your Claude Code year.
>
> Sessions, tokens, spend, favorite tools, top projects, one downloadable image, all from local data. Built it for fun on a Friday. It's somehow the post I most want people to share their own version of.

`[VIDEO PLACEHOLDER: generate the Wrapped card, reveal the highlights, end on the downloadable image.]`

*Why it can travel: Wrapped is a format people love to post their own version of, which is free distribution if it catches. "Built it for fun on a Friday" is the builder-voice touch. Save it for a strong slot, ideally near year-end.*

---

## Backlog / future posts (drop a placeholder the day you start building)

- `[ ]` Authenticated mode that reads official remaining usage + reset times via API (replaces the estimate, closes the loop on the lead post)
- `[ ]` Import that actually merges back (today it's preview-only by design, that constraint is itself an honest post)
- `[ ]` Multiple-profile workflow (work vs personal `CLAUDE_CONFIG_DIR`)
- `[ ]` Team mode walkthrough
- `[ ]` Whatever you ship next

---

## Posting playbook

- **Each post ships on its own day as its own tweet + video.** They are independent, not a thread. Order is just a suggested calendar, not a dependency.
- **Order:** Lead with the usage gauge (Post 1), it's your strongest. Then space the rest out, one every 1–2 days. Don't dump them all at once.
- **Best slots:** the cost reveal (Post 4) and Wrapped (Post 10) are your other two viral shots. Don't post them back to back, stagger them between the quieter feature posts.
- **First reply:** on every post, drop the repo link + `npx cc-lens` as your own first reply.
- **If one pops:** quote-tweet or reply to your own viral post with the next standalone feature post. That borrows the attention without making the second one depend on the first.

## Recording checklist (per post)

- `[ ]` Clean terminal, large readable font
- `[ ]` Real data, but glance for anything private before recording (cc-lens reads your actual `~/.claude/`)
- `[ ]` 20–40 seconds, one feature, one point
- `[ ]` Say the pain first, then show the fix
- `[ ]` Fill in any [real number] placeholders from your own dashboard
- `[ ]` End on the dashboard, not on your face

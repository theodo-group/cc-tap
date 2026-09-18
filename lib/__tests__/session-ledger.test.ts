import { describe, it, expect } from 'vitest'
import { LedgerBuilder, NO_MODEL, ledgerMetrics, metricTokens, sessionMetrics, sliceSession, summarizeRange, type LedgeredSession } from '@/lib/session-ledger'
import { FALLBACK_MODEL, estimateTotalCostFromModel } from '@/lib/pricing'
import type { SessionMeta, SessionSlice } from '@/types/claude'

const T0 = Date.parse('2026-09-16T12:00:00Z')
const MIN = 60_000
const MODEL = 'claude-sonnet-4-5'

function meta(start: number, end: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: 's1', project_path: '/p',
    start_time: new Date(start).toISOString(), last_activity: new Date(end).toISOString(),
    duration_minutes: (end - start) / MIN,
    user_message_count: 0, assistant_message_count: 0, tool_counts: {}, languages: {},
    git_commits: 0, git_pushes: 0, input_tokens: 0, output_tokens: 0,
    first_prompt: '', user_interruptions: 0, user_response_times: [], tool_errors: 0,
    tool_error_categories: {}, uses_task_agent: false, uses_mcp: false, uses_web_search: false,
    uses_web_fetch: false, lines_added: 0, lines_removed: 0, files_modified: 0,
    message_hours: [], user_message_timestamps: [],
    ...extra,
  }
}

/** A session with one user message and one assistant turn every 10 minutes
 *  from start to end, each turn 100 in / 10 out / 1000 cache read, 2 tools. */
function regular(start: number, end: number, agentTurnsAt: number[] = []): LedgeredSession {
  const b = new LedgerBuilder()
  for (let t = start; t <= end; t += 10 * MIN) {
    b.addUser(t)
    b.addTurn({ ts: t + 1000, model: MODEL, input: 100, output: 10, cacheRead: 1000, cacheWrite: 0, toolCalls: 2 })
  }
  const agent = new LedgerBuilder()
  for (const t of agentTurnsAt) {
    agent.addTurn({ ts: t, model: NO_MODEL, input: 50, output: 5, cacheRead: 0, cacheWrite: 500, toolCalls: 1, isAgent: true })
  }
  if (agentTurnsAt.length) b.appendAgent(agent.build(), 'claude-haiku-4-5')
  return { session: meta(start, end), ledger: b.build() }
}

describe('sliceSession', () => {
  it('returns null when the session does not overlap the window', () => {
    const s = regular(T0, T0 + 60 * MIN)
    expect(sliceSession(s, { from: T0 + 2 * 3600_000, to: T0 + 3 * 3600_000 })).toBeNull()
    expect(sliceSession(s, { from: T0 - 3600_000, to: T0 - 1 })).toBeNull()
  })

  it('includes turns exactly at both bounds and excludes one ms outside', () => {
    const b = new LedgerBuilder()
    b.addTurn({ ts: T0 - 1, model: MODEL, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 })
    b.addTurn({ ts: T0, model: MODEL, input: 10, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 })
    b.addTurn({ ts: T0 + 3600_000, model: MODEL, input: 100, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 })
    b.addTurn({ ts: T0 + 3600_000 + 1, model: MODEL, input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 })
    b.addUser(T0); b.addUser(T0 + 3600_000 + 1)
    const s: LedgeredSession = { session: meta(T0 - 1, T0 + 3600_000 + 1), ledger: b.build() }
    const slice = sliceSession(s, { from: T0, to: T0 + 3600_000 })!
    expect(slice.input_tokens).toBe(110)
    expect(slice.assistant_message_count).toBe(2)
    expect(slice.user_message_count).toBe(1)
  })

  it('flags partial only when the session straddles a bound', () => {
    const s = regular(T0, T0 + 60 * MIN)
    expect(sliceSession(s, { from: T0, to: T0 + 60 * MIN })!.partial).toBe(false)
    expect(sliceSession(s, { from: T0 - MIN, to: T0 + 61 * MIN })!.partial).toBe(false)
    expect(sliceSession(s, { from: T0 + 30 * MIN, to: T0 + 5 * 3600_000 })!.partial).toBe(true)
    expect(sliceSession(s, { from: T0 - 3600_000, to: T0 + 30 * MIN })!.partial).toBe(true)
  })

  it('clamps duration to the window', () => {
    const s = regular(T0, T0 + 60 * MIN)
    expect(sliceSession(s, { from: T0 + 30 * MIN, to: T0 + 5 * 3600_000 })!.duration_minutes).toBe(30)
    expect(sliceSession(s, { from: T0 - 3600_000, to: T0 + 5 * 3600_000 })!.duration_minutes).toBe(60)
  })

  it('sums only the turns inside the window and prices them per model', () => {
    const s = regular(T0, T0 + 60 * MIN) // 7 turns: 0,10,...,60
    const slice = sliceSession(s, { from: T0 + 25 * MIN, to: T0 + 45 * MIN })! // turns at 30, 40
    expect(slice.input_tokens).toBe(200)
    expect(slice.output_tokens).toBe(20)
    expect(slice.cache_read_input_tokens).toBe(2000)
    expect(slice.tool_calls).toBe(4)
    expect(slice.user_message_count).toBe(2)
    expect(slice.assistant_message_count).toBe(2)
    expect(slice.model_usage[MODEL].inputTokens).toBe(200)
    expect(slice.estimated_cost).toBeCloseTo(estimateTotalCostFromModel(MODEL, slice.model_usage[MODEL]), 10)
    expect(slice.agents_tokens).toBe(0)
  })

  it('counts agent turns in tokens and agents_tokens but not in message or tool counts', () => {
    const s = regular(T0, T0 + 60 * MIN, [T0 + 31 * MIN, T0 + 32 * MIN, T0 + 59 * MIN])
    const slice = sliceSession(s, { from: T0 + 25 * MIN, to: T0 + 45 * MIN })!
    expect(slice.input_tokens).toBe(200 + 100)
    expect(slice.cache_creation_input_tokens).toBe(1000)
    expect(slice.agents_tokens).toBe(2 * (50 + 5 + 500))
    expect(slice.assistant_message_count).toBe(2)
    expect(slice.tool_calls).toBe(4)
    // model-less agent turns were attributed to the resolved model
    expect(slice.model_usage['claude-haiku-4-5'].inputTokens).toBe(100)
    expect(slice.agents_cost).toBeCloseTo(estimateTotalCostFromModel('claude-haiku-4-5', slice.model_usage['claude-haiku-4-5']), 10)
    expect(slice.estimated_cost).toBeGreaterThan(slice.agents_cost)
  })

  it('slices an overlapping session with no turn inside to zeros, not null', () => {
    const s = regular(T0, T0 + 60 * MIN)
    const slice = sliceSession(s, { from: T0 + 2 * MIN, to: T0 + 8 * MIN })!
    expect(slice).not.toBeNull()
    expect(slice.input_tokens).toBe(0)
    expect(slice.estimated_cost).toBe(0)
    expect(slice.user_message_count).toBe(0)
  })

  it('over the whole session equals the session-level metrics derived from the ledger', () => {
    const s = regular(T0, T0 + 60 * MIN, [T0 + 31 * MIN, T0 + 59 * MIN])
    const { agent_model_usage: _a, ...whole } = ledgerMetrics(s.ledger, null, 60)
    const slice = sliceSession(s, { from: T0 - 3600_000, to: T0 + 5 * 3600_000 })!
    const { from: _f, to: _t, partial, ...sliced } = slice
    expect(partial).toBe(false)
    expect(sliced).toEqual(whole)
  })
})

describe('ledgerMetrics', () => {
  it('leaves model-less turns out of model_usage and prices them at the fallback rate', () => {
    const b = new LedgerBuilder()
    b.addTurn({ ts: T0, model: NO_MODEL, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, toolCalls: 0 })
    const m = ledgerMetrics(b.build(), null, 1)
    expect(m.input_tokens).toBe(1000)
    expect(m.model_usage).toEqual({})
    expect(m.estimated_cost).toBeCloseTo(estimateTotalCostFromModel(FALLBACK_MODEL, {
      inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0,
    }), 10)
  })

  it('round-trips through the public session fields', () => {
    const s = regular(T0, T0 + 60 * MIN, [T0 + 31 * MIN])
    const m = ledgerMetrics(s.ledger, null, 60)
    const published = {
      ...s.session,
      input_tokens: m.input_tokens, output_tokens: m.output_tokens,
      cache_read_input_tokens: m.cache_read_input_tokens, cache_creation_input_tokens: m.cache_creation_input_tokens,
      user_message_count: m.user_message_count, assistant_message_count: m.assistant_message_count,
      tool_counts: { Bash: m.tool_calls },
      model_usage: m.model_usage, agent_model_usage: m.agent_model_usage,
      estimated_cost: m.estimated_cost,
    }
    const { agent_model_usage: _a, ...expected } = m
    expect(sessionMetrics(published)).toEqual(expected)
  })
})

describe('LedgerBuilder', () => {
  it('from() copies without sharing storage', () => {
    const a = regular(T0, T0 + 10 * MIN).ledger
    const b = LedgerBuilder.from(a)
    b.addTurn({ ts: T0 + 20 * MIN, model: MODEL, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 })
    expect(b.build().ts.length).toBe(a.ts.length + 1)
    expect(b.build().userTs.length).toBe(a.userTs.length)
  })

  it('from() can rename models while copying', () => {
    const b = new LedgerBuilder()
    b.addTurn({ ts: T0, model: NO_MODEL, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 })
    b.addTurn({ ts: T0 + 1, model: MODEL, input: 2, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 })
    const renamed = LedgerBuilder.from(b.build(), m => (m === NO_MODEL ? 'claude-haiku-4-5' : m)).build()
    const m = ledgerMetrics(renamed, null, 0)
    expect(m.model_usage['claude-haiku-4-5'].inputTokens).toBe(1)
    expect(m.model_usage[MODEL].inputTokens).toBe(2)
  })
})

function slice(extra: Partial<SessionSlice>): SessionSlice {
  return {
    from: T0, to: T0 + 60 * MIN, partial: false,
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    user_message_count: 0, assistant_message_count: 0, tool_calls: 0, duration_minutes: 0,
    agents_tokens: 0, agents_cost: 0, model_usage: {}, estimated_cost: 0,
    ...extra,
  }
}

describe('metricTokens', () => {
  it('sums the four token kinds', () => {
    expect(metricTokens(slice({ input_tokens: 1, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4000 }))).toBe(4321)
  })
})

describe('summarizeRange', () => {
  const w = { from: T0, to: T0 + 60 * MIN }

  it('reports an empty window as zero sessions, tokens and cost', () => {
    expect(summarizeRange(w, [])).toEqual({ from: w.from, to: w.to, sessions: 0, tokens: 0, cost: 0 })
  })

  it('counts slices and adds up their tokens and cost', () => {
    const slices = [
      slice({ input_tokens: 100, output_tokens: 10, estimated_cost: 0.5 }),
      slice({ cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, estimated_cost: 0.25 }),
    ]
    expect(summarizeRange(w, slices)).toEqual({ from: w.from, to: w.to, sessions: 2, tokens: 1160, cost: 0.75 })
  })

  it('matches sliceSession output for a real ledger', () => {
    const s = sliceSession(regular(T0, T0 + 60 * MIN), w)!
    const summary = summarizeRange(w, [s])
    expect(summary.sessions).toBe(1)
    expect(summary.tokens).toBe(metricTokens(s))
    expect(summary.cost).toBe(s.estimated_cost)
  })
})

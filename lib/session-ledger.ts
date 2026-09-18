import type { ModelUsage, SessionMeta, SessionMetrics, SessionSlice, SessionsRangeSummary } from '@/types/claude'
import { agentsCost, costOfUsage, sessionCost } from '@/lib/pricing'
import { intersectsWindow, type TimeWindow } from '@/lib/time-window'

// ─── Turn ledger ─────────────────────────────────────────────────────────────
//
// A compact per-turn record of a session, built in the same parse loop as
// the rest of the session and kept on the mtime-keyed parser caches. It is
// the single source of the session's token, model and message counters:
// the whole-session values are the ledger summed over every turn, and the
// sessions list can restrict them to an arbitrary time window (the
// subscription's 5h usage window, a pair of dates) without re-reading any
// JSONL or shipping per-turn data to the browser.

/** Model index used for assistant lines that carry no model name */
export const NO_MODEL = ''

export interface TurnLedger {
  /** parallel arrays, one entry per assistant line (orchestrator + agents) */
  ts: Float64Array          // ms since epoch
  model: Uint8Array         // index into `models`
  input: Float64Array
  output: Float64Array
  cacheRead: Float64Array
  cacheWrite: Float64Array
  toolCalls: Uint16Array    // tool_use blocks in that turn
  isAgent: Uint8Array       // 1 when from a sub-agent transcript
  models: string[]
  /** orchestrator user message timestamps, ms */
  userTs: Float64Array
}

/** Growable ledger used while streaming a transcript; `build()` freezes it. */
export class LedgerBuilder {
  private ts: number[] = []
  private model: number[] = []
  private input: number[] = []
  private output: number[] = []
  private cacheRead: number[] = []
  private cacheWrite: number[] = []
  private toolCalls: number[] = []
  private isAgent: number[] = []
  private userTs: number[] = []
  private models: string[] = []
  private modelIndex = new Map<string, number>()

  private indexOf(model: string): number {
    let i = this.modelIndex.get(model)
    if (i === undefined) {
      i = this.models.length
      this.models.push(model)
      this.modelIndex.set(model, i)
    }
    return i
  }

  addTurn(t: {
    ts: number; model: string; input: number; output: number
    cacheRead: number; cacheWrite: number; toolCalls: number; isAgent?: boolean
  }): void {
    if (!Number.isFinite(t.ts)) return
    this.ts.push(t.ts)
    this.model.push(this.indexOf(t.model))
    this.input.push(t.input)
    this.output.push(t.output)
    this.cacheRead.push(t.cacheRead)
    this.cacheWrite.push(t.cacheWrite)
    this.toolCalls.push(Math.min(t.toolCalls, 0xffff))
    this.isAgent.push(t.isAgent ? 1 : 0)
  }

  addUser(ts: number): void {
    if (Number.isFinite(ts)) this.userTs.push(ts)
  }

  /** Append every turn of another ledger, flagged as agent turns. Model
   *  `NO_MODEL` in the appended ledger is renamed to `unknownModel`, the way
   *  the fold attributes model-less agent messages. */
  appendAgent(l: TurnLedger, unknownModel: string): void {
    this.append(l, m => (m === NO_MODEL ? unknownModel : m), true)
  }

  private append(l: TurnLedger, rename: (model: string) => string, asAgent: boolean): void {
    const remap = l.models.map(m => this.indexOf(rename(m)))
    for (let i = 0; i < l.ts.length; i++) {
      this.ts.push(l.ts[i])
      this.model.push(remap[l.model[i]])
      this.input.push(l.input[i])
      this.output.push(l.output[i])
      this.cacheRead.push(l.cacheRead[i])
      this.cacheWrite.push(l.cacheWrite[i])
      this.toolCalls.push(l.toolCalls[i])
      this.isAgent.push(asAgent ? 1 : l.isAgent[i])
    }
  }

  build(): TurnLedger {
    return {
      ts: Float64Array.from(this.ts),
      model: Uint8Array.from(this.model),
      input: Float64Array.from(this.input),
      output: Float64Array.from(this.output),
      cacheRead: Float64Array.from(this.cacheRead),
      cacheWrite: Float64Array.from(this.cacheWrite),
      toolCalls: Uint16Array.from(this.toolCalls),
      isAgent: Uint8Array.from(this.isAgent),
      models: [...this.models],
      userTs: Float64Array.from(this.userTs),
    }
  }

  /** A builder pre-loaded with an existing ledger, for folding agents in.
   *  `rename` maps each model name of the copied ledger, so a model-less
   *  orchestrator can be bucketed under a fallback model before the fold. */
  static from(l: TurnLedger, rename: (model: string) => string = m => m): LedgerBuilder {
    const b = new LedgerBuilder()
    b.append(l, rename, false)
    b.userTs = Array.from(l.userTs)
    return b
  }
}

/** True when any orchestrator turn of the ledger names a model */
export function hasModeledTurns(l: TurnLedger): boolean {
  for (let i = 0; i < l.ts.length; i++) {
    if (l.isAgent[i] === 0 && l.models[l.model[i]] !== NO_MODEL) return true
  }
  return false
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export type { SessionMetrics, SessionSlice }

/** Whole-session or windowed metrics, plus the agent share of model usage
 *  that SessionMeta keeps in `agent_model_usage` */
export interface LedgerMetrics extends SessionMetrics {
  agent_model_usage: Record<string, ModelUsage>
}

function emptyUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0 }
}

function addUsage(target: Record<string, ModelUsage>, model: string, input: number, output: number, cacheRead: number, cacheWrite: number): void {
  const u = target[model] ?? (target[model] = emptyUsage())
  u.inputTokens += input; u.outputTokens += output; u.cacheReadInputTokens += cacheRead; u.cacheCreationInputTokens += cacheWrite
}

/**
 * Sum the ledger over the turns inside `w` (inclusive on both ends, like
 * `inWindow`; `null` means every turn). Turns without a model name count in
 * the token totals but not in `model_usage`, so pricing falls back to the
 * default model's rate when nothing is attributed.
 */
export function ledgerMetrics(l: TurnLedger, w: TimeWindow | null, durationMinutes: number): LedgerMetrics {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0
  let assistantCount = 0, toolCalls = 0, agentsTokens = 0
  const modelUsage: Record<string, ModelUsage> = {}
  const agentUsage: Record<string, ModelUsage> = {}

  for (let i = 0; i < l.ts.length; i++) {
    const t = l.ts[i]
    if (w && (t < w.from || t > w.to)) continue
    const agent = l.isAgent[i] === 1
    const ti = l.input[i], to = l.output[i], tr = l.cacheRead[i], tw = l.cacheWrite[i]
    input += ti; output += to; cacheRead += tr; cacheWrite += tw
    if (agent) {
      agentsTokens += ti + to + tr + tw
    } else {
      assistantCount++
      toolCalls += l.toolCalls[i]
    }
    const model = l.models[l.model[i]]
    if (model !== NO_MODEL) {
      addUsage(modelUsage, model, ti, to, tr, tw)
      if (agent) addUsage(agentUsage, model, ti, to, tr, tw)
    }
  }

  let userCount = 0
  for (let i = 0; i < l.userTs.length; i++) {
    const t = l.userTs[i]
    if (!w || (t >= w.from && t <= w.to)) userCount++
  }

  const totals = { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite }
  return {
    ...totals,
    user_message_count: userCount,
    assistant_message_count: assistantCount,
    tool_calls: toolCalls,
    duration_minutes: durationMinutes,
    agents_tokens: agentsTokens,
    agents_cost: costOfUsage(agentUsage),
    model_usage: modelUsage,
    agent_model_usage: agentUsage,
    estimated_cost: costOfUsage(modelUsage, totals),
  }
}

/** Whole-session metrics read back from a session's public fields, for
 *  consumers that hold a SessionMeta and no ledger (the browser). */
export function sessionMetrics(s: SessionMeta & { estimated_cost?: number }): SessionMetrics {
  let agentsTokens = 0
  for (const u of Object.values(s.agent_model_usage ?? {})) {
    agentsTokens += u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens
  }
  return {
    input_tokens: s.input_tokens ?? 0,
    output_tokens: s.output_tokens ?? 0,
    cache_read_input_tokens: s.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: s.cache_creation_input_tokens ?? 0,
    user_message_count: s.user_message_count ?? 0,
    assistant_message_count: s.assistant_message_count ?? 0,
    tool_calls: Object.values(s.tool_counts ?? {}).reduce((a, c) => a + c, 0),
    duration_minutes: s.duration_minutes ?? 0,
    agents_tokens: agentsTokens,
    agents_cost: agentsCost(s),
    model_usage: s.model_usage ?? {},
    estimated_cost: s.estimated_cost ?? sessionCost(s),
  }
}

/** Tokens of every kind in a set of metrics */
export function metricTokens(m: SessionMetrics): number {
  return m.input_tokens + m.output_tokens + m.cache_read_input_tokens + m.cache_creation_input_tokens
}

// ─── Slicing ─────────────────────────────────────────────────────────────────

/** A session together with its ledger, the server-side record */
export interface LedgeredSession<S extends SessionMeta = SessionMeta> {
  session: S
  ledger: TurnLedger
}

/**
 * Restrict a session to the turns inside `w`. Returns null when the session
 * does not overlap the window at all. A session that overlaps but has no
 * turn inside slices to zeros.
 */
export function sliceSession({ session: s, ledger }: LedgeredSession, w: TimeWindow): SessionSlice | null {
  const start = new Date(s.start_time).getTime()
  const end = s.last_activity ? new Date(s.last_activity).getTime() : start
  if (!intersectsWindow(start, end, w)) return null

  const partial = start < w.from || end > w.to
  const durationMinutes = Math.max(0, Math.min(end, w.to) - Math.max(start, w.from)) / 60_000
  const { agent_model_usage: _agents, ...metrics } = ledgerMetrics(ledger, w, durationMinutes)
  return { from: w.from, to: w.to, partial, ...metrics }
}

/** Roll-up of the slices that fell inside a window: the `range` of
 *  GET /api/sessions?from&to */
export function summarizeRange(w: TimeWindow, slices: SessionSlice[]): SessionsRangeSummary {
  let tokens = 0
  let cost = 0
  for (const s of slices) {
    tokens += metricTokens(s)
    cost += s.estimated_cost
  }
  return { from: w.from, to: w.to, sessions: slices.length, tokens, cost }
}

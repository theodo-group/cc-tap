import type { ModelUsage, ReportedCost, SessionMeta, SessionMetrics, SessionSlice, SessionsRangeSummary } from '@/types/claude'
import { agentsCost, costOfUsage, estimateTotalCostFromModel, requestMultiplier, sessionCost, type RequestTerms } from '@/lib/pricing'
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
  /** parallel arrays, one entry per API response (orchestrator + agents): the
   *  lines of one response are folded into one turn (lib/response-usage.ts) */
  ts: Float64Array          // ms since epoch
  model: Uint8Array         // index into `models`
  input: Float64Array
  output: Float64Array
  cacheRead: Float64Array
  cacheWrite: Float64Array
  cacheWrite1h: Float64Array // the part of cacheWrite that went to the 1-hour cache, priced higher
  toolCalls: Uint16Array    // tool_use blocks in that turn
  isAgent: Uint8Array       // 1 when from a sub-agent transcript
  terms: Uint8Array         // TERM_FAST | TERM_US: how the request was served, priced by requestMultiplier
  models: string[]
  /** orchestrator user message timestamps, ms */
  userTs: Float64Array
}

export const TERM_FAST = 1
export const TERM_US = 2

/** A usage's request terms as ledger flags */
export function termsFlags(usage: Record<string, unknown> | undefined): number {
  return (usage?.speed === 'fast' ? TERM_FAST : 0) | (usage?.inference_geo === 'us' ? TERM_US : 0)
}

function flagsTerms(flags: number): RequestTerms {
  return { speed: flags & TERM_FAST ? 'fast' : undefined, inferenceGeo: flags & TERM_US ? 'us' : undefined }
}

/** Growable ledger used while streaming a transcript; `build()` freezes it. */
export class LedgerBuilder {
  private ts: number[] = []
  private model: number[] = []
  private input: number[] = []
  private output: number[] = []
  private cacheRead: number[] = []
  private cacheWrite: number[] = []
  private cacheWrite1h: number[] = []
  private toolCalls: number[] = []
  private isAgent: number[] = []
  private terms: number[] = []
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

  /** Appends a turn (one API response) and returns its index, or -1 when it has no usable time. */
  addTurn(t: {
    ts: number; model: string; input: number; output: number
    cacheRead: number; cacheWrite: number; cacheWrite1h?: number; toolCalls: number; isAgent?: boolean
    /** termsFlags of the response's usage */
    terms?: number
  }): number {
    if (!Number.isFinite(t.ts)) return -1
    this.ts.push(t.ts)
    this.model.push(this.indexOf(t.model))
    this.input.push(t.input)
    this.output.push(t.output)
    this.cacheRead.push(t.cacheRead)
    this.cacheWrite.push(t.cacheWrite)
    this.cacheWrite1h.push(t.cacheWrite1h ?? 0)
    this.toolCalls.push(Math.min(t.toolCalls, 0xffff))
    this.isAgent.push(t.isAgent ? 1 : 0)
    this.terms.push(t.terms ?? 0)
    return this.ts.length - 1
  }

  /** Adds a later line of the same response to turn `i`: its token growth and its tool calls. */
  growTurn(i: number, d: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; toolCalls: number }): void {
    if (i < 0 || i >= this.ts.length) return
    this.input[i] += d.input
    this.output[i] += d.output
    this.cacheRead[i] += d.cacheRead
    this.cacheWrite[i] += d.cacheWrite
    this.cacheWrite1h[i] += d.cacheWrite1h ?? 0
    this.toolCalls[i] = Math.min(this.toolCalls[i] + d.toolCalls, 0xffff)
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
      this.cacheWrite1h.push(l.cacheWrite1h[i])
      this.toolCalls.push(l.toolCalls[i])
      this.isAgent.push(asAgent ? 1 : l.isAgent[i])
      this.terms.push(l.terms[i])
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
      cacheWrite1h: Float64Array.from(this.cacheWrite1h),
      toolCalls: Uint16Array.from(this.toolCalls),
      isAgent: Uint8Array.from(this.isAgent),
      terms: Uint8Array.from(this.terms),
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

function addUsage(target: Record<string, ModelUsage>, model: string, input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number): void {
  const u = target[model] ?? (target[model] = emptyUsage())
  u.inputTokens += input; u.outputTokens += output; u.cacheReadInputTokens += cacheRead; u.cacheCreationInputTokens += cacheWrite
  u.cacheCreation1hInputTokens = (u.cacheCreation1hInputTokens ?? 0) + cacheWrite1h
}

/**
 * The multiplier that turns each model's table estimate into its share of
 * Claude Code's reported cost: that model's reported cost over its estimate
 * for the whole session, then one factor for the whole session so the models
 * add up to the reported total (it holds calls the transcripts never show:
 * session titles, side requests). Null when nothing in the ledger is priced.
 */
function calibration(whole: Record<string, number>, reported: ReportedCost): ((model: string) => number) | null {
  const factor: Record<string, number> = {}
  let calibrated = 0
  for (const [model, estimate] of Object.entries(whole)) {
    const own = reported.by_model[model]
    factor[model] = own !== undefined && own > 0 && estimate > 0 ? own / estimate : 1
    calibrated += estimate * factor[model]
  }
  if (calibrated <= 0) return null
  const scale = reported.total / calibrated
  return model => (factor[model] ?? 1) * scale
}

/** Turn `i` at the table's rates */
function turnEstimate(l: TurnLedger, i: number, model: string): number {
  return estimateTotalCostFromModel(model, {
    inputTokens: l.input[i], outputTokens: l.output[i], cacheReadInputTokens: l.cacheRead[i],
    cacheCreationInputTokens: l.cacheWrite[i], cacheCreation1hInputTokens: l.cacheWrite1h[i],
    costUSD: 0, webSearchRequests: 0,
  })
}

/** Turn `i`'s requestMultiplier: its request terms, and its prompt length */
function turnMultiplier(l: TurnLedger, i: number, model: string): number {
  return requestMultiplier(model, l.input[i] + l.cacheRead[i] + l.cacheWrite[i], flagsTerms(l.terms[i]))
}

/** What turn `i` costs over its table estimate: its request terms or a long
 *  prompt make the whole request dearer */
function turnPremium(l: TurnLedger, i: number, model: string): number {
  const m = turnMultiplier(l, i, model)
  return m === 1 ? 0 : turnEstimate(l, i, model) * (m - 1)
}

/** A whole ledger's cost, each turn at its own model's rates and terms; turns
 *  without a model are priced as `unknownModel` */
export function ledgerCost(l: TurnLedger, unknownModel: string): number {
  let total = 0
  for (let i = 0; i < l.ts.length; i++) {
    const model = l.models[l.model[i]] || unknownModel
    total += turnEstimate(l, i, model) * turnMultiplier(l, i, model)
  }
  return total
}

/** Each model's cost before calibration: the table's estimate of its tokens plus its turns' premiums */
function estimates(usage: Record<string, ModelUsage>, premium: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [model, u] of Object.entries(usage)) out[model] = estimateTotalCostFromModel(model, u) + (premium[model] ?? 0)
  return out
}

/** Sets costUSD on every model of `usage`: its estimate, times `scale` */
function price(usage: Record<string, ModelUsage>, estimate: Record<string, number>, scale: (model: string) => number): void {
  for (const [model, u] of Object.entries(usage)) u.costUSD = (estimate[model] ?? 0) * scale(model)
}

/** Each model's costUSD, from usage priced without calibration */
function costsOf(usage: Record<string, ModelUsage>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [model, u] of Object.entries(usage)) out[model] = u.costUSD
  return out
}

/**
 * Sum the ledger over the turns inside `w` (inclusive on both ends, like
 * `inWindow`; `null` means every turn). Turns without a model name count in
 * the token totals but not in `model_usage`, so pricing falls back to the
 * default model's rate when nothing is attributed.
 *
 * Each model's costUSD is the table's estimate, or with `reported` (the cost
 * Claude Code wrote for the whole session), that cost spread over the turns in
 * proportion to their estimate: the whole session then costs exactly what
 * Claude Code reported, and a window its share of it.
 */
export function ledgerMetrics(l: TurnLedger, w: TimeWindow | null, durationMinutes: number, reported: ReportedCost | null = null): LedgerMetrics {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0
  let assistantCount = 0, toolCalls = 0, agentsTokens = 0
  const modelUsage: Record<string, ModelUsage> = {}
  const agentUsage: Record<string, ModelUsage> = {}
  const premium: Record<string, number> = {}
  const agentPremium: Record<string, number> = {}

  for (let i = 0; i < l.ts.length; i++) {
    const t = l.ts[i]
    if (w && (t < w.from || t > w.to)) continue
    const agent = l.isAgent[i] === 1
    const ti = l.input[i], to = l.output[i], tr = l.cacheRead[i], tw = l.cacheWrite[i], tw1h = l.cacheWrite1h[i]
    input += ti; output += to; cacheRead += tr; cacheWrite += tw
    if (agent) {
      agentsTokens += ti + to + tr + tw
    } else {
      assistantCount++
      toolCalls += l.toolCalls[i]
    }
    const model = l.models[l.model[i]]
    if (model !== NO_MODEL) {
      addUsage(modelUsage, model, ti, to, tr, tw, tw1h)
      if (agent) addUsage(agentUsage, model, ti, to, tr, tw, tw1h)
      const extra = turnPremium(l, i, model)
      if (extra > 0) {
        premium[model] = (premium[model] ?? 0) + extra
        if (agent) agentPremium[model] = (agentPremium[model] ?? 0) + extra
      }
    }
  }

  let userCount = 0
  for (let i = 0; i < l.userTs.length; i++) {
    const t = l.userTs[i]
    if (!w || (t >= w.from && t <= w.to)) userCount++
  }

  const estimate = estimates(modelUsage, premium)
  const wholeEstimate = w ? costsOf(ledgerMetrics(l, null, durationMinutes).model_usage) : estimate
  const calibrated = reported && calibration(wholeEstimate, reported)
  price(modelUsage, estimate, calibrated || (() => 1))
  price(agentUsage, estimates(agentUsage, agentPremium), calibrated || (() => 1))
  // Claude Code billed only calls no transcript line shows (a session title): that is the whole session
  if (reported && !calibrated && !w) {
    for (const [model, cost] of Object.entries(reported.by_model)) (modelUsage[model] ??= emptyUsage()).costUSD = cost
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
  const { agent_model_usage: _agents, ...metrics } = ledgerMetrics(ledger, w, durationMinutes, s.reported_cost ?? null)
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

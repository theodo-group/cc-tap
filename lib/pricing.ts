import type { TurnUsage, ModelUsage, SessionMeta, UnpricedModel } from '@/types/claude'
import { parseModel } from '@/lib/model-label'

interface ModelPricing {
  input: number
  output: number
  /** 5-minute cache write, 1.25× input */
  cacheWrite: number
  /** 1-hour cache write; 2× input when an entry does not name it */
  cacheWrite1h?: number
  cacheRead: number
  /** fast mode (`usage.speed: "fast"`) bills every rate at this multiple; no fast mode when absent */
  fast?: number
  /** a request whose prompt (input + cache reads + cache writes) is over `tokens` bills every rate at `multiplier`× */
  longPrompt?: { tokens: number; multiplier: number }
}

// Vendored defaults — values are $ per million tokens. cacheWrite is the
// 5-minute ephemeral rate; a 1-hour write costs 2× input on every model
// (cacheWrite1h), and Claude Code writes its main thread to the 1-hour cache.
// Fast mode, US-only inference and long Haiku 5.5 prompts multiply a whole
// request (requestMultiplier). Users can override via ~/.cc-lens/pricing.json.
// Source: platform.claude.com/docs/en/about-claude/pricing as of 2026-10.
const DEFAULT_PRICING_PER_MTOK: Record<string, ModelPricing> = {
  // Fable 5.1 — $10 / $50, cache reads cut to $0.25 (vs 10% of input elsewhere)
  'claude-fable-5-1':  { input: 10.00, output: 50.00, cacheWrite: 12.50, cacheRead: 0.25 },
  // Fable 5 — $10 / $50
  'claude-fable-5':    { input: 10.00, output: 50.00, cacheWrite: 12.50, cacheRead: 1.00 },
  // Mythos 5.1 / 5 (limited access) — Fable's rates
  'claude-mythos-5-1': { input: 10.00, output: 50.00, cacheWrite: 12.50, cacheRead: 0.25 },
  'claude-mythos-5':   { input: 10.00, output: 50.00, cacheWrite: 12.50, cacheRead: 1.00 },
  // Opus 5.5 — $4 / $20, cache reads $0.20 (vs 10% of input elsewhere); fast mode $8 / $40
  'claude-opus-5-5':   { input: 4.00, output: 20.00, cacheWrite: 5.00,  cacheRead: 0.20, fast: 2 },
  // Opus 5 — $5 / $25; fast mode $10 / $50
  'claude-opus-5':     { input: 5.00, output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50, fast: 2 },
  // Opus 4.x current generation — $5 / $25; 4.8 fast mode $10 / $50
  'claude-opus-4-8':   { input: 5.00, output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50, fast: 2 },
  'claude-opus-4-7':   { input: 5.00, output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-opus-4-6':   { input: 5.00, output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-opus-4-5':   { input: 5.00, output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50 },
  // Opus 4.1 / 4.0 — legacy $15 / $75
  'claude-opus-4-1':   { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4':     { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  // Sonnet 5.5 — $2 / $10, cache reads $0.10 (vs 10% of input elsewhere)
  'claude-sonnet-5-5': { input: 2.00, output: 10.00, cacheWrite: 2.50,  cacheRead: 0.10 },
  // Sonnet 5 — $2 / $10
  'claude-sonnet-5':   { input: 2.00, output: 10.00, cacheWrite: 2.50,  cacheRead: 0.20 },
  // Sonnet 4.x — $3 / $15
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-4':   { input: 3.00, output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  // Haiku 5.5 — $0.10 / $0.50, and $0.50 / $2.50 for a prompt over 100K tokens
  'claude-haiku-5-5':  { input: 0.10, output:  0.50, cacheWrite: 0.125, cacheRead: 0.01, longPrompt: { tokens: 100_000, multiplier: 5 } },
  // Haiku 4.5 — $1 / $5
  'claude-haiku-4-5':  { input: 1.00, output:  5.00, cacheWrite: 1.25,  cacheRead: 0.10 },
  // Haiku 3.5 — retired, $0.80 / $4
  'claude-haiku-3-5':  { input: 0.80, output:  4.00, cacheWrite: 1.00,  cacheRead: 0.08 },
}

/** Per-token rates; the request modifiers (fast, longPrompt) stay as they are */
type TokenPricing = Required<Pick<ModelPricing, 'input' | 'output' | 'cacheWrite' | 'cacheWrite1h' | 'cacheRead'>> & Pick<ModelPricing, 'fast' | 'longPrompt'>

function toPerToken(p: ModelPricing): TokenPricing {
  return {
    input:        p.input      / 1_000_000,
    output:       p.output     / 1_000_000,
    cacheWrite:   p.cacheWrite / 1_000_000,
    cacheWrite1h: (p.cacheWrite1h ?? p.input * 2) / 1_000_000,
    cacheRead:    p.cacheRead  / 1_000_000,
    fast:         p.fast,
    longPrompt:   p.longPrompt,
  }
}

function isLongPrompt(v: unknown): boolean {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o === 'object' && typeof o.tokens === 'number' && typeof o.multiplier === 'number'
}

function isValidEntry(v: unknown): v is ModelPricing {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.input      === 'number' &&
    typeof o.output     === 'number' &&
    typeof o.cacheWrite === 'number' &&
    (o.cacheWrite1h === undefined || typeof o.cacheWrite1h === 'number') &&
    typeof o.cacheRead  === 'number' &&
    (o.fast === undefined || typeof o.fast === 'number') &&
    (o.longPrompt === undefined || isLongPrompt(o.longPrompt))
  )
}

// Loads ~/.cc-lens/pricing.json if present. Server-side only; cached for
// process lifetime. Values are merged into defaults, so a user can override
// a single model or add new ones without restating the rest.
function loadUserOverrides(): Record<string, ModelPricing> {
  if (typeof window !== 'undefined') return {}
  try {
    // Use eval to keep these out of any client bundle that might import this
    // file by accident. They only run server-side.
    const os   = eval('require')('os')   as typeof import('os')
    const path = eval('require')('path') as typeof import('path')
    const fs   = eval('require')('fs')   as typeof import('fs')

    const configDir = process.env.CC_LENS_CONFIG_DIR ?? path.join(os.homedir(), '.cc-lens')
    const file = path.join(configDir, 'pricing.json')
    if (!fs.existsSync(file)) return {}

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const out: Record<string, ModelPricing> = {}
    for (const [model, entry] of Object.entries(raw)) {
      if (isValidEntry(entry)) {
        out[model] = entry
      } else {
        console.warn(`[cc-lens] pricing.json: skipping invalid entry for "${model}"`)
      }
    }
    return out
  } catch (err) {
    console.warn('[cc-lens] failed to load pricing.json:', (err as Error).message)
    return {}
  }
}

let cachedPricing: Record<string, TokenPricing> | null = null
// Table keys, longest first, so date-suffixed IDs resolve to the most specific
// entry (claude-opus-4-5-20251101 → claude-opus-4-5, while
// claude-opus-4-20250514 falls through to claude-opus-4's legacy rate).
let cachedKeysLongestFirst: string[] = []
function getPricingTable(): Record<string, TokenPricing> {
  if (cachedPricing) return cachedPricing
  const merged: Record<string, ModelPricing> = { ...DEFAULT_PRICING_PER_MTOK, ...loadUserOverrides() }
  const perToken: Record<string, TokenPricing> = {}
  for (const [k, v] of Object.entries(merged)) perToken[k] = toPerToken(v)
  cachedPricing = perToken
  cachedKeysLongestFirst = Object.keys(perToken).sort((a, b) => b.length - a.length)
  return perToken
}

// Back-compat export — some callers may have imported PRICING directly.
export const PRICING: Record<string, TokenPricing> = new Proxy({} as Record<string, TokenPricing>, {
  get:           (_, k: string)        => getPricingTable()[k],
  has:           (_, k: string)        => k in getPricingTable(),
  ownKeys:       ()                    => Reflect.ownKeys(getPricingTable()),
  getOwnPropertyDescriptor: (_, k: string) => Object.getOwnPropertyDescriptor(getPricingTable(), k),
})

/** Exact match, or the key followed by a real suffix segment — so
 *  claude-opus-4-5-20251101 matches claude-opus-4-5, but a hypothetical
 *  claude-opus-4-50 does not. */
function matchesPricingKey(model: string, key: string): boolean {
  return model === key || model.startsWith(`${key}-`)
}

/** Priced when no model is known: an unrecognised id, or a session whose assistant lines carry no model */
export const FALLBACK_MODEL = 'claude-opus-4-8'

/** The pricing entry whose rates this model is charged at: its own, the
 *  longest prefix entry, or FALLBACK_MODEL when nothing matches. */
export function pricedAs(model: string): string {
  const table = getPricingTable()
  if (table[model]) return model
  return cachedKeysLongestFirst.find(key => matchesPricingKey(model, key)) ?? FALLBACK_MODEL
}

/** True when the table has an entry for this model's own release, so its
 *  cost is not an estimate. A prefix entry only counts when it names the
 *  same release: claude-opus-4-5-20251101 is claude-opus-4-5's, while
 *  claude-opus-5-5 merely borrows claude-opus-5's rates. */
export function hasKnownPricing(model: string): boolean {
  const table = getPricingTable()
  if (table[model]) return true
  const release = parseModel(model)
  return cachedKeysLongestFirst.some(key => {
    if (!matchesPricingKey(model, key)) return false
    const keyRelease = parseModel(key)
    return !release || !keyRelease ||
      (release.family === keyRelease.family && release.version === keyRelease.version)
  })
}

/** The models of a usage map that hasKnownPricing rejects, with the entry each was charged at */
export function unpricedModels(usage: Record<string, ModelUsage> | undefined): UnpricedModel[] {
  return Object.keys(usage ?? {})
    .filter(model => model !== '<synthetic>' && !hasKnownPricing(model))
    .map(model => ({ model, priced_as: pricedAs(model) }))
}

function getPricing(model: string): TokenPricing {
  return getPricingTable()[pricedAs(model)]
}

/** A cache write, its 1-hour part at the 1-hour rate and the rest at the 5-minute one */
function cacheWriteCost(p: TokenPricing, written: number, oneHour: number): number {
  const hour = Math.min(Math.max(oneHour, 0), written)
  return (written - hour) * p.cacheWrite + hour * p.cacheWrite1h
}

/** Usage at the table's rates, with no request modifier: see requestCost for one request */
export function estimateCostFromUsage(model: string, usage: TurnUsage): number {
  const p = getPricing(model)
  return (
    (usage.input_tokens                ?? 0) * p.input      +
    (usage.output_tokens               ?? 0) * p.output     +
    cacheWriteCost(p, usage.cache_creation_input_tokens ?? 0, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
    (usage.cache_read_input_tokens     ?? 0) * p.cacheRead
  )
}

/** US-only inference (`inference_geo: "us"`, Claude 4.6 and later) bills every rate at 1.1× */
const US_INFERENCE = 1.1

/** How a request was served, as its usage records it */
export interface RequestTerms {
  /** `usage.speed`: "fast" for fast mode */
  speed?: string
  /** `usage.inference_geo`: "us" for US-only inference */
  inferenceGeo?: string
}

/** What one request costs as a multiple of the table's rates: fast mode, US-only
 *  inference, and a prompt over the model's long-prompt threshold. Every modifier
 *  applies to all of a request's tokens, cache reads and writes included. */
export function requestMultiplier(model: string, promptTokens: number, terms: RequestTerms = {}): number {
  const p = getPricing(model)
  let m = 1
  if (terms.speed === 'fast' && p.fast) m *= p.fast
  if (terms.inferenceGeo === 'us') m *= US_INFERENCE
  if (p.longPrompt && promptTokens > p.longPrompt.tokens) m *= p.longPrompt.multiplier
  return m
}

/** One request's cost: its usage at the table's rates, times its requestMultiplier */
export function requestCost(model: string, usage: TurnUsage): number {
  const prompt = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  return estimateCostFromUsage(model, usage) * requestMultiplier(model, prompt, { speed: usage.speed, inferenceGeo: usage.inference_geo })
}

export interface CacheEfficiencyResult {
  savedUSD: number
  hitRate: number
  wouldHavePaidUSD: number
}

export function cacheEfficiency(
  model: string,
  usage: ModelUsage,
): CacheEfficiencyResult {
  const p = getPricing(model)
  const savedPerToken = p.input - p.cacheRead
  const savedUSD = usage.cacheReadInputTokens * savedPerToken
  const totalContext = usage.inputTokens + usage.cacheReadInputTokens
  const hitRate = totalContext > 0
    ? usage.cacheReadInputTokens / totalContext
    : 0
  // No-cache baseline: without prompt caching, the tokens that were written to
  // cache would simply be sent as ordinary input on each call, billed at the
  // input rate — not the (higher) cache-write rate. Pricing them at cacheWrite
  // here would inflate the baseline by the ~25% write premium and understate
  // the savings figure. See issue #12.
  const wouldHavePaidUSD =
    (usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens) * p.input +
    usage.outputTokens * p.output
  return { savedUSD, hitRate, wouldHavePaidUSD }
}

export function estimateTotalCostFromModel(model: string, usage: ModelUsage): number {
  const p = getPricing(model)
  return (
    (usage.inputTokens                ?? 0) * p.input      +
    (usage.outputTokens               ?? 0) * p.output     +
    cacheWriteCost(p, usage.cacheCreationInputTokens ?? 0, usage.cacheCreation1hInputTokens ?? 0) +
    (usage.cacheReadInputTokens       ?? 0) * p.cacheRead
  )
}

/** A model's cost: the costUSD its usage carries (Claude Code's figure, or the
 *  table's already applied by the ledger), else the table's estimate */
export function usageCost(model: string, usage: ModelUsage): number {
  return usage.costUSD > 0 ? usage.costUSD : estimateTotalCostFromModel(model, usage)
}

/** Plain token totals, the SessionMeta field names */
export interface TokenTotals {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * Price per-model usage. When nothing is attributed to a model, `totals`
 * (if given) are priced at the fallback model's rate, the best guess for
 * transcripts whose assistant lines carry no model name.
 */
export function costOfUsage(modelUsage: Record<string, ModelUsage> | undefined, totals?: TokenTotals): number {
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    let total = 0
    for (const [model, usage] of Object.entries(modelUsage)) total += usageCost(model, usage)
    return total
  }
  if (!totals) return 0
  return estimateTotalCostFromModel(FALLBACK_MODEL, {
    inputTokens: totals.input_tokens ?? 0,
    outputTokens: totals.output_tokens ?? 0,
    cacheCreationInputTokens: totals.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: totals.cache_read_input_tokens ?? 0,
    costUSD: 0,
    webSearchRequests: 0,
  })
}

/** Whole-session cost: per-model usage when known, else the totals at the fallback rate */
export function sessionCost(s: SessionMeta): number {
  return costOfUsage(s.model_usage, s)
}

/** The part of sessionCost() spent inside sub-agent transcripts */
export function agentsCost(s: Pick<SessionMeta, 'agent_model_usage'>): number {
  return costOfUsage(s.agent_model_usage)
}

export { getPricing }
export type { ModelPricing }

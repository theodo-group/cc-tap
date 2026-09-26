/** Per-model context window sizes, used by the Context tab to show a percentage of the maximum. */

// Vendored defaults, in tokens. Opus and Fable run with the 1M window almost
// always; Sonnet and Haiku stay at 200k. A session log never records which
// window was negotiated, so these are the best guess — override a model in
// ~/.cc-lens/context.json for the rare session that ran at another size.
const DEFAULT_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus':   1_000_000,
  'claude-fable':  1_000_000,
  'claude-sonnet':   200_000,
  'claude-haiku':    200_000,
}

/** Used for a model with no entry at all */
export const FALLBACK_CONTEXT_LIMIT = 200_000

export type ContextLimits = Record<string, number>

/** Exact match, or the key followed by a real suffix segment — so claude-opus-5
 *  matches claude-opus, while a hypothetical claude-opusx does not. */
function matchesLimitKey(model: string, key: string): boolean {
  return model === key || model.startsWith(`${key}-`)
}

/** The context window of a model, in tokens. Longest key wins, so a specific
 *  entry beats the family entry it sits under. */
export function contextLimit(model: string | undefined, table: ContextLimits): number {
  if (!model) return FALLBACK_CONTEXT_LIMIT
  if (table[model]) return table[model]
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (matchesLimitKey(model, key)) return table[key]
  }
  return FALLBACK_CONTEXT_LIMIT
}

function isValidEntry(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/** Loads ~/.cc-lens/context.json if present. Server-side only; cached for the
 *  process lifetime. Values merge into the defaults, so a user can override a
 *  single model without restating the rest. */
function loadUserOverrides(): ContextLimits {
  if (typeof window !== 'undefined') return {}
  try {
    // eval keeps these out of any client bundle that imports this file by accident
    const os   = eval('require')('os')   as typeof import('os')
    const path = eval('require')('path') as typeof import('path')
    const fs   = eval('require')('fs')   as typeof import('fs')

    const configDir = process.env.CC_LENS_CONFIG_DIR ?? path.join(os.homedir(), '.cc-lens')
    const file = path.join(configDir, 'context.json')
    if (!fs.existsSync(file)) return {}

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const out: ContextLimits = {}
    for (const [model, entry] of Object.entries(raw)) {
      if (isValidEntry(entry)) out[model] = entry
      else console.warn(`[cc-lens] context.json: skipping invalid entry for "${model}"`)
    }
    return out
  } catch (err) {
    console.warn('[cc-lens] failed to load context.json:', (err as Error).message)
    return {}
  }
}

let cached: ContextLimits | null = null

/** Defaults merged with the user overrides. Server-side. */
export function getContextLimits(): ContextLimits {
  if (cached) return cached
  cached = { ...DEFAULT_CONTEXT_LIMITS, ...loadUserOverrides() }
  return cached
}

/** Test seam */
export function resetContextLimitsCache(): void { cached = null }

export { DEFAULT_CONTEXT_LIMITS }

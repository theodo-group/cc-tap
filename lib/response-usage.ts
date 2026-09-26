// One API response, one usage.
//
// Claude Code writes one transcript line per content block of an API response
// (thinking, text, each tool_use), and every one of those lines repeats the
// response's `message.usage`. Early lines can even carry an intermediate
// snapshot, with a lower `output_tokens` than the final one. Summed line by
// line, a response counts once per block: over 40 recent transcripts, 2 130
// responses were written as 5 213 assistant lines, 2.45 on average, each
// repeating its response's usage.
//
// A response is keyed by `message.id`, plus `requestId` when the line has one.
// Its usage is the per-field max over its lines, as ccusage, claude-devtools and
// tokscale count it. A line without `message.id` (older transcripts, hand-written
// fixtures) is a response of its own.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLine = Record<string, any>

export type UsageFields = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
  [other: string]: unknown
}

const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const
const SPLIT = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'] as const

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The response a line belongs to, or null when it cannot tell. */
export function responseKey(line: AnyLine): string | null {
  const id = line?.message?.id
  if (typeof id !== 'string' || id === '') return null
  return typeof line.requestId === 'string' && line.requestId ? `${id}:${line.requestId}` : id
}

/** Per-field max of two usages of one response; `b`'s other fields win. */
export function maxUsage<T extends UsageFields>(a: T, b: T): T {
  const out: UsageFields = { ...a, ...b }
  for (const f of FIELDS) {
    if (a[f] !== undefined || b[f] !== undefined) out[f] = Math.max(num(a[f]), num(b[f]))
  }
  if (a.cache_creation || b.cache_creation) {
    const split: Record<string, number> = {}
    for (const f of SPLIT) split[f] = Math.max(num(a.cache_creation?.[f]), num(b.cache_creation?.[f]))
    out.cache_creation = split
  }
  return out as T
}

/** What `b` adds over `a`, field by field (never negative). */
function growth(a: UsageFields, b: UsageFields): UsageFields {
  const out: UsageFields = {}
  for (const f of FIELDS) out[f] = Math.max(0, num(b[f]) - num(a[f]))
  return out
}

/**
 * Running totals over a transcript read line by line. `add` says whether a line
 * starts a response, and what it adds to the totals: its whole usage when it
 * does, the growth over what its response already counted when it does not.
 * Adding every `delta` gives each response once, at its per-field max.
 */
export class ResponseTracker {
  private seen = new Map<string, UsageFields>()

  add(line: AnyLine, usage: UsageFields | undefined): { isNew: boolean; delta: UsageFields } {
    const current = usage ?? {}
    const key = responseKey(line)
    if (key === null) return { isNew: true, delta: current }
    const before = this.seen.get(key)
    if (!before) {
      this.seen.set(key, current)
      return { isNew: true, delta: current }
    }
    const merged = maxUsage(before, current)
    this.seen.set(key, merged)
    return { isNew: false, delta: growth(before, merged) }
  }
}

/**
 * For a transcript held in memory: each response's usage, merged over its
 * lines, and the index of its last line — the one that carries it in a replay.
 */
export function responsesOf(lines: AnyLine[]): { usage: Map<string, UsageFields>; last: Map<string, number> } {
  const usage = new Map<string, UsageFields>()
  const last = new Map<string, number>()
  lines.forEach((l, i) => {
    if (l?.type !== 'assistant' || !l.message?.usage) return
    const key = responseKey(l)
    if (key === null) return
    const before = usage.get(key)
    usage.set(key, before ? maxUsage(before, l.message.usage) : l.message.usage)
    last.set(key, i)
  })
  return { usage, last }
}

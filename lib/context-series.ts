import type { CompactionEvent, ReplayTurn } from '@/types/claude'
import { contextLimit, type ContextLimits } from '@/lib/context-limits'

/** One assistant turn, plotted on the Context chart */
export interface ContextPoint {
  /** 1-based count among assistant turns — the number the Replay prints on the
   *  card, and the count the agent list gives as "171t". Not the position in
   *  the full turn list, which also holds the user turns. */
  turn: number
  /** Milliseconds since epoch */
  time: number
  uuid: string
  /** Context size carried into the turn: every part of the prompt — fresh
   *  input, what was read from the cache, and what was written to it */
  tokens: number
  /** Same value against the model's window, 0-100 */
  pct: number
  /** The window used for pct */
  limit: number
  model?: string
}

/** A compaction, placed on both the turn axis and the time axis */
export interface ContextMark {
  turn: number
  time: number
  uuid: string
  trigger: 'auto' | 'manual'
  pre_tokens: number
}

/** The range where this session compacted, measured from its own compactions */
export interface AutocompactBand {
  fromTokens: number
  toTokens: number
  fromPct: number
  toPct: number
}

/** Context size at each assistant turn. A turn with no usage carries no context
 *  reading, and neither does a synthetic one: Claude Code writes those locally
 *  — a usage limit, a missing credit — with every token count at zero. Plotting
 *  them would read as an empty context rather than as no reading at all, so
 *  both are left out. The rest of the repo skips '<synthetic>' the same way. */
export function buildContextSeries(turns: readonly ReplayTurn[], limits: ContextLimits): ContextPoint[] {
  const points: ContextPoint[] = []
  // Counts every assistant turn, plotted or not, so the number stays in step
  // with the Replay card, which counts them all.
  let ordinal = 0
  turns.forEach(t => {
    if (t.type !== 'assistant') return
    ordinal++
    if (!t.usage || t.model === '<synthetic>') return
    // All three are disjoint parts of one prompt. Leaving cache_creation out
    // makes a cold cache — after a /login, a resume, a model switch — look like
    // the context collapsed, when the same tokens were only written instead of
    // read.
    const tokens = (t.usage.input_tokens ?? 0)
      + (t.usage.cache_read_input_tokens ?? 0)
      + (t.usage.cache_creation_input_tokens ?? 0)
    const limit = contextLimit(t.model, limits)
    points.push({
      turn: ordinal,
      time: new Date(t.timestamp).getTime(),
      uuid: t.uuid,
      tokens,
      pct: limit > 0 ? (tokens / limit) * 100 : 0,
      limit,
      model: t.model,
    })
  })
  return points
}

/** Compactions, placed on the same assistant-turn scale as the points and on
 *  the time axis. A compaction sits before a turn, so it lands half a turn
 *  ahead of the assistant turns that precede it. */
export function buildContextMarks(
  compactions: readonly CompactionEvent[],
  turns: readonly ReplayTurn[] = [],
): ContextMark[] {
  // Assistant turns at or before each index, so a full-list index maps onto the
  // assistant-turn axis
  const ordinalBefore: number[] = []
  let ordinal = 0
  for (const t of turns) {
    ordinalBefore.push(ordinal)
    if (t.type === 'assistant') ordinal++
  }
  return compactions.map(c => ({
    turn: (ordinalBefore[c.turn_index] ?? ordinal) + 0.5,
    time: new Date(c.timestamp).getTime(),
    uuid: c.uuid,
    trigger: c.trigger,
    pre_tokens: c.pre_tokens,
  }))
}

/** Where this session actually compacted. Built only from its own logs: a
 *  session with no compaction gets no band, and no guessed threshold. */
export function autocompactBand(
  marks: readonly ContextMark[],
  points: readonly ContextPoint[],
): AutocompactBand | null {
  const sizes = marks.map(m => m.pre_tokens).filter(n => n > 0)
  if (sizes.length === 0) return null
  const fromTokens = Math.min(...sizes)
  const toTokens = Math.max(...sizes)
  const limitAt = (tokens: number) => {
    // The window in force when the context reached that size
    const near = points.filter(p => p.tokens <= tokens).pop() ?? points[0]
    return near?.limit ?? 0
  }
  const fl = limitAt(fromTokens)
  const tl = limitAt(toTokens)
  return {
    fromTokens,
    toTokens,
    fromPct: fl > 0 ? (fromTokens / fl) * 100 : 0,
    toPct: tl > 0 ? (toTokens / tl) * 100 : 0,
  }
}

/** One point per turn that has a turn before it, carrying the change in context
 *  size since that turn. The first point is left out: it has nothing to compare
 *  against. A negative delta is a compaction, a clear or a rewind. */
export function deltaPoints(points: readonly ContextPoint[]): Array<ContextPoint & { delta: number }> {
  const out: Array<ContextPoint & { delta: number }> = []
  for (let i = 1; i < points.length; i++) {
    out.push({ ...points[i], delta: points[i].tokens - points[i - 1].tokens })
  }
  return out
}

/** Points inside the window; no window keeps everything */
export function pointsInWindow(points: readonly ContextPoint[], from?: number, to?: number): ContextPoint[] {
  if (from === undefined || to === undefined) return [...points]
  return points.filter(p => p.time >= from && p.time <= to)
}

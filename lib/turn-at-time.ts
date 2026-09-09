/** The turn that was in progress at `timeMs`: the last one that started at or before it.
 *  Falls back to the first turn when the time is before the session started. */
export function turnAtTime<T extends { timestamp: string }>(turns: readonly T[], timeMs: number): T | undefined {
  let found: T | undefined
  for (const t of turns) {
    if (new Date(t.timestamp).getTime() > timeMs) break
    found = t
  }
  return found ?? turns[0]
}

/** Scroll `el` into view and flash a ring around it for a few seconds */
export function flashTurn(el: HTMLElement): () => void {
  const cls = ['ring-2', 'ring-primary', 'rounded-xl']
  el.scrollIntoView({ block: 'center' })
  el.classList.add(...cls)
  const t = setTimeout(() => el.classList.remove(...cls), 3500)
  return () => { clearTimeout(t); el.classList.remove(...cls) }
}

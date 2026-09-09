'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { filterColor, filterKey, type ToolFilter, type SearchState } from '@/lib/tool-filters'
import { Search, X, FileText, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  filters: ToolFilter[]
  states: Map<string, SearchState>
  /** matches inside the current window, per filter key */
  countsInWindow: Map<string, number>
  hasWindow: boolean
  onChange(filters: ToolFilter[]): void
}

export function ToolFilterBar({ filters, states, countsInWindow, hasWindow, onChange }: Props) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const query = draft.trim()
    if (!query) return
    const next: ToolFilter = { query, scope: 'input' }
    if (!filters.some(f => filterKey(f) === filterKey(next))) onChange([...filters, next])
    setDraft('')
  }
  const remove = (i: number) => onChange(filters.filter((_, j) => j !== i))
  const toggleScope = (i: number) =>
    onChange(filters.map((f, j) => (j === i ? { ...f, scope: f.scope === 'all' ? 'input' : 'all' } : f)))

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex items-center gap-2"
        onSubmit={e => { e.preventDefault(); add() }}
      >
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={'Filter tool calls, e.g. pnpm ci-verify or "exact phrase"'}
            className="h-8 pl-8 text-sm"
            aria-label="Add a tool call filter"
          />
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim()}>Add filter</Button>
        {filters.length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange([])}>Clear all</Button>
        )}
      </form>

      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((f, i) => {
            const key = filterKey(f)
            const st = states.get(key)
            const color = filterColor(i)
            const total = st?.status === 'ok' ? st.result.total : undefined
            const inWin = countsInWindow.get(key)
            return (
              <span
                key={key}
                className="flex items-center gap-1.5 rounded-full border py-0.5 pl-2.5 pr-1 text-xs"
                style={{ borderColor: color, background: `${color}1a` }}
              >
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
                <span className="font-mono">{f.query}</span>
                <span className="tabular-nums text-muted-foreground">
                  {st?.status === 'loading' && <Loader2 className="inline h-3 w-3 animate-spin" />}
                  {st?.status === 'error' && <span className="text-destructive" title={st.error}>error</span>}
                  {st?.status === 'ok' && (
                    hasWindow && inWin !== total
                      ? <><span className="text-foreground">{inWin ?? 0}</span> / {total}</>
                      : <span className="text-foreground">{total}</span>
                  )}
                  {st?.status === 'ok' && st.result.truncated && <span title={`Only the first ${st.result.matches.length} matches are drawn`}> ⚠</span>}
                </span>
                <button
                  type="button"
                  title={f.scope === 'all' ? 'Searching name, input and results. Click to search name and input only.' : 'Searching name and input. Click to also search tool results.'}
                  onClick={() => toggleScope(i)}
                  className={cn('rounded p-0.5 hover:bg-foreground/10', f.scope === 'all' ? 'text-foreground' : 'text-muted-foreground/50')}
                  aria-pressed={f.scope === 'all'}
                  aria-label="Also search tool results"
                >
                  <FileText className="h-3 w-3" />
                </button>
                <button type="button" onClick={() => remove(i)} className="rounded p-0.5 hover:bg-foreground/10" aria-label={`Remove filter ${f.query}`}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

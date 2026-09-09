'use client'

import useSWR from 'swr'
import type { SearchScope, ToolSearchResult } from '@/lib/tool-search'

/** One search filter shown as a colored layer on the flame chart */
export interface ToolFilter {
  query: string
  scope: SearchScope
}

export const FILTER_COLORS = ['#f472b6', '#facc15', '#22d3ee', '#a3e635', '#f43f5e', '#818cf8', '#fb923c', '#2dd4bf']

export function filterColor(index: number): string {
  return FILTER_COLORS[index % FILTER_COLORS.length]
}

export function filterKey(f: ToolFilter): string {
  return `${f.scope}:${f.query.trim().toLowerCase()}`
}

/** URL form: `f=` for input-only filters, `fr=` for filters that also search results */
export function filtersFromSearch(search: string): ToolFilter[] {
  const p = new URLSearchParams(search)
  const out: ToolFilter[] = []
  for (const q of p.getAll('f')) if (q.trim()) out.push({ query: q, scope: 'input' })
  for (const q of p.getAll('fr')) if (q.trim()) out.push({ query: q, scope: 'all' })
  return out
}

export function filtersToSearch(search: string, filters: ToolFilter[]): string {
  const p = new URLSearchParams(search)
  p.delete('f'); p.delete('fr')
  for (const f of filters) p.append(f.scope === 'all' ? 'fr' : 'f', f.query)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function searchUrl(sessionId: string, f: ToolFilter): string {
  const p = new URLSearchParams({ q: f.query.trim() })
  if (f.scope === 'all') p.set('scope', 'all')
  return `/api/sessions/${sessionId}/search?${p}`
}

export type SearchState = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; result: ToolSearchResult }

/** One fetch per session + filter, shared by every hook instance */
const cache = new Map<string, Promise<SearchState>>()

function fetchFilter(sessionId: string, f: ToolFilter): Promise<SearchState> {
  const key = `${sessionId}|${filterKey(f)}`
  let p = cache.get(key)
  if (!p) {
    p = fetch(searchUrl(sessionId, f))
      .then(async r => {
        if (!r.ok) throw new Error(`API error ${r.status}`)
        return { status: 'ok', result: (await r.json()) as ToolSearchResult } as SearchState
      })
      .catch(err => {
        cache.delete(key) // let a later attempt retry
        return { status: 'error', error: String(err) } as SearchState
      })
    cache.set(key, p)
  }
  return p
}

/**
 * Resolve every filter's matches. Each filter is fetched once per session and
 * kept in a module cache, so re-adding a filter or reordering them is free.
 */
export function useToolSearches(sessionId: string, filters: ToolFilter[]): Map<string, SearchState> {
  const keys = filters.map(filterKey)
  const swrKey = keys.length ? ['tool-search', sessionId, ...keys] : null
  const { data } = useSWR(swrKey, () => Promise.all(filters.map(f => fetchFilter(sessionId, f))), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  })
  const out = new Map<string, SearchState>()
  keys.forEach((k, i) => out.set(k, data?.[i] ?? { status: 'loading' }))
  return out
}

'use client'

import { Suspense, useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { TopBar } from '@/components/layout/top-bar'
import { SessionTable } from '@/components/sessions/session-table'
import { RangeFilter, FIVE_HOURS_MS, type RangeMode } from '@/components/sessions/range-filter'
import { windowFromSearch, windowToSearch, type TimeWindow } from '@/lib/time-window'
import type { SessionsResponse } from '@/types/claude'

const fetcher = (url: string) =>
  fetch(url).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

function modeFromSearch(search: string, w: TimeWindow | null): RangeMode {
  const m = new URLSearchParams(search).get('mode')
  if (m === '5h' || m === 'dates') return m
  return w && w.to - w.from === FIVE_HOURS_MS ? '5h' : 'dates'
}

function SessionsPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const search = searchParams.toString()

  // The range lives in the URL so it survives reloads and can be shared
  const window = useMemo(() => windowFromSearch(search), [search])
  const mode = useMemo(() => modeFromSearch(search, window), [search, window])

  const setRange = useCallback((w: TimeWindow | null, m: RangeMode) => {
    const p = new URLSearchParams(windowToSearch(search, w))
    p.set('mode', m)
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }, [search, pathname, router])

  // Only from/to reach the API; the mode is a UI concern
  const apiKey = `/api/sessions${windowToSearch('', window)}`
  const { data, error, isLoading } = useSWR<SessionsResponse>(apiKey, fetcher, {
    refreshInterval: 5_000,
    keepPreviousData: true,
  })

  return (
    <div className="flex flex-col min-h-screen">
      <TopBar
        title="Claude Code Analytics · Sessions"
        subtitle={data ? (data.range ? `${data.total} sessions in range` : `${data.total} total sessions`) : 'loading...'}
      />
      <div className="p-6 space-y-3">
        <RangeFilter window={window} mode={mode} onChange={setRange} />
        {error && (
          <p className="text-[#f87171] text-sm font-mono">Error: {String(error)}</p>
        )}
        {isLoading && !data && (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 bg-muted rounded animate-pulse" />
            ))}
          </div>
        )}
        {data && <SessionTable sessions={data.sessions} range={data.range} />}
      </div>
    </div>
  )
}

export default function SessionsPage() {
  // useSearchParams needs a Suspense boundary for the static shell
  return (
    <Suspense fallback={null}>
      <SessionsPageInner />
    </Suspense>
  )
}

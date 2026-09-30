'use client'

import { useState } from 'react'
import useSWR from 'swr'
import type { CaptureDetail, CaptureSummary } from '@/types/inspector'
import { CapturesEmptyState } from './empty-state'
import { CaptureList } from './capture-list'
import { AnatomyView } from './anatomy-view'
import { Skeleton } from '@/components/ui/skeleton'

const fetcher = (url: string) => fetch(url).then(r => {
  if (!r.ok) throw new Error(`API error ${r.status}`)
  return r.json()
})

interface ListResponse {
  available: boolean
  captures: CaptureSummary[]
}

export function RawApiTab({ sessionId }: { sessionId: string }) {
  const { data, isLoading } = useSWR<ListResponse>(
    `/api/sessions/${sessionId}/captures`,
    fetcher,
    { refreshInterval: 5000 },
  )

  const [userSelectedId, setUserSelectedId] = useState<string | null>(null)

  // Effective selection: user's pick if set, otherwise the first capture in the list.
  // Derived state — no useEffect needed.
  const selectedId =
    userSelectedId ??
    (data?.captures && data.captures.length > 0 ? data.captures[0].request_id : null)

  const { data: detail, isLoading: detailLoading } = useSWR<CaptureDetail>(
    selectedId ? `/api/captures/${selectedId}` : null,
    fetcher,
  )

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-10 rounded-md" />
        <Skeleton className="h-10 rounded-md" />
        <Skeleton className="h-10 rounded-md" />
      </div>
    )
  }
  if (!data) {
    return <CapturesEmptyState available={false} />
  }
  if (!data.available) {
    return <CapturesEmptyState available={false} />
  }
  if (data.captures.length === 0) {
    return <CapturesEmptyState available={true} sessionId={sessionId} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <CaptureList
        captures={data.captures}
        selectedId={selectedId}
        onSelect={setUserSelectedId}
      />
      <div className="flex-1 min-h-0">
        {detailLoading && !detail ? (
          <div className="space-y-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-32" />
            <Skeleton className="h-64" />
          </div>
        ) : detail ? (
          <AnatomyView detail={detail} />
        ) : null}
      </div>
    </div>
  )
}

'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Radio, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AnatomyView } from '@/components/sessions/raw-api/anatomy-view'
import {
  CaptureModeHint, CommandSnippet, OTEL_EXPLANATION, PROXY_EXPLANATION, proxyCommand, useCaptureStatus,
  type CaptureMode, type OtelStatus, type ProxyStatus,
} from '@/components/proxy/capture-controls'
import { formatTokens } from '@/lib/decode'
import type { CaptureDetail, CaptureSummary } from '@/types/inspector'

interface ListResponse {
  available: boolean
  captures: CaptureSummary[]
}

const fetcher = (url: string) => fetch(url).then(r => {
  if (!r.ok) throw new Error(`API error ${r.status}`)
  return r.json()
})

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function statusTone(status: number | null, error: string | null): string {
  if (status != null && status >= 500) return 'text-destructive'
  if (status != null && status >= 400) return 'text-amber-600 dark:text-amber-500'
  if (error) return 'text-destructive'
  if (status == null) return 'text-muted-foreground'
  return 'text-emerald-600 dark:text-emerald-500'
}

function EmptyState({ otel, proxy, onStart }: {
  otel: OtelStatus | undefined
  proxy: ProxyStatus | undefined
  onStart: (mode: CaptureMode) => void
}) {
  if (!otel?.running && !proxy?.running) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Radio className="h-5 w-5 text-muted-foreground" />
          </div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            Live capture is off
            <CaptureModeHint kind="info" text={OTEL_EXPLANATION} />
          </h3>
          <p className="max-w-md text-sm text-muted-foreground">
            Start capturing to record every request Claude Code sends to the Anthropic API and its response;
            they stream in here in real time.
          </p>
          <Button onClick={() => onStart('otel')} className="gap-2 mt-1">
            <Play className="h-4 w-4" />
            Start capture
          </Button>
          <p className="flex max-w-md items-center gap-1.5 pt-2 text-xs text-muted-foreground">
            <span>
              Advanced: to see the wire traffic,{' '}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onStart('proxy')}>
                start the proxy
              </button>{' '}
              instead.
            </span>
            <CaptureModeHint kind="warning" text={PROXY_EXPLANATION} />
          </p>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-10 text-center max-w-2xl mx-auto">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
          <Radio className="h-5 w-5 text-emerald-500" />
        </div>
        <h3 className="text-base font-semibold">
          {otel?.running ? 'Capturing' : `Proxy running on :${proxy?.port}`}
        </h3>
        <p className="text-sm text-muted-foreground">
          Waiting for traffic. Run this in a new terminal — captures will appear here in real time.
        </p>
        {otel?.running && <CommandSnippet command={otel.command} />}
        {proxy?.running && proxy.port && <CommandSnippet command={proxyCommand(proxy.port)} />}
      </CardContent>
    </Card>
  )
}

export function LiveTail() {
  const { otel, proxy, act } = useCaptureStatus()
  const { data: list, isLoading } = useSWR<ListResponse>(
    '/api/captures?limit=100',
    fetcher,
    { refreshInterval: 1000 },
  )
  const [userSelectedId, setUserSelectedId] = useState<string | null>(null)

  // Default selection = first (newest) capture
  const captures = list?.captures ?? []
  const selectedId =
    userSelectedId && captures.some(c => c.request_id === userSelectedId)
      ? userSelectedId
      : (captures[0]?.request_id ?? null)

  const { data: detail, isLoading: detailLoading } = useSWR<CaptureDetail>(
    selectedId ? `/api/captures/${selectedId}` : null,
    fetcher,
  )

  const capturing = !!otel?.running || !!proxy?.running
  const statusLabel = [otel?.running && 'Capturing', proxy?.running && `Proxy on :${proxy.port}`]
    .filter(Boolean).join(' · ') || 'Capture off'

  // No data yet → show full-width empty state with proxy controls
  if (isLoading) {
    return <Skeleton className="h-32 mx-4 mt-4" />
  }
  if (captures.length === 0) {
    return (
      <div className="p-4">
        <EmptyState otel={otel} proxy={proxy} onStart={(mode) => act(mode, 'start')} />
      </div>
    )
  }

  // Have data → side-by-side: tail (left) + drilldown (right)
  return (
    <div className="flex h-full min-h-0">
      {/* Left pane: tail */}
      <div className="w-[36%] min-w-[320px] max-w-[480px] shrink-0 overflow-y-auto border-r border-border">
        {/* Header strip showing capture state inline */}
        <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-3 py-2 backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex h-2 w-2 rounded-full',
                  capturing ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )}
              />
              <span className="text-xs font-medium">{statusLabel}</span>
            </div>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {captures.length} capture{captures.length === 1 ? '' : 's'}
            </span>
          </div>
          {otel?.running && (
            <div className="mt-2">
              <CommandSnippet command={otel.command} />
            </div>
          )}
          {proxy?.running && proxy.port && (
            <div className="mt-2">
              <CommandSnippet command={proxyCommand(proxy.port)} />
            </div>
          )}
        </div>
        <ul className="divide-y divide-border">
          {captures.map((c) => {
            const tokens = (c.input_tokens ?? 0) + (c.cache_read_tokens ?? 0) + (c.cache_creation_tokens ?? 0)
            const isSelected = c.request_id === selectedId
            return (
              <li key={c.request_id}>
                <button
                  onClick={() => setUserSelectedId(c.request_id)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs transition-colors',
                    isSelected ? 'bg-primary/5' : 'hover:bg-muted/50',
                  )}
                >
                  <div className="flex items-center gap-2 font-mono tabular-nums">
                    <span className="text-muted-foreground">{fmtTime(c.timestamp)}</span>
                    <span className={cn('font-semibold', statusTone(c.status_code, c.error))}>
                      {c.status_code || (c.error ? 'ERR' : '—')}
                    </span>
                    <span className="ml-auto text-muted-foreground">
                      {c.duration_ms != null ? `${c.duration_ms}ms` : ''}
                    </span>
                  </div>
                  <div className="truncate text-foreground/85">{c.model ?? c.path}</div>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
                    <span>{fmtBytes(c.request_body_bytes)}</span>
                    {tokens > 0 && <span>{formatTokens(tokens)} tok</span>}
                    {c.session_id && (
                      <span className="ml-auto truncate font-mono opacity-60" title={c.session_id}>
                        {c.session_id.slice(0, 8)}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Right pane: drilldown */}
      <div className="flex-1 min-w-0 overflow-y-auto px-4 py-4">
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

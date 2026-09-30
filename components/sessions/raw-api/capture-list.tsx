'use client'

import { cn } from '@/lib/utils'
import type { CaptureSummary } from '@/types/inspector'
import { formatTokens } from '@/lib/decode'

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

export function CaptureList({
  captures,
  selectedId,
  onSelect,
}: {
  captures: CaptureSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="space-y-1">
      {captures.map((c, i) => {
        const tokens = (c.input_tokens ?? 0) + (c.cache_read_tokens ?? 0) + (c.cache_creation_tokens ?? 0)
        const isSelected = c.request_id === selectedId
        return (
          <button
            key={c.request_id}
            onClick={() => onSelect(c.request_id)}
            className={cn(
              'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors',
              isSelected
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/50',
            )}
          >
            <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {i + 1}
            </span>
            <span className="w-20 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {fmtTime(c.timestamp)}
            </span>
            <span className={cn('w-10 shrink-0 font-mono text-xs font-semibold tabular-nums', statusTone(c.status_code, c.error))}>
              {c.status_code || (c.error ? 'ERR' : '—')}
            </span>
            <span className="w-32 shrink-0 truncate font-mono text-xs text-muted-foreground">
              {c.path}
            </span>
            <span className="flex-1 truncate text-xs text-muted-foreground">
              {c.model ?? '—'}
            </span>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {tokens > 0 ? formatTokens(tokens) : '—'}
            </span>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {fmtBytes(c.request_body_bytes)}
            </span>
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {c.duration_ms != null ? `${c.duration_ms}ms` : '—'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

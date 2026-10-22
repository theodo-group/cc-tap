'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Radio, Copy, Check, Play, Square, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/base-path'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface ProxyStatus {
  running: boolean
  pid?: number
  port?: number
  startedAt?: number
}

const fetcher = (url: string) => apiFetch(url).then(r => r.json())

function connectCommand(port: number): string {
  return `ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://localhost:${port} claude`
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="outline"
      size="icon"
      className="h-7 w-7 shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* ignore — clipboard may be blocked in some contexts */ }
      }}
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

export function LiveCaptureButton() {
  const { data: status, mutate } = useSWR<ProxyStatus>(
    '/api/proxy/status',
    fetcher,
    { refreshInterval: 3000 },
  )
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)

  const running = !!status?.running
  const port = status?.port

  async function handleStart() {
    setBusy('start')
    try {
      await apiFetch('/api/proxy/start', { method: 'POST' })
      await mutate()
    } finally {
      setBusy(null)
    }
  }
  async function handleStop() {
    setBusy('stop')
    try {
      await apiFetch('/api/proxy/stop', { method: 'POST' })
      await mutate()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label="Live capture"
        >
          <span className="relative flex h-2 w-2">
            {running && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            )}
            <span
              className={cn(
                'relative inline-flex h-2 w-2 rounded-full',
                running ? 'bg-emerald-500' : 'bg-muted-foreground/40',
              )}
            />
          </span>
          <Radio className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Live Capture</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex h-2 w-2 rounded-full',
                running ? 'bg-emerald-500' : 'bg-muted-foreground/40',
              )}
            />
            <span className="text-sm font-medium">
              {running ? `Capturing on :${port}` : 'Proxy not running'}
            </span>
          </div>
          {running ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={handleStop}
              disabled={busy !== null}
            >
              {busy === 'stop' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={handleStart}
              disabled={busy !== null}
            >
              {busy === 'start' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Start
            </Button>
          )}
        </div>
        <div className="px-3 py-3 space-y-2">
          {running && port ? (
            <>
              <p className="text-xs text-muted-foreground">
                Point Claude Code at the proxy to start capturing. Run this in a new terminal:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs font-mono">
                  {connectCommand(port)}
                </code>
                <CopyButton text={connectCommand(port)} />
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Click <strong>Start</strong> to launch the inspector proxy on a free port. Once running,
              you&apos;ll get a copyable command to point Claude Code at it.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

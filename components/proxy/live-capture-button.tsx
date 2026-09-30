'use client'

import { useState } from 'react'
import { Radio, Play, Square, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  CaptureModeHint, CommandSnippet, OTEL_EXPLANATION, PROXY_EXPLANATION, proxyCommand, useCaptureStatus,
  type CaptureMode,
} from './capture-controls'

function StatusDot({ on }: { on: boolean }) {
  return <span className={cn('inline-flex h-2 w-2 shrink-0 rounded-full', on ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
}

function StartStop({ running, busy, onClick }: { running: boolean; busy: boolean; onClick: () => void }) {
  return running ? (
    <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={onClick} disabled={busy}>
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
      Stop
    </Button>
  ) : (
    <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={onClick} disabled={busy}>
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
      Start
    </Button>
  )
}

export function LiveCaptureButton() {
  const { otel, proxy, act } = useCaptureStatus()
  const [busy, setBusy] = useState<CaptureMode | null>(null)

  const otelRunning = !!otel?.running
  const proxyRunning = !!proxy?.running
  const port = proxy?.port

  async function toggle(mode: CaptureMode, running: boolean) {
    setBusy(mode)
    try {
      await act(mode, running ? 'stop' : 'start')
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
            {(otelRunning || proxyRunning) && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            )}
            <span
              className={cn(
                'relative inline-flex h-2 w-2 rounded-full',
                otelRunning || proxyRunning ? 'bg-emerald-500' : 'bg-muted-foreground/40',
              )}
            />
          </span>
          <Radio className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Live Capture</span>
        </Button>
      </PopoverTrigger>
      {/* No auto-focus on open: it would land on the info icon and pop its tooltip over the content. */}
      <PopoverContent align="end" className="w-96 p-0" onOpenAutoFocus={e => e.preventDefault()}>
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <StatusDot on={otelRunning} />
            <span className="text-sm font-medium">{otelRunning ? 'Capturing' : 'Capture off'}</span>
            <CaptureModeHint kind="info" text={OTEL_EXPLANATION} />
          </div>
          <StartStop running={otelRunning} busy={busy !== null} onClick={() => toggle('otel', otelRunning)} />
        </div>
        <div className="px-3 py-3 space-y-2">
          {otelRunning && otel ? (
            <>
              <p className="text-xs text-muted-foreground">
                Run Claude Code with this variable (or set it in the <code>env</code> of your Claude Code settings):
              </p>
              <CommandSnippet command={otel.command} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Click <strong>Start</strong>{' '}to record the request and response bodies Claude Code logs itself.
            </p>
          )}
        </div>
        <div className="border-t border-border px-3 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusDot on={proxyRunning} />
              <span className="text-xs font-medium">
                {proxyRunning ? `Proxy on :${port}` : 'Proxy mode'}
                <span className="ml-1.5 font-normal text-muted-foreground">advanced</span>
              </span>
              <CaptureModeHint kind="warning" text={PROXY_EXPLANATION} />
            </div>
            <StartStop running={proxyRunning} busy={busy !== null} onClick={() => toggle('proxy', proxyRunning)} />
          </div>
          {proxyRunning && port && <CommandSnippet command={proxyCommand(port)} />}
        </div>
      </PopoverContent>
    </Popover>
  )
}

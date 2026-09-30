'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Copy, Check, Info, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// Live Capture has two modes. OTel (default): Claude Code keeps talking to
// api.anthropic.com and logs each call's bodies to a directory the ingester
// tails. Proxy (advanced): Claude Code is pointed at a local reverse proxy,
// which sees the wire traffic but changes how Claude Code behaves.

export interface OtelStatus {
  running: boolean
  pid?: number
  startedAt?: number
  bodiesDir: string
  command: string
}

export interface ProxyStatus {
  running: boolean
  pid?: number
  port?: number
  startedAt?: number
}

export type CaptureMode = 'otel' | 'proxy'

export function proxyCommand(port: number): string {
  return `ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://localhost:${port} claude`
}

export const PROXY_CAVEAT =
  'A custom ANTHROPIC_BASE_URL changes how Claude Code behaves (auto-mode safeguards, beta headers, tool search off unless ENABLE_TOOL_SEARCH=true), so captures may not match a normal session.'

export const OTEL_EXPLANATION =
  'Claude Code keeps talking to api.anthropic.com and behaves exactly as usual. It writes each request and response to disk (OTEL_LOG_RAW_API_BODIES); cc-tap records them, then deletes the files.'

export const PROXY_EXPLANATION =
  `Routes Claude Code through a local proxy to record the wire traffic: the SSE stream as sent, calls besides /v1/messages, the exact status and timing of every attempt. ${PROXY_CAVEAT}`

/** Icon with the explanation of a capture mode in a tooltip: "info" for OTel, "warning" for the proxy. */
export function CaptureModeHint({ kind, text }: { kind: 'info' | 'warning'; text: string }) {
  const Icon = kind === 'info' ? Info : TriangleAlert
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={kind === 'info' ? 'About live capture' : 'About proxy mode'}
            className={kind === 'info'
              ? 'text-muted-foreground hover:text-foreground'
              : 'text-amber-600 hover:text-amber-500 dark:text-amber-500'}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-left">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const fetcher = (url: string) => fetch(url).then(r => {
  if (!r.ok) throw new Error(`API error ${r.status}`)
  return r.json()
})

/** Status of both capture modes, polled, with start/stop actions. */
export function useCaptureStatus() {
  const { data: otel, mutate: mutateOtel } = useSWR<OtelStatus>('/api/otel/status', fetcher, { refreshInterval: 3000 })
  const { data: proxy, mutate: mutateProxy } = useSWR<ProxyStatus>('/api/proxy/status', fetcher, { refreshInterval: 3000 })
  async function act(mode: CaptureMode, action: 'start' | 'stop') {
    await fetch(`/api/${mode}/${action}`, { method: 'POST' })
    await (mode === 'otel' ? mutateOtel() : mutateProxy())
  }
  return { otel, proxy, act }
}

export function CopyButton({ text }: { text: string }) {
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

export function CommandSnippet({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 text-left text-xs font-mono">{command}</code>
      <CopyButton text={command} />
    </div>
  )
}

'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { assembleSseMessage, parseSseEvents, type SseEvent } from '@/lib/sse'
import type {
  AnthropicContentBlock,
  AnthropicRequestBody,
  AnthropicTool,
  CaptureDetail,
} from '@/types/inspector'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronRight, Snowflake, Hash, FileText, Wrench, Brain, MessageSquare, Sparkles, Download } from 'lucide-react'

// ─── download helpers ────────────────────────────────────────────────────────

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ─── token estimate (chars/4) ───────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function tokensFromBlock(block: AnthropicContentBlock): number {
  if (!block || typeof block !== 'object') return 0
  if ('text' in block && typeof (block as { text: unknown }).text === 'string') {
    return estimateTokens((block as { text: string }).text)
  }
  if (block.type === 'tool_use') {
    return estimateTokens(JSON.stringify((block as { input: unknown }).input ?? {})) + 50
  }
  if (block.type === 'tool_result') {
    const c = (block as { content: unknown }).content
    if (typeof c === 'string') return estimateTokens(c)
    if (Array.isArray(c)) return estimateTokens(JSON.stringify(c))
    return 0
  }
  if (block.type === 'thinking') {
    return estimateTokens(JSON.stringify(block))
  }
  return estimateTokens(JSON.stringify(block))
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

// ─── cache_control helpers ───────────────────────────────────────────────────

function hasCacheControl(b: unknown): boolean {
  if (!b || typeof b !== 'object') return false
  return Boolean((b as { cache_control?: unknown }).cache_control)
}

// ─── small primitives ────────────────────────────────────────────────────────

function CacheBreakpoint({ label }: { label?: string }) {
  return (
    <div className="my-2 flex items-center gap-2 text-xs">
      <div className="h-px flex-1 bg-cyan-500/40" />
      <Badge variant="outline" className="gap-1 border-cyan-500/40 bg-cyan-500/5 text-cyan-700 dark:text-cyan-400">
        <Snowflake className="h-3 w-3" />
        cache breakpoint{label ? ` · ${label}` : ''}
      </Badge>
      <div className="h-px flex-1 bg-cyan-500/40" />
    </div>
  )
}

function SectionHeader({ icon: Icon, title, subtitle, tokens }: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  subtitle?: string
  tokens?: number
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h3 className="text-sm font-semibold">{title}</h3>
      {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      {tokens != null && (
        <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-xs font-mono tabular-nums text-muted-foreground">
          ~{fmtTokens(tokens)} tok
        </span>
      )}
    </div>
  )
}

function Collapsible({
  title,
  badge,
  defaultOpen = false,
  children,
}: { title: React.ReactNode; badge?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-md border border-border">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className="flex-1 truncate">{title}</span>
        {badge}
      </button>
      {open && <div className="border-t border-border px-3 py-2 text-xs">{children}</div>}
    </div>
  )
}

// ─── system blocks ───────────────────────────────────────────────────────────

function SystemBlocks({ system }: { system: AnthropicContentBlock[] | string | undefined }) {
  if (!system) return null
  const blocks: AnthropicContentBlock[] = Array.isArray(system)
    ? system
    : [{ type: 'text', text: system }]
  const total = blocks.reduce((s, b) => s + tokensFromBlock(b), 0)

  return (
    <Card>
      <CardHeader className="pb-3">
        <SectionHeader
          icon={FileText}
          title="System Prompt"
          subtitle={`${blocks.length} block${blocks.length === 1 ? '' : 's'}`}
          tokens={total}
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {blocks.map((block, i) => {
          const text = (block as { text?: string }).text ?? JSON.stringify(block, null, 2)
          const cached = hasCacheControl(block)
          const tokens = tokensFromBlock(block)
          return (
            <div key={i}>
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span>system[{i}]</span>
                {cached && (
                  <Badge variant="outline" className="gap-1 border-cyan-500/40 bg-cyan-500/5 text-cyan-700 dark:text-cyan-400">
                    <Snowflake className="h-2.5 w-2.5" />
                    cached
                  </Badge>
                )}
                <span className="ml-auto font-mono tabular-nums">~{fmtTokens(tokens)} tok</span>
              </div>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
                {text}
              </pre>
              {cached && <CacheBreakpoint label={`after system[${i}]`} />}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ─── tools ───────────────────────────────────────────────────────────────────

function ToolsBlock({ tools }: { tools: AnthropicTool[] | undefined }) {
  if (!tools || tools.length === 0) return null
  const totalTokens = tools.reduce((s, t) => s + estimateTokens(JSON.stringify(t)), 0)
  return (
    <Card>
      <CardHeader className="pb-3">
        <SectionHeader
          icon={Wrench}
          title="Tool Definitions"
          subtitle={`${tools.length} tool${tools.length === 1 ? '' : 's'}`}
          tokens={totalTokens}
        />
        <CardDescription className="text-xs">
          The full JSON schema sent to the model for each tool
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {tools.map((t) => {
          const tokens = estimateTokens(JSON.stringify(t))
          return (
            <Collapsible
              key={t.name}
              title={
                <span className="flex items-center gap-2">
                  <code className="font-mono text-xs">{t.name}</code>
                  {t.description && (
                    <span className="truncate text-xs text-muted-foreground">
                      {t.description.split('\n')[0]}
                    </span>
                  )}
                </span>
              }
              badge={
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  ~{fmtTokens(tokens)} tok
                </span>
              }
            >
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono">
                {JSON.stringify(t.input_schema ?? {}, null, 2)}
              </pre>
              {t.description && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">description ({t.description.length} chars)</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{t.description}</pre>
                </details>
              )}
            </Collapsible>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ─── message blocks ──────────────────────────────────────────────────────────

function ContentBlock({ block }: { block: AnthropicContentBlock }) {
  const cached = hasCacheControl(block)
  const tokens = tokensFromBlock(block)

  const headerRow = (
    <div className="mb-1 flex items-center gap-2 text-xs">
      <Badge variant="outline" className="text-xs">{block.type}</Badge>
      {block.type === 'tool_use' && (
        <code className="font-mono text-xs text-muted-foreground">
          {(block as { name: string }).name}
        </code>
      )}
      {block.type === 'tool_result' && (
        <code className="font-mono text-xs text-muted-foreground">
          ↳ {(block as { tool_use_id: string }).tool_use_id?.slice(0, 16)}…
        </code>
      )}
      {cached && (
        <Badge variant="outline" className="gap-1 border-cyan-500/40 bg-cyan-500/5 text-cyan-700 dark:text-cyan-400">
          <Snowflake className="h-2.5 w-2.5" />
          cached
        </Badge>
      )}
      <span className="ml-auto font-mono tabular-nums text-muted-foreground">
        ~{fmtTokens(tokens)} tok
      </span>
    </div>
  )

  if (block.type === 'text') {
    return (
      <div>
        {headerRow}
        <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 text-xs whitespace-pre-wrap break-words">
          {(block as { text: string }).text}
        </pre>
      </div>
    )
  }
  if (block.type === 'thinking') {
    return (
      <div>
        {headerRow}
        <pre className="max-h-64 overflow-auto rounded-md bg-violet-500/5 p-2 text-xs italic whitespace-pre-wrap break-words">
          {(block as { thinking?: string }).thinking ?? JSON.stringify(block, null, 2)}
        </pre>
      </div>
    )
  }
  if (block.type === 'tool_use') {
    return (
      <div>
        {headerRow}
        <pre className="max-h-64 overflow-auto rounded-md bg-amber-500/5 p-2 font-mono text-xs whitespace-pre-wrap break-words">
          {JSON.stringify((block as { input: unknown }).input, null, 2)}
        </pre>
      </div>
    )
  }
  if (block.type === 'tool_result') {
    const c = (block as { content: string | unknown[] }).content
    const txt = typeof c === 'string' ? c : JSON.stringify(c, null, 2)
    return (
      <div>
        {headerRow}
        <pre className="max-h-64 overflow-auto rounded-md bg-emerald-500/5 p-2 text-xs whitespace-pre-wrap break-words">
          {txt}
        </pre>
      </div>
    )
  }
  return (
    <div>
      {headerRow}
      <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 text-xs whitespace-pre-wrap break-words">
        {JSON.stringify(block, null, 2)}
      </pre>
    </div>
  )
}

function MessagesBlock({ messages }: { messages: AnthropicRequestBody['messages'] }) {
  if (!messages || messages.length === 0) return null

  // Find the last cache_control breakpoint position so we can highlight where
  // the cache cuts the message history.
  let lastCacheIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content
    if (Array.isArray(c) && c.some(b => hasCacheControl(b))) {
      lastCacheIdx = i
      break
    }
  }

  const totalTokens = messages.reduce((s, m) => {
    if (typeof m.content === 'string') return s + estimateTokens(m.content)
    return s + (m.content as AnthropicContentBlock[]).reduce((ss, b) => ss + tokensFromBlock(b), 0)
  }, 0)

  return (
    <Card>
      <CardHeader className="pb-3">
        <SectionHeader
          icon={MessageSquare}
          title="Message History"
          subtitle={`${messages.length} message${messages.length === 1 ? '' : 's'}`}
          tokens={totalTokens}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {messages.map((m, i) => {
          const blocks: AnthropicContentBlock[] = typeof m.content === 'string'
            ? [{ type: 'text', text: m.content }]
            : m.content
          const isFinal = i === messages.length - 1
          return (
            <div key={i}>
              <div
                className={cn(
                  'rounded-md border px-3 py-2',
                  m.role === 'user' ? 'border-blue-500/30 bg-blue-500/5' : 'border-orange-500/30 bg-orange-500/5',
                  isFinal && 'ring-2 ring-primary/30',
                )}
              >
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <Badge variant="outline" className="capitalize">{m.role}</Badge>
                  <span className="font-mono text-xs text-muted-foreground">message[{i}]</span>
                  {isFinal && (
                    <Badge variant="default" className="gap-1">
                      <Sparkles className="h-2.5 w-2.5" />
                      final
                    </Badge>
                  )}
                </div>
                <div className="space-y-2">
                  {blocks.map((b, j) => <ContentBlock key={j} block={b} />)}
                </div>
              </div>
              {i === lastCacheIdx && i < messages.length - 1 && (
                <CacheBreakpoint label={`after message[${i}]`} />
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ─── header strip ────────────────────────────────────────────────────────────

function MetaStrip({ detail }: { detail: CaptureDetail }) {
  const s = detail.summary
  const r = detail.request_body
  const items: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'model', value: <code className="font-mono text-xs">{s.model ?? '—'}</code> },
    { label: 'stream', value: s.is_streaming ? 'yes' : 'no' },
    { label: 'status', value: s.error ? 'error' : (s.status_code ?? '—') },
    { label: 'duration', value: s.duration_ms != null ? `${s.duration_ms} ms` : '—' },
  ]
  if (r?.max_tokens) items.push({ label: 'max_tokens', value: r.max_tokens })
  if (r?.thinking) items.push({ label: 'thinking', value: <code className="font-mono text-xs">{JSON.stringify(r.thinking)}</code> })
  if ((r as { output_config?: unknown } | null)?.output_config) {
    items.push({ label: 'output_config', value: <code className="font-mono text-xs">{JSON.stringify((r as { output_config?: unknown }).output_config)}</code> })
  }
  if (s.cc_version) items.push({ label: 'cc_version', value: s.cc_version })

  const idShort = s.request_id.slice(0, 8)
  const onDownloadRequest = () => {
    if (!r) return
    downloadBlob(`request-${idShort}.json`, JSON.stringify(r, null, 2), 'application/json')
  }
  const onDownloadResponse = () => {
    if (!detail.response_text) return
    // Streaming responses are raw SSE text; non-streaming are JSON. Pick filename + mime accordingly.
    if (s.is_streaming) {
      downloadBlob(`response-${idShort}.sse.txt`, detail.response_text, 'text/event-stream')
    } else {
      downloadBlob(`response-${idShort}.json`, detail.response_text, 'application/json')
    }
  }
  // Reassembled message — offered only for streaming responses that produced one.
  const assembled = useMemo(
    () => (s.is_streaming && detail.response_text ? assembleSseMessage(detail.response_text) : null),
    [s.is_streaming, detail.response_text],
  )
  const onDownloadAssembled = () => {
    if (assembled) downloadBlob(`response-${idShort}.assembled.json`, JSON.stringify(assembled, null, 2), 'application/json')
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
        {items.map((it) => (
          <div key={it.label} className="text-xs">
            <span className="text-muted-foreground">{it.label}: </span>
            <span className="font-medium">{it.value}</span>
          </div>
        ))}
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDownloadRequest}
            disabled={!r}
            className="h-7 gap-1.5 text-xs"
          >
            <Download className="h-3 w-3" />
            Request JSON
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDownloadResponse}
            disabled={!detail.response_text}
            className="h-7 gap-1.5 text-xs"
          >
            <Download className="h-3 w-3" />
            {s.is_streaming ? 'Response SSE' : 'Response JSON'}
          </Button>
          {assembled && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDownloadAssembled}
              className="h-7 gap-1.5 text-xs"
            >
              <Download className="h-3 w-3" />
              Response Assembled
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── usage card ──────────────────────────────────────────────────────────────

function UsageCard({ detail }: { detail: CaptureDetail }) {
  const s = detail.summary
  if (s.input_tokens == null && s.output_tokens == null) return null
  const totalIn = (s.input_tokens ?? 0) + (s.cache_read_tokens ?? 0) + (s.cache_creation_tokens ?? 0)
  const cacheRate = totalIn > 0 ? Math.round(((s.cache_read_tokens ?? 0) / totalIn) * 100) : 0
  return (
    <Card>
      <CardHeader className="pb-2">
        <SectionHeader icon={Hash} title="Usage" />
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="input" value={s.input_tokens} tone="blue" />
        <Stat label="output" value={s.output_tokens} tone="orange" />
        <Stat label="cache read" value={s.cache_read_tokens} tone="cyan" sub={`${cacheRate}% hit`} />
        <Stat label="cache write" value={s.cache_creation_tokens} tone="violet" />
      </CardContent>
    </Card>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
}: { label: string; value: number | null; sub?: string; tone: 'blue' | 'orange' | 'cyan' | 'violet' }) {
  const toneClass = {
    blue: 'text-blue-600 dark:text-blue-400',
    orange: 'text-orange-600 dark:text-orange-400',
    cyan: 'text-cyan-600 dark:text-cyan-400',
    violet: 'text-violet-600 dark:text-violet-400',
  }[tone]
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('text-2xl font-semibold tabular-nums', toneClass)}>
        {value != null ? value.toLocaleString() : '—'}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

// ─── response card ───────────────────────────────────────────────────────────

function PreBlock({ text }: { text: string }) {
  const clipped = text.length > 200_000 ? text.slice(0, 200_000) + '\n…[truncated]' : text
  return (
    <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre font-mono">
      {clipped}
    </pre>
  )
}

/** Pretty-printed SSE: one block per event, padding trimmed, pings collapsed. */
function RawSseView({ events }: { events: SseEvent[] }) {
  const rows: React.ReactNode[] = []
  let pingRun = 0
  const flushPings = (key: string) => {
    if (pingRun > 0) {
      rows.push(
        <div key={key} className="px-3 py-1 text-xs text-muted-foreground/60">· ping ×{pingRun}</div>,
      )
      pingRun = 0
    }
  }
  events.forEach((ev, i) => {
    if (ev.event === 'ping') { pingRun++; return }
    flushPings(`ping-${i}`)
    rows.push(
      <div key={i} className="border-t border-border/40 px-3 py-2 first:border-t-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400">
          {ev.event}
        </div>
        <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-xs text-muted-foreground">
          {ev.parseError ? ev.raw : JSON.stringify(ev.data, null, 2)}
        </pre>
      </div>,
    )
  })
  flushPings('ping-end')
  return <div className="max-h-96 overflow-auto rounded-md bg-muted/40">{rows}</div>
}

function ResponseCard({ detail }: { detail: CaptureDetail }) {
  const text = detail.response_text
  const streaming = detail.summary.is_streaming
  const idShort = detail.summary.request_id.slice(0, 8)
  const [view, setView] = useState<'assembled' | 'raw'>('assembled')

  const assembled = useMemo(
    () => (streaming && text ? assembleSseMessage(text) : null),
    [streaming, text],
  )
  const events = useMemo(
    () => (streaming && text ? parseSseEvents(text) : []),
    [streaming, text],
  )
  // Non-streaming responses are already JSON; pretty-print when parseable.
  const nonStreamPretty = useMemo(() => {
    if (streaming || !text) return null
    try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return null }
  }, [streaming, text])

  if (!text) return null

  const downloadAssembled = () => {
    if (assembled) downloadBlob(`response-${idShort}.assembled.json`, JSON.stringify(assembled, null, 2), 'application/json')
  }

  // Assembled is only meaningful for streaming responses that yielded a message.
  const showToggle = streaming && assembled !== null
  const showAssembled = streaming && view === 'assembled' && assembled !== null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeader
            icon={Brain}
            title="Response"
            subtitle={streaming ? (showAssembled ? 'assembled message' : 'raw SSE stream') : 'JSON'}
          />
          <div className="flex items-center gap-2">
            {showToggle && (
              <div className="flex rounded-md border border-border p-0.5">
                {(['assembled', 'raw'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    className={cn(
                      'rounded px-2 py-0.5 text-xs transition-colors',
                      view === v ? 'bg-primary text-black font-medium' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {v === 'assembled' ? 'Assembled' : 'Raw SSE'}
                  </button>
                ))}
              </div>
            )}
            {showAssembled && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={downloadAssembled}
                className="h-7 gap-1.5 text-xs"
              >
                <Download className="h-3 w-3" />
                Assembled JSON
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {showAssembled
          ? <PreBlock text={JSON.stringify(assembled, null, 2)} />
          : streaming
            ? <RawSseView events={events} />
            : <PreBlock text={nonStreamPretty ?? text} />}
      </CardContent>
    </Card>
  )
}

// ─── public component ───────────────────────────────────────────────────────

export function AnatomyView({ detail }: { detail: CaptureDetail }) {
  const r = detail.request_body
  return (
    <div className="space-y-4">
      <MetaStrip detail={detail} />
      <UsageCard detail={detail} />
      {r && (
        <>
          <SystemBlocks system={r.system} />
          <ToolsBlock tools={r.tools} />
          <MessagesBlock messages={r.messages} />
        </>
      )}
      <ResponseCard detail={detail} />
      {!r && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Could not parse the request body — it may not be a JSON request, or the file is missing.
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export function AnatomyTitle({ detail }: { detail: CaptureDetail }) {
  const s = detail.summary
  return (
    <div className="flex items-center gap-2">
      <CardTitle className="text-base">{s.method} {s.path}</CardTitle>
      <Badge variant="outline" className="font-mono text-xs">{s.request_id.slice(0, 8)}</Badge>
    </div>
  )
}

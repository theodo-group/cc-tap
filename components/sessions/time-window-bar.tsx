'use client'

import { useMemo } from 'react'
import type { AgentTimeline } from '@/types/claude'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { activityBlocks, normalizeWindow, toLocalInputValue, type TimeWindow } from '@/lib/time-window'
import { formatClock, formatDayClock } from '@/lib/time-scale'
import { formatDuration } from '@/lib/decode'
import { Crop, X } from 'lucide-react'

interface Props {
  window: TimeWindow | null
  onChange(w: TimeWindow | null): void
  timeline?: AgentTimeline
  sessionStart?: number
  sessionEnd?: number
}

const GAP_THRESHOLD_MS = 30 * 60_000

export function TimeWindowBar({ window: win, onChange, timeline, sessionStart, sessionEnd }: Props) {
  const blocks = useMemo(() => (timeline ? activityBlocks(timeline, GAP_THRESHOLD_MS) : []), [timeline])
  const prompts = useMemo(() => timeline?.orchestrator.prompts ?? [], [timeline])

  const presetValue = useMemo(() => {
    if (!win) return 'all'
    const b = blocks.findIndex(x => x.start === win.from && x.end === win.to)
    if (b >= 0) return `block:${b}`
    const p = prompts.findIndex((x, i) => {
      const from = new Date(x.timestamp).getTime()
      const to = i + 1 < prompts.length ? new Date(prompts[i + 1].timestamp).getTime() : sessionEnd
      return from === win.from && to === win.to
    })
    if (p >= 0) return `prompt:${p}`
    return 'custom'
  }, [win, blocks, prompts, sessionEnd])

  const applyPreset = (v: string) => {
    if (v === 'all') return onChange(null)
    if (v === 'custom') return
    const [kind, idx] = v.split(':')
    const i = Number(idx)
    if (kind === 'block' && blocks[i]) return onChange({ from: blocks[i].start, to: blocks[i].end })
    if (kind === 'prompt' && prompts[i]) {
      const from = new Date(prompts[i].timestamp).getTime()
      const to = i + 1 < prompts.length ? new Date(prompts[i + 1].timestamp).getTime() : (sessionEnd ?? from)
      return onChange({ from, to })
    }
  }

  const setEdge = (edge: 'from' | 'to', value: string) => {
    const t = new Date(value).getTime()
    if (Number.isNaN(t)) return
    const base = win ?? { from: sessionStart ?? t, to: sessionEnd ?? t }
    onChange(normalizeWindow(edge === 'from' ? t : base.from, edge === 'to' ? t : base.to))
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Crop className="h-4 w-4" /> Window
      </span>

      <Select value={presetValue} onValueChange={applyPreset}>
        <SelectTrigger size="sm" className="min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Whole session</SelectItem>
          {presetValue === 'custom' && <SelectItem value="custom">Custom range</SelectItem>}
          {blocks.length > 1 && (
            <SelectGroup>
              <SelectLabel>Activity blocks</SelectLabel>
              {blocks.map((b, i) => (
                <SelectItem key={`block:${i}`} value={`block:${i}`}>
                  {formatDayClock(b.start)} → {formatClock(b.end)} · {formatDuration((b.end - b.start) / 60_000)}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {prompts.length > 1 && (
            <SelectGroup>
              <SelectLabel>From a human prompt to the next</SelectLabel>
              {prompts.map((p, i) => (
                <SelectItem key={`prompt:${i}`} value={`prompt:${i}`}>
                  <span className="font-mono text-xs text-muted-foreground">{formatClock(new Date(p.timestamp).getTime())}</span>{' '}
                  {p.text.length > 48 ? p.text.slice(0, 47) + '…' : p.text}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>

      <Input
        type="datetime-local"
        aria-label="Window start"
        className="h-8 w-auto text-xs"
        value={win ? toLocalInputValue(win.from) : ''}
        onChange={e => setEdge('from', e.target.value)}
      />
      <span className="text-muted-foreground">→</span>
      <Input
        type="datetime-local"
        aria-label="Window end"
        className="h-8 w-auto text-xs"
        value={win ? toLocalInputValue(win.to) : ''}
        onChange={e => setEdge('to', e.target.value)}
      />

      {win && (
        <>
          <span className="font-mono text-xs text-muted-foreground">{formatDuration((win.to - win.from) / 60_000)}</span>
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => onChange(null)}>
            <X className="h-3.5 w-3.5" /> Clear
          </Button>
        </>
      )}
      {!win && <span className="text-xs text-muted-foreground">Drag on the Agents chart to select a range.</span>}
    </div>
  )
}

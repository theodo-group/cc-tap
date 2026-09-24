'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { format } from 'date-fns'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DateRangePicker, type DateRange } from '@/components/ui/date-range-picker'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { TimeWindow } from '@/lib/time-window'
import type { UsageWindow } from '@/types/claude'

export type RangeMode = 'dates' | '5h'

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

interface Props {
  window: TimeWindow | null
  mode: RangeMode
  onChange: (window: TimeWindow | null, mode: RangeMode) => void
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
/** Last ms of the local calendar day; built from the next midnight so DST
 *  days (23h / 25h) are not off by an hour */
function endOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1
}

/** Snap to the minute so the datetime-local input and the URL agree */
function floorMinute(t: number): number {
  return Math.floor(t / 60_000) * 60_000
}

const ClearButton = ({ onClick }: { onClick: () => void }) => (
  <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" title="Clear range" onClick={onClick}>
    <X />
  </Button>
)

/**
 * Time range control for the sessions list. `dates` picks two calendar days
 * (local, inclusive); `5h` picks a precise start and derives the end as
 * start + 5h, the length of the subscription usage window.
 */
export function RangeFilter({ window: w, mode, onChange }: Props) {
  // Half-picked calendar range, before both days are known
  const [draft, setDraft] = useState<DateRange>({})
  const { data: windowsData } = useSWR<{ windows: UsageWindow[] }>(
    mode === '5h' ? '/api/usage-windows' : null,
    fetcher,
    { refreshInterval: 60_000 },
  )
  const knownWindows = windowsData?.windows ?? []

  const dateValue: DateRange = useMemo(() => {
    if (draft.from && !draft.to) return draft
    if (w) return { from: new Date(w.from), to: new Date(w.to) }
    return {}
  }, [draft, w])

  const selectedKnown = w ? knownWindows.find(k => k.start === w.from && k.reset === w.to) : undefined

  function setMode(next: RangeMode) {
    if (next === mode) return
    setDraft({})
    if (next === '5h' && w) {
      // keep the start, re-derive the end
      const from = floorMinute(w.from)
      onChange({ from, to: from + FIVE_HOURS_MS }, next)
    } else if (next === 'dates' && w) {
      onChange({ from: startOfDay(new Date(w.from)), to: endOfDay(new Date(w.to)) }, next)
    } else {
      onChange(null, next)
    }
  }

  function clear() {
    setDraft({})
    onChange(null, mode)
  }

  function setStart(from: number) {
    onChange({ from, to: from + FIVE_HOURS_MS }, '5h')
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs value={mode} onValueChange={v => setMode(v as RangeMode)}>
        <TabsList>
          <TabsTrigger value="dates">Dates</TabsTrigger>
          <TabsTrigger value="5h">5h window</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === 'dates' && (
        <>
          <DateRangePicker
            align="start"
            placeholder="Pick two dates"
            value={dateValue}
            onChange={range => {
              if (range.from && range.to) {
                setDraft({})
                onChange({ from: startOfDay(range.from), to: endOfDay(range.to) }, 'dates')
              } else {
                setDraft(range)
              }
            }}
          />
          {w && <ClearButton onClick={clear} />}
        </>
      )}

      {mode === '5h' && (
        <>
          <span className="text-[13px] text-muted-foreground">from</span>
          <DateTimePicker value={w ? w.from : null} onChange={setStart} placeholder="Pick a start time" />
          <span className="text-[13px] text-muted-foreground font-mono">
            → {w ? format(w.to, 'MMM d HH:mm') : '+5h'}
          </span>
          {w && <ClearButton onClick={clear} />}
          <Button variant="outline" size="sm" onClick={() => setStart(floorMinute(Date.now() - FIVE_HOURS_MS))}>
            Last 5h
          </Button>
          {knownWindows.length > 0 && (
            <Select
              value={selectedKnown ? String(selectedKnown.reset) : ''}
              onValueChange={v => {
                const k = knownWindows.find(x => String(x.reset) === v)
                if (k) onChange({ from: k.start, to: k.reset }, '5h')
              }}
            >
              <SelectTrigger size="sm" className="w-auto text-[13px]">
                <SelectValue placeholder="5h limit reached…" />
              </SelectTrigger>
              <SelectContent>
                {knownWindows.map(k => (
                  <SelectItem key={k.reset} value={String(k.reset)} className="font-mono text-[12px]">
                    {format(k.first_hit_at, 'd MMM')} · {format(k.start, 'HH:mm')} → {format(k.reset, 'HH:mm')} · limit reached {format(k.first_hit_at, 'HH:mm')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </>
      )}

    </div>
  )
}

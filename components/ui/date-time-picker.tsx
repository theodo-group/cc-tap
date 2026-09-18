'use client'

import { useState } from 'react'
import { Clock } from 'lucide-react'
import { format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface Props {
  /** ms since epoch, or null when nothing is picked */
  value: number | null
  onChange: (t: number) => void
  placeholder?: string
  /** minute granularity of the minute picker */
  minuteStep?: number
  align?: 'start' | 'end'
  className?: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Day + hour + minute picker in a popover, styled like the app's calendar
 *  (the native datetime-local input cannot be themed). */
export function DateTimePicker({ value, onChange, placeholder = 'Pick a time', minuteStep = 5, align = 'start', className }: Props) {
  const [open, setOpen] = useState(false)
  const d = value === null ? null : new Date(value)
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const minutes = Array.from({ length: 60 / minuteStep }, (_, i) => i * minuteStep)
  // A picked minute that is off-step (e.g. from a URL) still has to be listed
  if (d && !minutes.includes(d.getMinutes())) {
    minutes.push(d.getMinutes())
    minutes.sort((a, b) => a - b)
  }

  function emit(day: Date, h: number, m: number) {
    onChange(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime())
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={d ? 'default' : 'outline'} size="sm" className={`gap-2 font-mono ${className ?? ''}`}>
          <Clock className="w-3.5 h-3.5" />
          {d ? format(d, 'MMM d, yyyy HH:mm') : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={align}>
        <Calendar
          mode="single"
          selected={d ?? undefined}
          defaultMonth={d ?? undefined}
          onSelect={day => { if (day) emit(day, d?.getHours() ?? 9, d?.getMinutes() ?? 0) }}
          disabled={{ after: new Date() }}
          initialFocus
        />
        <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[13px] text-muted-foreground">
          <span>at</span>
          <Select
            value={d ? String(d.getHours()) : ''}
            onValueChange={v => emit(d ?? new Date(), Number(v), d?.getMinutes() ?? 0)}
          >
            <SelectTrigger size="sm" className="w-[4.5rem] font-mono"><SelectValue placeholder="hh" /></SelectTrigger>
            <SelectContent className="max-h-64">
              {hours.map(h => <SelectItem key={h} value={String(h)} className="font-mono">{pad(h)}</SelectItem>)}
            </SelectContent>
          </Select>
          <span>:</span>
          <Select
            value={d ? String(d.getMinutes()) : ''}
            onValueChange={v => emit(d ?? new Date(), d?.getHours() ?? 9, Number(v))}
          >
            <SelectTrigger size="sm" className="w-[4.5rem] font-mono"><SelectValue placeholder="mm" /></SelectTrigger>
            <SelectContent className="max-h-64">
              {minutes.map(m => <SelectItem key={m} value={String(m)} className="font-mono">{pad(m)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  )
}

'use client'

import { useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'

export type DateRange = { from?: Date; to?: Date }

interface Props {
  value: DateRange
  onChange: (range: DateRange) => void
  /** Button label when no complete range is selected */
  placeholder?: string
  align?: 'start' | 'end'
  /** Days after this one cannot be picked; defaults to today */
  maxDate?: Date
  className?: string
}

/** Calendar range picker in a popover; closes once both ends are picked */
export function DateRangePicker({ value, onChange, placeholder = 'Pick a date', align = 'end', maxDate, className }: Props) {
  const [open, setOpen] = useState(false)
  const complete = !!(value.from && value.to)
  const label = complete
    ? `${format(value.from!, 'MMM d')} – ${format(value.to!, 'MMM d, yyyy')}`
    : placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={complete ? 'default' : 'outline'} size="sm" className={`gap-2 ${className ?? ''}`}>
          <CalendarDays className="w-3.5 h-3.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={align}>
        <Calendar
          mode="range"
          selected={{ from: value.from, to: value.to }}
          onSelect={range => {
            onChange({ from: range?.from, to: range?.to })
            if (range?.from && range?.to) setOpen(false)
          }}
          disabled={{ after: maxDate ?? new Date() }}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  )
}

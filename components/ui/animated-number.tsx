'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface AnimatedNumberProps {
  /** Target numeric value to animate toward. */
  value: number
  /** Format the (fractional, mid-tween) value into display text. */
  format?: (n: number) => string
  /** Tween length in ms. */
  duration?: number
  className?: string
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * Counts up to `value` with requestAnimationFrame: from 0 on first appearance,
 * then from the previous value on subsequent changes. Honors reduced-motion by
 * snapping straight to the target. These figures are populated from client-side
 * data, so there is no SSR value to mismatch.
 */
export function AnimatedNumber({
  value,
  format = n => Math.round(n).toLocaleString(),
  duration = 650,
  className,
}: AnimatedNumberProps) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const to = value
    const from = startedRef.current ? fromRef.current : 0
    startedRef.current = true

    if (reduce || from === to) {
      setDisplay(to)
      fromRef.current = to
      return
    }

    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const current = from + (to - from) * easeOutCubic(t)
      setDisplay(current)
      fromRef.current = current
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = to
        setDisplay(to)
      }
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [value, duration])

  // The tweening digits are decorative; expose only the settled value to AT so
  // screen readers aren't spammed with every intermediate frame.
  return (
    <span className={cn('tabular-nums', className)}>
      <span aria-hidden="true">{format(display)}</span>
      <span className="sr-only">{format(value)}</span>
    </span>
  )
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** Number of fast clicks that opens the tap. */
const TAPS_TO_OPEN = 10
/** Maximum delay between two clicks for them to count as "fast" (ms). */
const FAST_CLICK_WINDOW_MS = 600
/** How long the water tap stays before the logo reads "CC Tap" again (ms). */
const TAP_OPEN_DURATION_MS = 6000

/**
 * The pixel-font "CC Tap" badge in the sidebar header.
 *
 * Fast repeated clicks switch the badge to its water tap state for a few
 * seconds, then it goes back to "CC Tap".
 */
export function SidebarLogo() {
  const [open, setOpen] = useState(false)
  /* True while the badge plays its wrap animation (on open and on close). */
  const [wrapping, setWrapping] = useState(false)
  const clicks = useRef(0)
  const lastClickAt = useRef(0)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  function handleClick() {
    if (open) return
    const now = Date.now()
    clicks.current = now - lastClickAt.current <= FAST_CLICK_WINDOW_MS ? clicks.current + 1 : 1
    lastClickAt.current = now
    if (clicks.current < TAPS_TO_OPEN) return

    clicks.current = 0
    setOpen(true)
    setWrapping(true)
    closeTimer.current = setTimeout(() => {
      setOpen(false)
      setWrapping(true)
    }, TAP_OPEN_DURATION_MS)
  }

  return (
    <span
      onClick={handleClick}
      onAnimationEnd={() => setWrapping(false)}
      className={cn(
        'relative inline-block rounded-md px-2.5 py-1.5 text-[12px] leading-snug tracking-[0.06em]',
        'whitespace-nowrap select-none cursor-default',
        /* Light: readable terracotta on soft tint — no heavy dark-game shadow */
        'text-[#9a3412]',
        'bg-linear-to-b from-[#f97316]/14 to-[#f97316]/6',
        'ring-1 ring-inset ring-[#f97316]/28',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_1px_3px_rgba(24,24,27,0.08)]',
        /* Dark: retro glow */
        'dark:text-[#c2703a]',
        'dark:from-[#c2703a]/18 dark:to-[#c2703a]/8 dark:ring-[#c2703a]/40',
        'dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_22px_-8px_rgba(194,112,58,0.45)]',
        '[-webkit-text-stroke:0.35px_rgba(124,45,18,0.35)] dark:[-webkit-text-stroke:0.45px_#b56230]',
        /* Pops like a push button on each click */
        'transition-[transform,filter,box-shadow] duration-150 ease-out',
        'active:scale-[0.92] active:translate-y-px active:brightness-95',
        'active:shadow-[inset_0_2px_3px_rgba(24,24,27,0.18)] dark:active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.5)]',
        /* The badge wraps around when the tap opens or closes */
        wrapping && 'cctap-wrap',
        open && 'text-sky-700 dark:text-sky-300 from-sky-400/20 to-sky-400/8 ring-sky-400/40 dark:from-sky-300/18 dark:to-sky-300/8 dark:ring-sky-300/40',
        open && '[-webkit-text-stroke:0] dark:[-webkit-text-stroke:0]',
      )}
      style={{ fontFamily: 'var(--font-press-start)' }}
    >
      <span
        className={cn(
          'inline-block',
          !open && 'dark:[text-shadow:0_1px_0_#5c2a0c,0_2px_0_#3d1c08,0_3px_6px_rgba(0,0,0,0.35)] [text-shadow:0_1px_0_rgba(255,255,255,0.4)]',
        )}
      >
        {open ? (
          <span className="inline-flex items-center gap-2">
            <span>CC</span>
            <PixelTap />
          </span>
        ) : 'CC Tap'}
      </span>
    </span>
  )
}

/**
 * Pixel-art kitchen faucet on a 16x10 grid, to match the pixel font.
 * `#` body, `L` light edge, `D` shaded edge, `H`/`h` handle (light / body).
 * Read the map top to bottom: lever handle, gooseneck, pillar, spout, base.
 */
const TAP_MAP = [
  '......Hhh.......',
  '.......h........',
  '...LLLLLLLL.....',
  '..L########D....',
  '..L#D....L##D...',
  '..L#D......L#D..',
  '..L#D......L#D..',
  '..L#D......###..',
  '..L#D......DDD..',
  '.L###D..........',
]
/* Chrome palette: light steel body, near-white specular edge, dark steel shade. */
const TAP_FILL: Record<string, string> = {
  '#': 'fill-zinc-400 dark:fill-zinc-300',
  'L': 'fill-zinc-200 dark:fill-white',
  'D': 'fill-zinc-600 dark:fill-zinc-500',
  'H': 'fill-zinc-200 dark:fill-white',
  'h': 'fill-zinc-400 dark:fill-zinc-300',
}

function pixels(rows: string[], pick: (c: string) => boolean) {
  const out: { x: number; y: number; c: string }[] = []
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c !== '.' && pick(c)) out.push({ x, y, c }) }))
  return out
}

/** The water stream and the splash are drawn below the grid; the SVG has
 *  `overflow: visible` so they flow out of the badge. */
function PixelTap() {
  const water = 'stroke-sky-400 dark:stroke-sky-300'
  const handle = pixels(TAP_MAP, c => c === 'H' || c === 'h')
  const body = pixels(TAP_MAP, c => c !== 'H' && c !== 'h')
  const STREAM_X = 12.5
  const STREAM_TOP = 9
  const STREAM_END = 20
  return (
    <svg
      role="img"
      aria-label="water tap"
      viewBox="0 0 16 10"
      width={26}
      height={16.25}
      shapeRendering="crispEdges"
      className="overflow-visible shrink-0"
    >
      {/* Lever handle: turns when the tap opens */}
      <g className="cctap-handle">
        {handle.map(({ x, y, c }) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" className={TAP_FILL[c]} />
        ))}
      </g>
      {body.map(({ x, y, c }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" className={TAP_FILL[c]} />
      ))}

      {/* Water stream: a steady core and a flowing dashed layer */}
      <g className="cctap-stream" fill="none" strokeLinecap="butt">
        <line x1={STREAM_X} y1={STREAM_TOP} x2={STREAM_X} y2={STREAM_END} strokeWidth="1.4" className={cn(water, 'opacity-45')} />
        <line
          x1={STREAM_X} y1={STREAM_TOP} x2={STREAM_X} y2={STREAM_END} strokeWidth="1.4"
          strokeDasharray="2.5 1.5"
          className={cn(water, 'cctap-flow')}
        />
        <line x1={STREAM_X - 0.45} y1={STREAM_TOP} x2={STREAM_X - 0.45} y2={STREAM_END - 2} strokeWidth="0.3" className="stroke-white/70 dark:stroke-white/60" />
      </g>

      {/* Splash: ripples and two bouncing droplets */}
      <g className="cctap-splash">
        {[0, 0.6].map(delay => (
          <ellipse
            key={delay}
            cx={STREAM_X} cy={STREAM_END + 0.5} rx="1" ry="0.45"
            fill="none" strokeWidth="0.6"
            className={cn(water, 'cctap-ripple')}
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
        <rect x={STREAM_X - 2.6} y={STREAM_END - 0.3} width="0.8" height="0.8" className="fill-sky-400 dark:fill-sky-300 cctap-splash-l" />
        <rect x={STREAM_X + 1.8} y={STREAM_END - 0.3} width="0.8" height="0.8" className="fill-sky-400 dark:fill-sky-300 cctap-splash-r" style={{ animationDelay: '0.35s' }} />
      </g>
    </svg>
  )
}

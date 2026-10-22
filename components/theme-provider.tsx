'use client'

import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'dark' | 'light'

/** Optional screen coordinates the circular reveal should grow from. */
type ToggleOrigin = { x: number; y: number }

type ViewTransitionDocument = Document & {
  startViewTransition?: (cb: () => void) => { ready: Promise<void> }
}

const ThemeContext = createContext<{
  theme: Theme
  toggle: (origin?: ToggleOrigin) => void
  mounted: boolean
}>({
  theme: 'dark',
  toggle: () => {},
  mounted: false,
})

export function useTheme() {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Always start as 'dark' so the first client render matches the server and
  // avoids a hydration mismatch; the real theme is read from localStorage
  // after mount.
  const [theme, setTheme] = useState<Theme>('dark')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // Deliberate one-time sync from localStorage after mount: starting from a
    // fixed 'dark' keeps the first client render identical to SSR, then we adopt
    // the persisted theme. This is an external-store read, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark')
    setMounted(true)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  function toggle(origin?: ToggleOrigin) {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    // Persisting is best-effort: storage can be unavailable (private mode,
    // blocked cookies). Don't let a write failure break the toggle.
    try {
      localStorage.setItem('theme', next)
    } catch {
      // ignore — the theme still flips for this session
    }

    const applyClass = () => {
      document.documentElement.classList.toggle('dark', next === 'dark')
    }

    const doc = document as ViewTransitionDocument
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // No View Transitions (or reduced motion): flip instantly, but for everyone
    // else paint a brief global color crossfade so the swap isn't a hard cut.
    if (!doc.startViewTransition || prefersReduced) {
      if (!prefersReduced) {
        const root = document.documentElement
        root.classList.add('theme-transition')
        window.setTimeout(() => root.classList.remove('theme-transition'), 320)
      }
      applyClass()
      setTheme(next)
      return
    }

    // Reveal the new theme as a circle expanding from the toggle (or the
    // bottom-right corner if we weren't handed a click position).
    const x = origin?.x ?? window.innerWidth - 48
    const y = origin?.y ?? window.innerHeight - 48
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    )

    const transition = doc.startViewTransition(applyClass)
    transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${endRadius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 480,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          pseudoElement: '::view-transition-new(root)',
        }
      )
    })

    setTheme(next)
  }

  return (
    <ThemeContext.Provider value={{ theme, toggle, mounted }}>
      {children}
    </ThemeContext.Provider>
  )
}

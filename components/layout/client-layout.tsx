'use client'

import { usePathname } from 'next/navigation'
import { useSidebar } from '@/components/layout/sidebar-context'

export function ClientLayout({ children, demo = false }: { children: React.ReactNode; demo?: boolean }) {
  const { collapsed } = useSidebar()
  const pathname = usePathname()
  return (
    <main
      className={[
        'flex-1 min-h-screen overflow-x-hidden bg-background pb-16 md:pb-0',
        'transition-[margin] duration-300',
        collapsed ? 'md:ml-14' : 'md:ml-56',
      ].join(' ')}
    >
      {demo && (
        <div className="sticky top-0 z-30 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-primary/30 bg-primary/10 px-4 py-2 text-center text-xs text-foreground backdrop-blur">
          <span className="font-medium text-primary">● Demo data</span>
          <span className="text-muted-foreground">
            Fictional sample, not anyone&apos;s real history. Run{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">npx cc-tap</code> to see your own.
          </span>
          <a
            href="https://github.com/theodo-group/cc-tap"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
          >
            Get it on GitHub
          </a>
        </div>
      )}
      {/* Re-key per route so the page-enter reveal replays on every navigation */}
      <div key={pathname} className="t-page-enter">
        {children}
      </div>
      <footer className="border-t border-border/50 py-3 px-6 flex items-center justify-center mb-16 md:mb-0">
        <p className="text-xs text-muted-foreground">
          Made by{' '}
          <a
            href="https://github.com/Arindam200"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
          >
            Arindam
          </a>
        </p>
      </footer>
    </main>
  )
}

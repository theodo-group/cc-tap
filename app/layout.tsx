import type { Metadata } from 'next'
import { Geist, Geist_Mono, Press_Start_2P } from 'next/font/google'
import './globals.css'
import { Sidebar } from '@/components/layout/sidebar'
import { BottomNav } from '@/components/layout/bottom-nav'
import { ThemeProvider } from '@/components/theme-provider'
import { KeyboardNavProvider } from '@/components/keyboard-nav-provider'
import { SidebarProvider } from '@/components/layout/sidebar-context'
import { ClientLayout } from '@/components/layout/client-layout'
import { ToastProvider } from '@/components/ui/toast'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

const pressStart2P = Press_Start_2P({
  variable: '--font-press-start',
  weight: '400',
  subsets: ['latin'],
})

const FALLBACK_SITE_URL = 'https://github.com/theodo-group/cc-tap'
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? FALLBACK_SITE_URL
const OG_DESCRIPTION =
  'See what you actually did with Claude Code — usage, costs, sessions, and tools, straight from your ~/.claude/. No cloud, no telemetry. npx cc-tap'

// A malformed NEXT_PUBLIC_SITE_URL would otherwise throw at module load and
// crash the whole app; fall back to the known-good URL instead.
function resolveMetadataBase(): URL {
  try {
    return new URL(SITE_URL)
  } catch {
    return new URL(FALLBACK_SITE_URL)
  }
}

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: 'Claude Code Lens',
  description: OG_DESCRIPTION,
  keywords: ['claude code', 'anthropic', 'analytics', 'dashboard', 'developer tools', 'local-first'],
  openGraph: {
    title: 'Claude Code Lens — local analytics for Claude Code',
    description: OG_DESCRIPTION,
    url: SITE_URL,
    siteName: 'Claude Code Lens',
    type: 'website',
    images: [{ url: '/dashboard-dark.png', width: 1200, height: 630, alt: 'Claude Code Lens dashboard' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Claude Code Lens — local analytics for Claude Code',
    description: OG_DESCRIPTION,
    images: ['/dashboard-dark.png'],
  },
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('theme');document.documentElement.classList.toggle('dark',t!=='light')}catch(e){}})()` }} />
      </head>
      <body suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${pressStart2P.variable} antialiased`}>
        <ThemeProvider>
          <ToastProvider>
            <SidebarProvider>
              <div className="flex min-h-screen">
                <Sidebar />
                <ClientLayout demo={!!process.env.CC_LENS_DEMO}>{children}</ClientLayout>
              </div>
              <BottomNav />
              <KeyboardNavProvider />
            </SidebarProvider>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}

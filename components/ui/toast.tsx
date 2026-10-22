'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

type ToastVariant = 'success' | 'error' | 'info'

interface ToastInput {
  title: string
  description?: string
  variant?: ToastVariant
}

interface ToastItem extends Required<Omit<ToastInput, 'description'>> {
  id: number
  description?: string
}

interface ToastContextValue {
  toast: (input: ToastInput) => void
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

let counter = 0

const ICONS: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
}

const ICON_COLOR: Record<ToastVariant, string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-red-500',
  info: 'text-primary',
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useCallback<ToastContextValue['toast']>(
    ({ title, description, variant = 'success' }) => {
      const id = ++counter
      setToasts(prev => [...prev, { id, title, description, variant }])
    },
    []
  )

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Polite live region so screen readers announce each toast as it lands. */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2"
      >
        {toasts.map(item => (
          <Toast key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function Toast({
  item,
  onDismiss,
}: {
  item: ToastItem
  onDismiss: (id: number) => void
}) {
  const [leaving, setLeaving] = useState(false)
  const Icon = ICONS[item.variant]

  // Auto-dismiss: start the leave animation, then unmount once it has played.
  useEffect(() => {
    const t = window.setTimeout(() => setLeaving(true), 3400)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!leaving) return
    const t = window.setTimeout(() => onDismiss(item.id), 200)
    return () => window.clearTimeout(t)
  }, [leaving, item.id, onDismiss])

  return (
    <div
      role="status"
      className={cn(
        't-toast pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-popover/95 px-4 py-3 shadow-lg backdrop-blur',
        leaving && 'is-leaving'
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', ICON_COLOR[item.variant])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-tight text-foreground">{item.title}</p>
        {item.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => setLeaving(true)}
        aria-label="Dismiss notification"
        className="-mr-1 -mt-0.5 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

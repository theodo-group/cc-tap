'use client'

import { useEffect, useRef } from 'react'
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { ReplayHit } from '@/lib/replay-search'

interface Props {
  /** false when the bar is folded to its loupe */
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (q: string) => void
  caseSensitive: boolean
  onCaseSensitiveChange: (on: boolean) => void
  exact: boolean
  onExactChange: (on: boolean) => void
  hits: ReplayHit[]
  /** position in `hits` of the turn the reader is on; -1 when there is none */
  current: number
  onStep: (delta: number) => void
  /** `floating` hangs at the bottom of the screen, for the Replay tab;
   *  `sticky` rides at the top of its own scroll box, for a drawer */
  placement?: 'floating' | 'sticky'
}

/**
 * Search bar over the whole conversation. It shows the number of hits, steps
 * through them with the arrows, Enter (next) and Shift+Enter (previous), and
 * takes the focus on Cmd/Ctrl+F. The loupe folds it away and back.
 */
export function ReplaySearch({ open, onOpenChange, query, onQueryChange, caseSensitive, onCaseSensitiveChange, exact, onExactChange, hits, current, onStep, placement = 'floating' }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' || !(e.metaKey || e.ctrlKey)) return
      // A drawer holds its own bar; the one behind it lets the shortcut pass
      if (placement === 'floating' && document.querySelector('[role="dialog"][data-state="open"]')) return
      e.preventDefault()
      const input = inputRef.current
      // Text selected in the conversation becomes the query, as a browser find does
      const picked = selectedText(input)
      if (picked) onQueryChange(picked)
      onOpenChange(true)
      input?.focus()
      input?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onQueryChange, onOpenChange, placement])

  // Focus the field when the loupe opens the bar, not on the first render
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current) { inputRef.current?.focus(); inputRef.current?.select() }
    wasOpen.current = open
  }, [open])

  // Stepping keeps the cursor in the field, so Enter and Escape keep working
  const step = (delta: number) => { onStep(delta); inputRef.current?.focus() }

  const none = query.trim().length > 0 && hits.length === 0

  if (!open) {
    const loupe = (
      <Button
        variant="outline"
        size="icon"
        onClick={() => onOpenChange(true)}
        aria-label="Search the conversation"
        aria-expanded={false}
        title="Search the conversation (⌘F)"
        className={placement === 'floating'
          // bottom-20 on a phone: the nav bar owns the bottom of the screen there
          ? 'fixed bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-full bg-background/95 shadow-lg backdrop-blur md:bottom-6'
          : 'rounded-full bg-background/95 shadow-md backdrop-blur'}
      >
        <Search className="h-4 w-4" />
      </Button>
    )
    if (placement === 'floating') return loupe
    // In a drawer the loupe rides at the top of the panel, so the reader sees
    // the search is there while scrolling the conversation. A drawer is moved
    // by a transform, which a fixed position would measure against.
    return <div className="sticky top-0 z-30 mb-1 flex justify-end">{loupe}</div>
  }

  return (
    /* Floating, like a find bar: the replay list is scrolled by the window, so
       a bar in the flow of the list would leave the screen at the first hit. In
       a drawer the panel itself scrolls, so the bar only has to stick to it. */
    <div className={placement === 'floating'
      ? 'fixed bottom-20 left-1/2 z-40 flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-background/95 px-2 py-2 shadow-lg backdrop-blur md:bottom-6 md:gap-2'
      : 'sticky top-0 z-30 mb-2 flex items-center gap-1 rounded-xl border border-border bg-background/95 px-2 py-2 shadow-sm backdrop-blur'}>
      <Button
        variant="ghost" size="icon-sm"
        onClick={() => onOpenChange(false)}
        aria-label="Close the search"
        aria-expanded
        title="Close the search (⌘F reopens it)"
        className="text-muted-foreground"
      >
        <Search className="h-4 w-4" />
      </Button>
      <Input
        ref={inputRef}
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); onStep(e.shiftKey ? -1 : 1) }
          // Escape drops the query, then folds the bar away. It stops there: in a
          // drawer it would otherwise close the drawer itself.
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            if (query) onQueryChange(''); else onOpenChange(false)
          }
        }}
        // Short enough to fit the field on a phone; the shortcuts live in the titles
        placeholder={exact ? 'Exact text' : 'Word by word'}
        title="Enter for the next hit, Shift+Enter for the one before" 
        aria-label="Search the conversation"
        className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      {query.length > 0 && (
        <Button
          variant="ghost" size="icon-xs"
          onClick={() => { onQueryChange(''); inputRef.current?.focus() }}
          aria-label="Clear the search"
          title="Clear the text"
          className="-ml-1 shrink-0 text-muted-foreground/70 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
      <span
        className={`shrink-0 text-xs tabular-nums ${none ? 'text-destructive' : 'text-muted-foreground'}`}
        aria-live="polite"
      >
        {query.trim().length === 0
          ? ''
          : hits.length === 0
            ? 'No hits'
            : `${current >= 0 ? current + 1 : 1}/${hits.length} turns`}
      </span>
      <Button
        variant="ghost" size="icon-sm"
        aria-pressed={exact}
        aria-label="Exact text"
        title="Exact text: the query as typed, in one piece. Off, every word is looked for on its own, loosely."
        onClick={() => onExactChange(!exact)}
        className={exact ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}
      >
        <span className="text-[11px] font-semibold">&quot;&quot;</span>
      </Button>
      <Button
        variant="ghost" size="icon-sm"
        aria-pressed={caseSensitive}
        aria-label="Match case"
        title="Match case"
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
        className={caseSensitive ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}
      >
        <span className="text-[11px] font-semibold">Aa</span>
      </Button>
      <Button
        variant="ghost" size="icon-sm"
        disabled={hits.length === 0}
        onClick={() => step(-1)}
        aria-label="Previous hit"
      >
        <ChevronUp className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost" size="icon-sm"
        disabled={hits.length === 0}
        onClick={() => step(1)}
        aria-label="Next hit"
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
    </div>
  )
}

/** The selected text, on one line and capped, or '' when the selection is empty
 *  or is inside the search field itself */
function selectedText(input: HTMLInputElement | null): string {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return ''
  if (input && input.contains(sel.anchorNode)) return ''
  return sel.toString().replace(/\s+/g, ' ').trim().slice(0, 200)
}

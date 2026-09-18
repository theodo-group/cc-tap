'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { SessionBadges } from './session-badges'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatCost, formatDuration, formatDateTime, formatTokens, projectDisplayName } from '@/lib/decode'
import { metricTokens, sessionMetrics } from '@/lib/session-ledger'
import type { SessionMetrics, SessionWithFacet, SessionsRangeSummary } from '@/types/claude'

const PAGE_SIZE = 25

type SortKey = 'start_time' | 'duration_minutes' | 'total_messages' | 'estimated_cost' | 'tool_calls' | 'total_tokens'
type SortDir = 'asc' | 'desc'

interface Props {
  sessions: SessionWithFacet[]
  /** Set when the list was fetched for a time range; rows then carry a `slice` */
  range?: SessionsRangeSummary
}

/** The numbers a row displays and sorts on. When the list is restricted to a
 *  time range they come from the slice, and `whole` keeps the full-session
 *  values for the hover. */
interface RowMetrics {
  shown: SessionMetrics
  whole?: SessionMetrics
  agentCount: number
}

function rowMetrics(s: SessionWithFacet): RowMetrics {
  const whole = sessionMetrics(s)
  const agentCount = s.agent_count ?? 0
  return s.slice ? { shown: s.slice, whole, agentCount } : { shown: whole, agentCount }
}

function SortHeader({
  label, k, sortKey, sortDir, onSort,
}: {
  label: string
  k: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
}) {
  const active = sortKey === k
  return (
    <button
      onClick={() => onSort(k)}
      className={`text-left text-[12px] font-bold uppercase tracking-wider whitespace-nowrap hover:text-foreground transition-colors ${active ? 'text-primary' : 'text-muted-foreground'}`}
    >
      {label} {active ? (sortDir === 'desc' ? '↓' : '↑') : ''}
    </button>
  )
}

export function SessionTable({ sessions, range }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('start_time')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [page, setPage] = useState(1)
  const [filterCompacted, setFilterCompacted] = useState(false)
  const [filterAgent, setFilterAgent] = useState(false)
  const [filterMcp, setFilterMcp] = useState(false)
  const [search, setSearch] = useState('')
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null)
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([])
  const router = useRouter()

  const filtered = useMemo(() => {
    let s = sessions
    if (filterCompacted) s = s.filter(x => x.has_compaction)
    if (filterAgent)     s = s.filter(x => x.uses_task_agent)
    if (filterMcp)       s = s.filter(x => x.uses_mcp)
    if (search) {
      const q = search.toLowerCase()
      s = s.filter(x =>
        x.project_path?.toLowerCase().includes(q) ||
        x.first_prompt?.toLowerCase().includes(q) ||
        x.ai_title?.toLowerCase().includes(q) ||
        x.slug?.toLowerCase().includes(q)
      )
    }
    return s
  }, [sessions, filterCompacted, filterAgent, filterMcp, search])

  // Sorting and cells read the same numbers, sliced to the range when one is set
  const metrics = useMemo(() => {
    const m = new Map<string, RowMetrics>()
    for (const s of sessions) m.set(s.session_id, rowMetrics(s))
    return m
  }, [sessions])

  const sorted = useMemo(() => {
    const value = (s: SessionWithFacet): number => {
      const m = metrics.get(s.session_id)!
      switch (sortKey) {
        case 'start_time': return new Date(s.start_time).getTime()
        case 'duration_minutes': return m.shown.duration_minutes
        case 'total_messages': return messages(m.shown)
        case 'tool_calls': return m.shown.tool_calls
        case 'total_tokens': return metricTokens(m.shown)
        case 'estimated_cost': return m.shown.estimated_cost
      }
    }
    return [...filtered].sort((a, b) => {
      const av = value(a), bv = value(b)
      return sortDir === 'desc' ? bv - av : av - bv
    })
  }, [filtered, metrics, sortKey, sortDir])

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
  const paginated = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // j/k keyboard navigation for rows
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const el = document.activeElement
      const tag = el?.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (el as HTMLElement)?.isContentEditable) return

      if (e.key === 'j') {
        e.preventDefault()
        setFocusedIdx(i => {
          const next = i === null ? 0 : Math.min(i + 1, paginated.length - 1)
          rowRefs.current[next]?.scrollIntoView({ block: 'nearest' })
          return next
        })
      } else if (e.key === 'k') {
        e.preventDefault()
        setFocusedIdx(i => {
          const next = i === null ? 0 : Math.max(i - 1, 0)
          rowRefs.current[next]?.scrollIntoView({ block: 'nearest' })
          return next
        })
      } else if (e.key === 'Enter' && focusedIdx !== null) {
        const s = paginated[focusedIdx]
        if (s) router.push(`/sessions/${s.session_id}`)
      } else if (e.key === 'Escape' && focusedIdx !== null) {
        setFocusedIdx(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focusedIdx, paginated, router])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
    setPage(1)
    setFocusedIdx(null)
  }

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="text"
          placeholder="Search project or prompt..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); setFocusedIdx(null) }}
          className="bg-muted border border-border rounded px-2 py-1 text-[13px] text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 w-52"
        />
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
          <input
            type="checkbox"
            checked={filterCompacted}
            onChange={e => { setFilterCompacted(e.target.checked); setPage(1); setFocusedIdx(null) }}
            className="accent-amber-500"
          />
          ⚡ compacted
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
          <input
            type="checkbox"
            checked={filterAgent}
            onChange={e => { setFilterAgent(e.target.checked); setPage(1); setFocusedIdx(null) }}
            className="accent-purple-500"
          />
          🤖 agent
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
          <input
            type="checkbox"
            checked={filterMcp}
            onChange={e => { setFilterMcp(e.target.checked); setPage(1); setFocusedIdx(null) }}
            className="accent-blue-500"
          />
          🔌 mcp
        </label>
        <span className="ml-auto text-[13px] text-muted-foreground">
          {range ? (
            <>
              <span className="text-foreground">{range.sessions}</span> sessions ·{' '}
              <span className="text-foreground">{formatTokens(range.tokens)}</span> tokens ·{' '}
              <span className="text-primary font-mono">{formatCost(range.cost)}</span> in this range
              {filtered.length !== range.sessions && <> · {filtered.length} shown</>}
            </>
          ) : (
            <>{filtered.length} sessions</>
          )}
        </span>
      </div>

      {/* Table; one tooltip provider for every cost cell rather than one per row */}
      <TooltipProvider delayDuration={100}>
      <div className="border border-border rounded overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted">
                <th className="px-3 py-2 text-left"><SortHeader label="Date" k="start_time" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} /></th>
                <th className="px-3 py-2 text-left"><span className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Project</span></th>
                <th className="px-3 py-2 text-right"><SortHeader label="Dur" k="duration_minutes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} /></th>
                <th className="px-3 py-2 text-right"><SortHeader label="Msgs" k="total_messages" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} /></th>
                <th className="px-3 py-2 text-right"><SortHeader label="Tools" k="tool_calls" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} /></th>
                <th className="px-3 py-2 text-right"><SortHeader label="Tokens" k="total_tokens" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} /></th>
                <th className="px-3 py-2 text-right"><SortHeader label="Cost" k="estimated_cost" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} /></th>
                <th className="px-3 py-2 text-left"><span className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Flags</span></th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((s, i) => {
                const m = metrics.get(s.session_id)!
                const projectName = projectDisplayName(s.project_path ?? '')
                const sessionTitle = s.ai_title || s.first_prompt

                return (
                  <tr
                    key={s.session_id}
                    ref={el => { rowRefs.current[i] = el }}
                    className={[
                      'border-b border-border/50 hover:bg-muted transition-colors',
                      i % 2 === 0 ? '' : 'bg-muted/30',
                      i === focusedIdx ? 'ring-2 ring-primary ring-inset bg-muted' : '',
                    ].join(' ')}
                  >
                    <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{formatDateTime(s.start_time)}</span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="font-mono text-xs">
                          {formatDateTime(s.start_time)} → {formatDateTime(s.last_activity ?? s.start_time)}
                        </TooltipContent>
                      </Tooltip>
                      {s.slice?.partial && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="ml-1.5 px-1 rounded text-[10px] uppercase tracking-wider bg-amber-500/15 text-amber-500 cursor-help">partial</span>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="text-xs">
                            Session extends outside the range; metrics count only the turns inside it
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </td>
                    <td className="px-3 py-2 max-w-[200px]">
                      <Link
                        href={`/sessions/${s.session_id}`}
                        className="text-foreground hover:text-primary transition-colors font-medium truncate block"
                        title={s.project_path ?? ''}
                      >
                        {projectName}
                      </Link>
                      {sessionTitle && (
                        <p className="text-muted-foreground/60 truncate text-[12px]" title={sessionTitle}>
                          {sessionTitle.slice(0, 60)}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground whitespace-nowrap">
                      <SlicedValue value={formatDuration(m.shown.duration_minutes)} whole={m.whole && formatDuration(m.whole.duration_minutes)} />
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      <SlicedValue value={messages(m.shown).toLocaleString()} whole={m.whole && messages(m.whole).toLocaleString()} />
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      <SlicedValue value={m.shown.tool_calls.toLocaleString()} whole={m.whole && m.whole.tool_calls.toLocaleString()} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      <TokensCell metrics={m} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-primary">
                      <SessionCostCell metrics={m} />
                    </td>
                    <td className="px-3 py-2">
                      <SessionBadges
                        has_compaction={s.has_compaction}
                        uses_task_agent={s.uses_task_agent}
                        uses_mcp={s.uses_mcp}
                        uses_web_search={s.uses_web_search}
                        uses_web_fetch={s.uses_web_fetch}
                        has_thinking={s.has_thinking}
                      />
                    </td>
                  </tr>
                )
              })}
              {paginated.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground/50 text-[13px]">
                    No sessions match filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </TooltipProvider>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-muted-foreground">
            Page {page} of {totalPages} · {sorted.length} sessions
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => { setPage(p => Math.max(1, p - 1)); setFocusedIdx(null) }}
              disabled={page === 1}
              className="px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              ←
            </button>
            {(() => {
              const maxVisible = Math.min(5, totalPages)
              const startPage = Math.max(1, Math.min(page - 2, totalPages - maxVisible + 1))
              const numPages = Math.min(maxVisible, totalPages - startPage + 1)
              const pages = Array.from({ length: numPages }, (_, i) => startPage + i)
              return pages.map((p) => (
                <button
                  key={p}
                  onClick={() => { setPage(p); setFocusedIdx(null) }}
                  className={`px-2 py-1 rounded border transition-colors ${p === page ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground hover:border-primary/40'}`}
                >
                  {p}
                </button>
              ))
            })()}
            <button
              onClick={() => { setPage(p => Math.min(totalPages, p + 1)); setFocusedIdx(null) }}
              disabled={page === totalPages}
              className="px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const HINT = 'cursor-help underline decoration-dotted decoration-primary/40 underline-offset-2'

/** A range-sliced number; when a whole-session value differs, hover shows it */
function SlicedValue({ value, whole }: { value: string; whole?: string }) {
  if (whole === undefined || whole === value) return <>{value}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className={HINT}>{value}</span></TooltipTrigger>
      <TooltipContent side="left" className="font-mono text-xs">whole session {whole}</TooltipContent>
    </Tooltip>
  )
}

function messages(m: SessionMetrics): number {
  return m.user_message_count + m.assistant_message_count
}

function tokenBreakdown(m: SessionMetrics): string {
  return `in ${formatTokens(m.input_tokens)} · out ${formatTokens(m.output_tokens)} · cache read ${formatTokens(m.cache_read_input_tokens)} · cache write ${formatTokens(m.cache_creation_input_tokens)}`
}

/** Total tokens of the row (input + output + cache read + cache write) */
function TokensCell({ metrics: m }: { metrics: RowMetrics }) {
  const tokens = metricTokens(m.shown)
  const wholeTokens = m.whole && metricTokens(m.whole)
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className={HINT}>{formatTokens(tokens)}</span></TooltipTrigger>
      <TooltipContent side="left" className="font-mono text-xs">
        <div>{tokenBreakdown(m.shown)}</div>
        {m.whole && wholeTokens !== tokens && (
          <div className="mt-1 text-muted-foreground">whole session {formatTokens(wholeTokens!)} · {tokenBreakdown(m.whole)}</div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** Session total; when sub-agents contributed, hover shows the orchestrator / agents split */
function SessionCostCell({ metrics: m }: { metrics: RowMetrics }) {
  const total = m.shown.estimated_cost
  const agents = m.shown.agents_cost
  const agentCount = m.agentCount
  const wholeDiffers = m.whole !== undefined && m.whole.estimated_cost !== total
  if (agentCount === 0 && !wholeDiffers) return <>{formatCost(total)}</>
  const main = Math.max(0, total - agents)
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className={HINT}>{formatCost(total)}</span></TooltipTrigger>
      <TooltipContent side="left" className="font-mono text-xs">
        {agentCount > 0 && <div>main {formatCost(main)} · agents {formatCost(agents)} · {agentCount} agent{agentCount === 1 ? '' : 's'}</div>}
        {wholeDiffers && <div className={agentCount > 0 ? 'mt-1 text-muted-foreground' : ''}>whole session {formatCost(m.whole!.estimated_cost)}</div>}
      </TooltipContent>
    </Tooltip>
  )
}

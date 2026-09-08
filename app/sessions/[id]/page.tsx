'use client'

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { TopBar } from '@/components/layout/top-bar'
import { SessionSidebar } from '@/components/sessions/replay/session-sidebar'
import { UserTurnCard, AssistantTurnCard } from '@/components/sessions/replay/turn-cards'
import { TokenAccumulationChart } from '@/components/sessions/replay/token-accumulation-chart'
import { SessionBadges } from '@/components/sessions/session-badges'
import { formatCost, formatTokens, formatDuration, projectDisplayName } from '@/lib/decode'
import type { AgentTimeline, ReplayData, SessionWithFacet } from '@/types/claude'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RawApiTab } from '@/components/sessions/raw-api/raw-api-tab'
import { AgentTimelineTab } from '@/components/sessions/agents/agent-timeline-tab'
import { TimeWindowBar } from '@/components/sessions/time-window-bar'
import { inWindow, intersectsWindow, windowFromSearch, windowToSearch, type TimeWindow } from '@/lib/time-window'
import { AlertTriangle, MessageSquare, Coins, DollarSign, Clock, Zap, Radio, Bot, Undo2 } from 'lucide-react'

const fetcher = (url: string) =>
  fetch(url).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

type ReplayResponse = ReplayData

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const { data: replayData, error: replayError, isLoading: replayLoading } =
    useSWR<ReplayResponse>(`/api/sessions/${id}/replay`, fetcher)

  const { data: metaData } =
    useSWR<{ session: SessionWithFacet }>(`/api/sessions/${id}`, fetcher)

  const meta = metaData?.session

  const { data: timeline } = useSWR<AgentTimeline>(`/api/sessions/${id}/agents`, fetcher, {
    // Keep polling while an agent is still running
    refreshInterval: latest => (latest?.agents.some(a => a.outcome === 'running') ? 10_000 : 0),
  })
  // ─── Selected time window, kept in the URL (?from=&to=) so it can be shared
  const [win, setWin] = useState<TimeWindow | null>(null)
  // Read the URL once after mount; the server render has no access to the query string
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setWin(windowFromSearch(window.location.search)) }, [])
  const onWindowChange = useCallback((w: TimeWindow | null) => {
    setWin(w)
    const url = `${window.location.pathname}${windowToSearch(window.location.search, w)}${window.location.hash}`
    window.history.replaceState(null, '', url)
  }, [])

  const agentCount = timeline?.agents.filter(a => !a.parent_id && intersectsWindow(a.start, a.end, win)).length ?? 0

  const view = useMemo<ReplayData | null>(() => {
    if (!replayData) return null
    if (!win) return replayData
    const keep = new Set<string>()
    const turns = replayData.turns.filter(t => { const ok = inWindow(t.timestamp, win); if (ok) keep.add(t.uuid); return ok })
    // Compactions keep their position relative to the turn they preceded
    const compactions = replayData.compactions
      .filter(c => inWindow(c.timestamp, win))
      .map(c => {
        const before = replayData.turns[c.turn_index]
        const idx = before ? turns.findIndex(t => t.uuid === before.uuid) : -1
        return { ...c, turn_index: idx >= 0 ? idx : turns.length }
      })
    const total_cost = turns.reduce((s, t) => s + (t.estimated_cost ?? 0), 0)
    return { ...replayData, turns, compactions, total_cost }
  }, [replayData, win])

  const [tab, setTab] = useState('replay')
  const jumpRef = useRef<string | null>(null)
  useEffect(() => {
    if (tab !== 'replay' || !jumpRef.current) return
    const uuid = jumpRef.current
    jumpRef.current = null
    let el: HTMLElement | null = null
    // Wait for the details sheet to close and the tab panel to lay out
    const t1 = setTimeout(() => {
      el = document.getElementById(`turn-${uuid}`)
      if (!el) return
      el.scrollIntoView({ block: 'center' })
      el.classList.add('ring-2', 'ring-primary', 'rounded-xl')
    }, 400)
    const t2 = setTimeout(() => el?.classList.remove('ring-2', 'ring-primary', 'rounded-xl'), 3500)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [tab])
  const jumpToTurn = (uuid: string) => { jumpRef.current = uuid; setTab('replay') }

  if (replayError) {
    return (
      <div className="flex flex-col min-h-screen">
        <TopBar title="Session Replay" subtitle="Error" />
        <div className="p-6">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>Error loading session: {String(replayError)}</AlertDescription>
          </Alert>
        </div>
      </div>
    )
  }

  if (replayLoading || !replayData || !view) {
    return (
      <div className="flex flex-col min-h-screen">
        <TopBar title="Session Replay" subtitle="Loading…" />
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
          <div className="space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className={`h-${i % 2 === 0 ? '16' : '28'} rounded-xl`} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  const projectName = meta ? projectDisplayName(meta.project_path ?? '') : id.slice(0, 8)

  // Every metric below is computed on `view`: the replay restricted to the selected window
  const replay = view
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0
  for (const t of replay.turns) {
    if (t.usage) {
      totalInput      += t.usage.input_tokens ?? 0
      totalOutput     += t.usage.output_tokens ?? 0
      totalCacheWrite += t.usage.cache_creation_input_tokens ?? 0
      totalCacheRead  += t.usage.cache_read_input_tokens ?? 0
    }
  }
  const totalTokens = totalInput + totalOutput + totalCacheWrite + totalCacheRead
  const discardedTurns = replay.turns.filter(t => t.type === 'assistant' && t.discarded).length
  const durationMinutes = win ? (win.to - win.from) / 60_000 : (meta?.duration_minutes ?? 0)

  // Build tool results map: tool_use_id -> result (from user turns)
  const toolResults = new Map<string, { content: string; is_error: boolean }>()
  for (const t of replay.turns) {
    if (t.type === 'user' && t.tool_results) {
      for (const r of t.tool_results) {
        toolResults.set(r.tool_use_id, { content: r.content, is_error: r.is_error })
      }
    }
  }

  // Build compaction map: index of turn before which a compaction occurred
  const compactionByTurnIndex = new Map(replay.compactions.map(c => [c.turn_index, c]))

  let assistantTurnNum = 0

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <TopBar
        title={replay.ai_title ?? `${projectName} · ${replay.slug ?? id.slice(0, 8)}`}
        subtitle={`${projectName} · ${replay.git_branch ?? '?'} · v${replay.version ?? '?'} · ${formatCost(replayData.total_cost ?? 0)}`}
      />

      {/* Stats cards — match project detail page */}
      <div className="border-b border-border bg-muted/30 px-4 py-4 md:px-6">
        <div className="mb-4">
          <TimeWindowBar
            window={win}
            onChange={onWindowChange}
            timeline={timeline}
            sessionStart={timeline ? new Date(timeline.start).getTime() : undefined}
            sessionEnd={timeline ? new Date(timeline.end).getTime() : undefined}
          />
        </div>
        <div
          className={
            3 + (meta || win ? 1 : 0) + (replay.compactions.length > 0 ? 1 : 0) >= 5
              ? 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5'
              : 'grid grid-cols-2 gap-4 sm:grid-cols-4'
          }
        >
          <Card className="gap-0">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4" /> Turns
              </CardDescription>
              <CardTitle className="text-3xl font-bold tabular-nums">
                {replay.turns.filter(t => t.type === 'assistant').length}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Assistant messages{discardedTurns > 0 ? ` · ${discardedTurns} discarded by rewind` : ''}
              </p>
            </CardContent>
          </Card>

          <Card className="gap-0">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Coins className="h-4 w-4" /> Tokens
              </CardDescription>
              <CardTitle className="text-3xl font-bold tabular-nums text-blue-700 dark:text-[#60a5fa]">{formatTokens(totalTokens)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Input + output + cache</p>
            </CardContent>
          </Card>

          <Card className="gap-0">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <DollarSign className="h-4 w-4" /> Cost
              </CardDescription>
              <CardTitle className="text-3xl font-bold tabular-nums text-[#d97706]">
                {formatCost(replay.total_cost ?? 0)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">{win ? 'Estimated spend in window' : 'Estimated spend'}</p>
            </CardContent>
          </Card>

          {(meta || win) && (
            <Card className="gap-0">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <Clock className="h-4 w-4" /> Duration
                </CardDescription>
                <CardTitle className="text-3xl font-bold tabular-nums">
                  {formatDuration(durationMinutes)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{win ? 'Selected window' : 'Session span'}</p>
              </CardContent>
            </Card>
          )}

          {replay.compactions.length > 0 && (
            <Card className="gap-0 border-amber-500/25">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-amber-500" /> Compactions
                </CardDescription>
                <CardTitle className="text-3xl font-bold tabular-nums text-amber-500">
                  {replay.compactions.length}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Context window events</p>
              </CardContent>
            </Card>
          )}
        </div>

        {meta && (
          <div className="mt-4 flex flex-wrap gap-2">
            <SessionBadges
              has_compaction={replay.compactions.length > 0}
              uses_task_agent={meta.uses_task_agent}
              uses_mcp={meta.uses_mcp}
              uses_web_search={meta.uses_web_search}
              uses_web_fetch={meta.uses_web_fetch}
              has_thinking={meta.has_thinking}
            />
          </div>
        )}
      </div>

      {/* Tabs: Replay (default) | Agents | Raw API */}
      <Tabs value={tab} onValueChange={setTab} className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b border-border px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="replay" className="gap-2">
              <MessageSquare className="h-4 w-4" />
              Replay
            </TabsTrigger>
            {timeline && (
              <TabsTrigger value="agents" className="gap-2">
                <Bot className="h-4 w-4" />
                Agents
                {agentCount > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{agentCount}</span>
                )}
              </TabsTrigger>
            )}
            <TabsTrigger value="raw" className="gap-2">
              <Radio className="h-4 w-4" />
              Raw API
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="replay" className="flex flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
          {/* Two-column layout */}
          <div className="flex flex-1 overflow-hidden">
            {/* Conversation replay */}
            <div className="flex-1 min-w-0 overflow-y-auto px-4 py-6 max-w-6xl">
              {win && replay.turns.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">No turns in the selected window.</p>
              )}
              {replay.turns.map((turn, i) => {
                const compactionBefore = compactionByTurnIndex.get(i)
                const startsDiscarded = turn.discarded && !replay.turns[i - 1]?.discarded
                const discardedBand = startsDiscarded ? (
                  <div className="my-3 flex items-center gap-2 rounded-lg border border-purple-400/40 bg-purple-500/10 px-4 py-2 text-sm text-purple-300">
                    <Undo2 className="h-4 w-4" />
                    <span className="font-semibold">REWIND</span>
                    <span className="text-purple-300/80">the turns below were discarded. Their tokens still count.</span>
                  </div>
                ) : null
                const wrapClass = turn.discarded ? 'opacity-50 saturate-50' : undefined

                if (turn.type === 'user') {
                  return (
                    <div key={turn.uuid || i} id={`turn-${turn.uuid}`} className={wrapClass}>
                      {discardedBand}
                      <UserTurnCard
                        turn={turn}
                        turnNumber={i + 1}
                        compactionBefore={compactionBefore}
                        toolResults={toolResults}
                      />
                    </div>
                  )
                }

                assistantTurnNum++
                return (
                  <div key={turn.uuid || i} id={`turn-${turn.uuid}`} className={wrapClass}>
                    {discardedBand}
                    <AssistantTurnCard
                      turn={turn}
                      turnNumber={assistantTurnNum}
                      compactionBefore={compactionBefore}
                      toolResults={toolResults}
                    />
                  </div>
                )
              })}
            </div>

            {/* Sidebar */}
            <div className="w-64 shrink-0 overflow-y-auto border-l border-border px-4 py-6">
              <SessionSidebar replay={replay} meta={meta} />
            </div>
          </div>

          {/* Token accumulation chart */}
          <div className="border-t border-border px-4 py-4">
            <TokenAccumulationChart turns={replay.turns} compactions={replay.compactions} />
          </div>
        </TabsContent>

        {timeline && (
          <TabsContent value="agents" className="flex-1 overflow-y-auto data-[state=inactive]:hidden">
            {tab === 'agents' && (
              <AgentTimelineTab sessionId={id} timeline={timeline} window={win} onWindowChange={onWindowChange} onJumpToTurn={jumpToTurn} />
            )}
          </TabsContent>
        )}

        <TabsContent value="raw" className="flex-1 overflow-y-auto data-[state=inactive]:hidden">
          <RawApiTab sessionId={id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

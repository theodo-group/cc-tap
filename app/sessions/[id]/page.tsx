'use client'

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import useSWR from 'swr'
import { TopBar } from '@/components/layout/top-bar'
import { SessionSidebar } from '@/components/sessions/replay/session-sidebar'
import { TurnList } from '@/components/sessions/replay/turn-list'
import { SessionBadges } from '@/components/sessions/session-badges'
import { formatCost, formatTokens, formatDuration, projectDisplayName } from '@/lib/decode'
import type { AgentRun, AgentTimeline, ReplayData, SessionWithFacet } from '@/types/claude'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RawApiTab } from '@/components/sessions/raw-api/raw-api-tab'
import { AgentTimelineTab } from '@/components/sessions/agents/agent-timeline-tab'
import { AgentDetailsSheet } from '@/components/sessions/agents/agent-details-sheet'
import { OrchestratorSheet } from '@/components/sessions/agents/orchestrator-sheet'
import { ContextTab } from '@/components/sessions/context/context-tab'
import { TimeWindowBar } from '@/components/sessions/time-window-bar'
import { inWindow, intersectsWindow, windowFromSearch, windowToSearch, type TimeWindow } from '@/lib/time-window'
import { turnAtTime, flashTurn } from '@/lib/turn-at-time'
import { ReplaySearch } from '@/components/sessions/replay/replay-search'
import { useReplaySearch } from '@/components/sessions/replay/use-replay-search'
import { REPLAY_HIGHLIGHTS } from '@/lib/replay-highlight'
import { AlertTriangle, MessageSquare, Coins, DollarSign, Clock, Zap, Radio, Bot, Loader2, Gauge } from 'lucide-react'

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

  // ─── One pair of drawers for the whole page, opened from the Agents tab and from the Context tab
  const [selectedAgent, setSelectedAgent] = useState<AgentRun | null>(null)
  /** Time under the pointer when the agent was picked; the drawer scrolls its transcript there */
  const [selectedAt, setSelectedAt] = useState<number | undefined>(undefined)
  /** Time picked on the orchestrator; opens the orchestrator drawer */
  const [orchestratorAt, setOrchestratorAt] = useState<number | null>(null)
  const onSelectAgent = useCallback((a: AgentRun, atMs?: number) => { setSelectedAt(atMs); setSelectedAgent(a) }, [])
  const onOpenOrchestratorAt = useCallback((atMs: number) => setOrchestratorAt(atMs), [])
  const agentsById = useMemo(() => new Map((timeline?.agents ?? []).map(a => [a.id, a])), [timeline])
  // ─── The turn list is virtualised, so a jump costs the same wherever it lands.
  /** A jump asked for by hand; its token makes the same turn ask again */
  const [jump, setJump] = useState<{ index: number; token: number } | null>(null)

  // ─── Search over the whole conversation, held by one hook for the Replay
  //     and for the drawers alike
  const toolResults = useMemo(() => {
    const map = new Map<string, { content: string; is_error: boolean }>()
    for (const t of replayData?.turns ?? []) {
      for (const r of t.tool_results ?? []) map.set(r.tool_use_id, { content: r.content, is_error: r.is_error })
    }
    return map
  }, [replayData])
  const [listRoot, setListRoot] = useState<HTMLDivElement | null>(null)
  const search = useReplaySearch(replayData?.turns, toolResults, {
    names: REPLAY_HIGHLIGHTS,
    root: listRoot,
    enabled: tab === 'replay',
  })

  const jumpRef = useRef<string | null>(null)
  useEffect(() => {
    if (tab !== 'replay' || !jumpRef.current) return
    const uuid = jumpRef.current
    jumpRef.current = null
    let undo: (() => void) | undefined
    let frame = 0
    // The sheet has to close, the panel to lay out and the virtual list to
    // mount the turn, so the flash waits for the card instead of a fixed delay
    const deadline = performance.now() + 2000
    const look = () => {
      const el = document.getElementById(`turn-${uuid}`)
      if (el) { undo = flashTurn(el); return }
      if (performance.now() < deadline) frame = requestAnimationFrame(look)
    }
    frame = requestAnimationFrame(look)
    return () => { cancelAnimationFrame(frame); undo?.() }
  }, [tab])
  const jumpToTurn = (uuid: string) => {
    jumpRef.current = uuid
    // The list shows the whole session, window or not, so the index is taken on
    // the full turn list; the virtualiser mounts that turn and nothing before it.
    const idx = replayData?.turns.findIndex(t => t.uuid === uuid) ?? -1
    if (idx >= 0) setJump(j => ({ index: idx, token: (j?.token ?? 0) + 1 }))
    setTab('replay')
  }
  /** Open the Replay at the orchestrator turn that was in progress at `timeMs` */
  const jumpToTime = (timeMs: number) => {
    const t = replayData ? turnAtTime(replayData.turns, timeMs) : undefined
    if (t) jumpToTurn(t.uuid)
  }

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

  // The turn list always shows the whole session; turns outside the window are dimmed.
  // A jump from the Agents tab can then land on any turn while the window stays selected.
  const allTurns = replayData.turns

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
            {/* Always present; the agents payload is the slowest fetch, so the badge shows a spinner until it lands */}
            <TabsTrigger value="agents" className="gap-2">
              <Bot className="h-4 w-4" />
              Agents
              {!timeline && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="Loading agents" />}
              {timeline && agentCount > 0 && (
                <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{agentCount}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="context" className="gap-2">
              <Gauge className="h-4 w-4" />
              Context
            </TabsTrigger>
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
                <p className="py-3 text-center text-sm text-muted-foreground">No turns in the selected window. The whole session is shown dimmed.</p>
              )}
              <ReplaySearch
                open={search.open}
                onOpenChange={search.onOpenChange}
                query={search.query}
                onQueryChange={search.onQueryChange}
                caseSensitive={search.caseSensitive}
                onCaseSensitiveChange={search.onCaseSensitiveChange}
                exact={search.exact}
                onExactChange={search.onExactChange}
                hits={search.hits}
                current={search.position}
                onStep={search.onStep}
              />
              <div ref={setListRoot}>
                <TurnList
                  turns={allTurns}
                  toolResults={toolResults}
                  compactions={replayData.compactions}
                  window={win}
                  hitUuids={search.hitUuids}
                  current={search.current}
                  focus={jump ?? (search.current ? { index: search.current.index, token: search.current.index } : null)}
                  onRenderedChange={search.onRenderedChange}
                />
              </div>
            </div>

            {/* Sidebar */}
            <div className="w-64 shrink-0 overflow-y-auto border-l border-border px-4 py-6">
              <SessionSidebar replay={replay} meta={meta} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="agents" className="flex-1 overflow-y-auto data-[state=inactive]:hidden">
          {tab === 'agents' && !timeline && (
            <div className="space-y-4 px-4 py-5 md:px-6">
              <Skeleton className="h-5 w-72 rounded" />
              <Skeleton className="h-4 w-full max-w-3xl rounded" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
          )}
          {tab === 'agents' && timeline && (
            <AgentTimelineTab sessionId={id} timeline={timeline} window={win} onWindowChange={onWindowChange} onSelectAgent={onSelectAgent} onOpenOrchestratorAt={onOpenOrchestratorAt} />
          )}
        </TabsContent>

        <TabsContent value="context" className="flex-1 overflow-y-auto data-[state=inactive]:hidden">
          {tab === 'context' && (
            <ContextTab
              sessionId={id}
              replay={replayData}
              timeline={timeline}
              window={win}
              onWindowChange={onWindowChange}
              onOpenOrchestratorAt={onOpenOrchestratorAt}
              onOpenAgentAt={onSelectAgent}
              onJumpToTime={jumpToTime}
              onJumpToTurn={jumpToTurn}
            />
          )}
        </TabsContent>

        <TabsContent value="raw" className="flex-1 overflow-y-auto data-[state=inactive]:hidden">
          <RawApiTab sessionId={id} />
        </TabsContent>
      </Tabs>

      {timeline && (
        <OrchestratorSheet
          sessionId={id}
          timeline={timeline}
          atMs={orchestratorAt}
          onClose={() => setOrchestratorAt(null)}
          onJumpToTime={ms => { setOrchestratorAt(null); jumpToTime(ms) }}
        />
      )}

      <AgentDetailsSheet
        sessionId={id}
        agent={selectedAgent}
        scrollToMs={selectedAt}
        parent={selectedAgent?.parent_id ? agentsById.get(selectedAgent.parent_id) : undefined}
        onClose={() => setSelectedAgent(null)}
        onJumpToTurn={uuid => { setSelectedAgent(null); jumpToTurn(uuid) }}
      />
    </div>
  )
}

'use client'

import type { AgentRun } from '@/types/claude'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { formatCost, formatTokens, formatDurationMs } from '@/lib/decode'
import { formatClock, formatDayClock } from '@/lib/time-scale'
import { OUTCOME_COLORS } from './agent-flame-chart'
import { AgentTranscript } from './agent-transcript'
import { ExternalLink, MessageSquare } from 'lucide-react'

interface Props {
  sessionId: string
  agent: AgentRun | null
  parent?: AgentRun
  onClose(): void
  onJumpToTurn?(uuid: string): void
  /** Scroll the transcript to the turn in progress at this time; absent opens at the top */
  scrollToMs?: number
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  )
}

export function AgentDetailsSheet({ sessionId, agent, parent, onClose, onJumpToTurn, scrollToMs }: Props) {
  const a = agent
  const start = a ? new Date(a.start).getTime() : 0
  const end = a ? new Date(a.end).getTime() : 0
  const totalTokens = a
    ? a.usage.input_tokens + a.usage.output_tokens + a.usage.cache_creation_input_tokens + a.usage.cache_read_input_tokens
    : 0

  return (
    <Sheet open={!!a} onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent className="overflow-y-auto w-full sm:max-w-3xl">
        {a && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-6">{a.description}</SheetTitle>
              <SheetDescription className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant="outline" style={{ borderColor: OUTCOME_COLORS[a.outcome], color: OUTCOME_COLORS[a.outcome] }}>
                  {a.outcome}
                </Badge>
                <Badge variant="secondary">{a.agent_type}</Badge>
                {a.model && <Badge variant="secondary">{a.model}</Badge>}
                <Badge variant="secondary">depth {a.depth}</Badge>
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-2 px-4">
              <Row label="Start">{formatDayClock(start)}</Row>
              <Row label="End">{formatDayClock(end)}</Row>
              <Row label="Duration">{formatDurationMs(a.duration_ms)}</Row>
              <Row label="Turns">{a.turns}</Row>
              {parent && <Row label="Launched by">{parent.description}</Row>}
              {a.children_count > 0 && <Row label="Sub-agents">{a.children_count}</Row>}
              {a.nudges.length > 0 && (
                <Row label={parent ? 'Messages from parent agent' : 'Messages from orchestrator'}>
                  {a.nudges.map(n => formatClock(new Date(n).getTime())).join(', ')}
                </Row>
              )}
            </div>

            <Separator />

            <div className="space-y-2 px-4">
              <Row label="Tokens">{formatTokens(totalTokens)}</Row>
              <Row label="Input / output">{formatTokens(a.usage.input_tokens)} / {formatTokens(a.usage.output_tokens)}</Row>
              <Row label="Cache read / write">{formatTokens(a.usage.cache_read_input_tokens)} / {formatTokens(a.usage.cache_creation_input_tokens)}</Row>
              <Row label="Estimated cost">{formatCost(a.estimated_cost)}</Row>
            </div>

            {a.launch_turn_uuid && onJumpToTurn && (
              <div className="px-4">
                <Button variant="outline" size="sm" className="gap-2" onClick={() => onJumpToTurn(a.launch_turn_uuid!)}>
                  <ExternalLink className="h-3.5 w-3.5" /> Open launching turn
                </Button>
              </div>
            )}

            {a.prompt && (
              <details className="px-4">
                <summary className="cursor-pointer text-sm font-medium">Prompt</summary>
                <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs">
                  {a.prompt}
                </pre>
              </details>
            )}

            <Separator />

            <div className="px-4 pb-6">
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" /> Conversation · {a.turns} assistant turns
              </h3>
              {/* Keyed by agent so a new agent starts from the top */}
              <AgentTranscript key={a.id} sessionId={sessionId} agentId={a.id} scrollToMs={scrollToMs} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

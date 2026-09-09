'use client'

import type { AgentTimeline } from '@/types/claude'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { formatDurationMs } from '@/lib/decode'
import { formatClock, formatDayClock } from '@/lib/time-scale'
import { AgentTranscript } from './agent-transcript'
import { ExternalLink, MessageSquare } from 'lucide-react'

interface Props {
  sessionId: string
  timeline: AgentTimeline
  /** Time under the pointer when the orchestrator bar was clicked; null keeps the sheet closed */
  atMs: number | null
  onClose(): void
  /** Open the Replay tab at the turn in progress at this time */
  onJumpToTime?(timeMs: number): void
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  )
}

/** The orchestrator's own conversation, in the same drawer as a sub-agent */
export function OrchestratorSheet({ sessionId, timeline, atMs, onClose, onJumpToTime }: Props) {
  const start = new Date(timeline.start).getTime()
  const end = new Date(timeline.end).getTime()
  const topLevel = timeline.agents.filter(a => !a.parent_id).length

  return (
    <Sheet open={atMs !== null} onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent className="overflow-y-auto w-full sm:max-w-3xl">
        {atMs !== null && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-6">Orchestrator</SheetTitle>
              <SheetDescription className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant="secondary">main session</Badge>
                <Badge variant="outline">at {formatClock(atMs)}</Badge>
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-2 px-4">
              <Row label="Start">{formatDayClock(start)}</Row>
              <Row label="End">{formatDayClock(end)}</Row>
              <Row label="Duration">{formatDurationMs(end - start)}</Row>
              <Row label="Human prompts">{timeline.orchestrator.prompts.length}</Row>
              <Row label="Agents launched">{topLevel}{timeline.agents.length > topLevel ? ` (+${timeline.agents.length - topLevel} sub-agents)` : ''}</Row>
            </div>

            {onJumpToTime && (
              <div className="px-4">
                <Button variant="outline" size="sm" className="gap-2" onClick={() => onJumpToTime(atMs)}>
                  <ExternalLink className="h-3.5 w-3.5" /> Open in Replay at {formatClock(atMs)}
                </Button>
              </div>
            )}

            <Separator />

            <div className="px-4 pb-6">
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" /> Conversation
              </h3>
              {/* Keyed by time so a new click scrolls again */}
              <AgentTranscript key={atMs} sessionId={sessionId} scrollToMs={atMs} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

'use client'

import { useMemo } from 'react'
import useSWR from 'swr'
import type { AgentRun, CappedText, WorkflowRun, WorkflowRunDetail } from '@/types/claude'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCost, formatTokens, formatDurationMs } from '@/lib/decode'
import { formatDayClock } from '@/lib/time-scale'
import { WORKFLOW_STATE_LABEL, isBlocked, isWorkflowFailure, sortWorkflowAgents } from '@/lib/workflow-agents'
import { OUTCOME_COLORS, WORKFLOW_STATE_COLORS } from './agent-flame-chart'
import { AlertTriangle, ExternalLink, Workflow as WorkflowIcon } from 'lucide-react'

const fetcher = (url: string) =>
  fetch(url).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

interface Props {
  sessionId: string
  run: WorkflowRun | null
  /** The run's agents, in phase order */
  agents: AgentRun[]
  onClose(): void
  onOpenAgent(agent: AgentRun): void
  onJumpToTurn?(uuid: string): void
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right tabular-nums break-words">{children}</span>
    </div>
  )
}

function Section({ title, children, defaultOpen = false }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="px-4" open={defaultOpen}>
      <summary className="cursor-pointer text-sm font-medium">{title}</summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

function Pre({ text, maxH = '50vh' }: { text: string; maxH?: string }) {
  return (
    <pre className="overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs" style={{ maxHeight: maxH }}>
      {text}
    </pre>
  )
}

function Capped({ value }: { value: CappedText }) {
  return (
    <>
      <Pre text={value.text} />
      {value.truncated && <p className="mt-1 text-xs text-muted-foreground">Truncated: {formatTokens(value.total_chars)} characters in total.</p>}
    </>
  )
}

/** One agent as a chip that opens its drawer */
function AgentChip({ agent, onOpen }: { agent: AgentRun; onOpen(a: AgentRun): void }) {
  const state = agent.workflow_state
  const color = state ? WORKFLOW_STATE_COLORS[state] : OUTCOME_COLORS[agent.outcome]
  return (
    <Badge asChild variant="outline" className={isBlocked(agent) ? 'border-dashed' : undefined}>
      <button type="button" onClick={() => onOpen(agent)} title={agent.workflow_error ?? agent.workflow_result_preview ?? agent.description} className="max-w-full cursor-pointer hover:bg-accent">
        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate">{agent.description}</span>
        {agent.has_transcript !== false && <span className="text-muted-foreground">· {formatDurationMs(agent.duration_ms)}</span>}
      </button>
    </Badge>
  )
}

export function WorkflowDetailsSheet({ sessionId, run, agents, onClose, onOpenAgent, onJumpToTurn }: Props) {
  const w = run
  const running = w?.status === 'running'
  const { data: detail, error: detailError, isLoading } = useSWR<WorkflowRunDetail>(
    w ? `/api/sessions/${sessionId}/workflows/${w.id}` : null,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: running ? 10_000 : 0 },
  )

  const sorted = useMemo(() => sortWorkflowAgents(agents), [agents])
  const failures = useMemo(() => sorted.filter(isWorkflowFailure), [sorted])
  const byPhase = useMemo(() => {
    const phases = [...(w?.phases ?? [])].sort((a, b) => a.index - b.index)
    const groups = phases.map(p => ({ phase: p, agents: sorted.filter(a => a.workflow_phase_index === p.index) }))
    const other = sorted.filter(a => a.workflow_phase_index === undefined || !phases.some(p => p.index === a.workflow_phase_index))
    return { groups, other }
  }, [w, sorted])

  const start = w ? new Date(w.start).getTime() : 0
  const end = w ? new Date(w.end).getTime() : 0
  const failed = w ? w.error_count - w.blocked_count : 0

  return (
    <Sheet open={!!w} onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent className="overflow-y-auto w-full sm:max-w-3xl">
        {w && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 pr-6"><WorkflowIcon className="h-4 w-4 shrink-0" /> {w.name}</SheetTitle>
              <SheetDescription className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant="outline" style={{ borderColor: OUTCOME_COLORS[w.status], color: OUTCOME_COLORS[w.status] }}>{w.status}</Badge>
                <Badge variant="secondary" className="font-mono">{w.id}</Badge>
                {w.attempts > 1 && <Badge variant="secondary">{w.attempts} attempts{w.resumed ? ' (resumed)' : ''}</Badge>}
                {!w.has_record && <Badge variant="outline">record pending</Badge>}
                {w.default_model && <Badge variant="secondary">{w.default_model}</Badge>}
              </SheetDescription>
              {w.summary && <p className="text-sm text-muted-foreground">{w.summary}</p>}
            </SheetHeader>

            <div className="space-y-2 px-4">
              <Row label="Start">{formatDayClock(start)}</Row>
              <Row label="End">{running ? 'running' : formatDayClock(end)}</Row>
              <Row label="Duration">{formatDurationMs(w.duration_ms)}</Row>
              <Row label="Agents">
                {w.agent_count}
                {w.done_count > 0 && <span style={{ color: OUTCOME_COLORS.completed }}> · {w.done_count} done</span>}
                {failed > 0 && <span style={{ color: OUTCOME_COLORS.failed }}> · {failed} failed</span>}
                {w.blocked_count > 0 && <span style={{ color: OUTCOME_COLORS.failed }}> · {w.blocked_count} blocked</span>}
                {w.running_count > 0 && <span style={{ color: OUTCOME_COLORS.running }}> · {w.running_count} running</span>}
              </Row>
              {w.total_tokens != null && <Row label="Tokens">{formatTokens(w.total_tokens)}</Row>}
              {w.total_tool_calls != null && <Row label="Tool calls">{w.total_tool_calls}</Row>}
              <Row label="Estimated cost">{formatCost(w.estimated_cost)}</Row>
              {w.script_path && <Row label="Script"><span className="font-mono text-xs" title={w.script_path}>{w.script_path.split('/').pop()}</span></Row>}
              {w.task_ids.length > 0 && <Row label={w.task_ids.length > 1 ? 'Task ids' : 'Task id'}><span className="font-mono text-xs">{w.task_ids.join(', ')}</span></Row>}
            </div>

            {w.error && (
              <div className="px-4">
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="whitespace-pre-wrap break-words">{w.error}</AlertDescription>
                </Alert>
              </div>
            )}

            {w.launch_turn_uuid && onJumpToTurn && (
              <div className="px-4">
                <Button variant="outline" size="sm" className="gap-2" onClick={() => onJumpToTurn(w.launch_turn_uuid!)}>
                  <ExternalLink className="h-3.5 w-3.5" /> Open launching turn
                </Button>
              </div>
            )}

            {failures.length > 0 && (
              <>
                <Separator />
                <div className="px-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: OUTCOME_COLORS.failed }}>
                    Failures · {failures.length}
                  </h3>
                  <ul className="space-y-1.5 text-sm">
                    {failures.map(a => (
                      <li key={a.id} className="flex items-start gap-2">
                        <span className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: WORKFLOW_STATE_COLORS[a.workflow_state ?? 'error'] }} />
                        <div className="min-w-0">
                          <button type="button" className="text-left font-medium hover:underline" onClick={() => onOpenAgent(a)}>
                            {a.workflow_phase_index !== undefined && <span className="mr-1 text-muted-foreground">P{a.workflow_phase_index}</span>}
                            {a.description}
                            <span className="ml-1 text-xs text-muted-foreground">· {WORKFLOW_STATE_LABEL[a.workflow_state ?? 'error']}</span>
                          </button>
                          {a.workflow_error && <p className="line-clamp-2 text-xs text-muted-foreground" title={a.workflow_error}>{a.workflow_error}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            <Separator />

            <div className="space-y-3 px-4">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Phases · {w.phases.length || 'none declared'}
              </h3>
              {byPhase.groups.map(({ phase, agents: own }) => {
                const done = own.filter(a => a.workflow_state === 'done' || a.workflow_state === 'cached').length
                const bad = own.filter(isWorkflowFailure).length
                const span = own.length > 0
                  ? Math.max(...own.map(a => new Date(a.end).getTime())) - Math.min(...own.map(a => new Date(a.start).getTime()))
                  : 0
                return (
                  <div key={phase.index}>
                    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="font-medium">P{phase.index} · {phase.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {own.length} agent{own.length === 1 ? '' : 's'}
                        {done > 0 && <span style={{ color: OUTCOME_COLORS.completed }}> · {done} done</span>}
                        {bad > 0 && <span style={{ color: OUTCOME_COLORS.failed }}> · {bad} failed</span>}
                        {span > 0 && <> · {formatDurationMs(span)}</>}
                      </span>
                    </div>
                    {phase.detail && <p className="text-xs text-muted-foreground">{phase.detail}</p>}
                    {own.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {own.map(a => <AgentChip key={a.id} agent={a} onOpen={onOpenAgent} />)}
                      </div>
                    )}
                  </div>
                )
              })}
              {byPhase.other.length > 0 && (
                <div>
                  <div className="text-sm font-medium">{w.phases.length > 0 ? 'Other' : 'Agents'}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {byPhase.other.map(a => <AgentChip key={a.id} agent={a} onOpen={onOpenAgent} />)}
                  </div>
                </div>
              )}
            </div>

            <Separator />

            {/* Keyed by run so the sections start collapsed for a new run */}
            <div key={w.id} className="space-y-3 pb-6">
              <h3 className="px-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Run details</h3>
              {detailError && (
                <div className="px-4">
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>Could not load the run details: {String(detailError)}</AlertDescription>
                  </Alert>
                </div>
              )}
              {isLoading && !detail && (
                <div className="space-y-2 px-4">
                  <Skeleton className="h-5 w-40 rounded" />
                  <Skeleton className="h-5 w-56 rounded" />
                </div>
              )}
              {detail && (
                <>
                  {running && detail.progress.length > 0 && (
                    <Section title="Live progress" defaultOpen>
                      <ul className="space-y-1 text-xs">
                        {detail.progress.filter(p => p.type === 'workflow_agent').map((p, i) => (
                          <li key={i} className="flex flex-wrap gap-x-2">
                            <span className="font-medium">{String(p.label ?? '')}</span>
                            <span className="text-muted-foreground">{String(p.state ?? '')}</span>
                            {typeof p.lastToolName === 'string' && <span className="font-mono text-muted-foreground">{p.lastToolName}{typeof p.lastToolSummary === 'string' ? ` ${p.lastToolSummary}` : ''}</span>}
                          </li>
                        ))}
                      </ul>
                    </Section>
                  )}
                  {detail.args && <Section title="Args"><Capped value={detail.args} /></Section>}
                  {detail.result && <Section title="Result"><Capped value={detail.result} /></Section>}
                  {detail.logs.length > 0 && <Section title={`Logs · ${detail.logs.length}`}><Pre text={detail.logs.join('\n')} /></Section>}
                  {detail.journal.length > 0 && (
                    <Section title={`Journal · ${detail.journal.length}`}>
                      <ul className="max-h-[50vh] space-y-1 overflow-auto text-xs">
                        {detail.journal.map((e, i) => (
                          <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                            <Badge variant="outline" className="font-mono text-[10px]">{e.type}</Badge>
                            {e.label && <span className="font-medium">{e.label}</span>}
                            {e.phase && <span className="text-muted-foreground">{e.phase}</span>}
                            {e.agent_id && <span className="font-mono text-muted-foreground">{e.agent_id}</span>}
                            {e.result && <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={e.result.text}>{e.result.text.replace(/\s+/g, ' ').slice(0, 200)}</span>}
                          </li>
                        ))}
                      </ul>
                    </Section>
                  )}
                  {detail.script && (
                    <Section title={<>Script{detail.script_path && <span className="ml-2 font-mono text-xs text-muted-foreground">{detail.script_path}</span>}</>}>
                      <Capped value={detail.script} />
                    </Section>
                  )}
                  {!detail.has_record && !detail.script && detail.journal.length === 0 && (
                    <p className="px-4 text-sm text-muted-foreground">No record yet. It is written when the run ends.</p>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

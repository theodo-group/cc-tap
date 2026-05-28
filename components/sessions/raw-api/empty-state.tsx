import { Card, CardContent } from '@/components/ui/card'
import { Radio, Terminal } from 'lucide-react'

export function CapturesEmptyState({ available }: { available: boolean }) {
  if (!available) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardContent className="flex flex-col gap-3 py-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Radio className="h-5 w-5 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold">Inspector proxy not running</h3>
          <p className="text-sm text-muted-foreground">
            Start <code className="rounded bg-muted px-1 py-0.5 text-xs">npx cc-tap</code> without{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">--no-proxy</code> to capture API
            traffic. The dashboard will show captures here once Claude Code makes a request through it.
          </p>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className="mx-auto max-w-2xl">
      <CardContent className="flex flex-col gap-3 py-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Terminal className="h-5 w-5 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold">No captures for this session</h3>
        <p className="text-sm text-muted-foreground">
          The inspector proxy is running but hasn&apos;t recorded any requests for this session yet.
          Point Claude Code at it and resume work in this session:
        </p>
        <pre className="mx-auto rounded-md bg-muted px-3 py-2 text-left text-xs font-mono text-muted-foreground">
          {`export ANTHROPIC_BASE_URL=http://localhost:<proxy-port>
export ANTHROPIC_API_KEY=sk-ant-...
claude --resume`}
        </pre>
      </CardContent>
    </Card>
  )
}

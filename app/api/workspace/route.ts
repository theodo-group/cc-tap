import { NextResponse } from 'next/server'
import {
  readSkills,
  readInstalledPlugins,
  readConfigDir,
  readSettings,
} from '@/lib/claude-reader'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [skills, plugins, agents, commands, rules, outputStyles, workflows, settings] =
    await Promise.all([
      readSkills(),
      readInstalledPlugins(),
      readConfigDir('agents'),
      readConfigDir('commands'),
      readConfigDir('rules'),
      readConfigDir('output-styles'),
      readConfigDir('workflows'),
      readSettings(),
    ])

  // Hook config lives in settings.json as { event: [{ matcher, hooks: [...] }] }
  const hooksRaw = settings.hooks as Record<string, Array<{ matcher?: string; hooks?: unknown[] }>> | undefined
  const hooks = hooksRaw
    ? Object.entries(hooksRaw).map(([event, matchers]) => ({
        event,
        matchers: (matchers ?? []).length,
        commands: (matchers ?? []).reduce((sum, m) => sum + (m.hooks?.length ?? 0), 0),
      }))
    : []

  return NextResponse.json({
    skills,
    plugins,
    agents,
    commands,
    rules,
    outputStyles,
    workflows,
    hooks,
  })
}

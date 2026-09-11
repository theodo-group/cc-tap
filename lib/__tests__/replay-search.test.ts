import { describe, it, expect } from 'vitest'
import { searchTerms, fuzzyFind, searchIndex, buildReplayIndex, narrowsFrom, matchTurnParts, turnSearchText } from '@/lib/replay-search'
import type { ReplayTurn } from '@/types/claude'

const turn = (p: Partial<ReplayTurn>): ReplayTurn => ({
  uuid: 'u', parentUuid: null, type: 'assistant', timestamp: '2026-01-01T00:00:00Z', text: '', ...p,
} as ReplayTurn)

describe('searchTerms', () => {
  it('splits words and keeps a quoted phrase whole', () => {
    expect(searchTerms('no "such file" here')).toEqual(['no', 'such file', 'here'])
  })
  it('is empty for a blank query', () => {
    expect(searchTerms('   ')).toEqual([])
  })
})

describe('fuzzyFind', () => {
  it('finds an exact run at no cost', () => {
    expect(fuzzyFind('parse the replay', 'replay')).toEqual({ start: 10, cost: 0 })
  })
  it('finds characters in order and charges the gaps', () => {
    expect(fuzzyFind('the rebase step', 'rbase')).toEqual({ start: 4, cost: 1 })
  })
  it('refuses a run that skips too much: a short term is otherwise in any long text', () => {
    expect(fuzzyFind('replay parser', 'rpars')).toBeNull()
    expect(fuzzyFind('run every branch and see the result', 'rebase')).toBeNull()
  })
  it('returns null when a character is missing', () => {
    expect(fuzzyFind('replay', 'xyz')).toBeNull()
  })
})

describe('turnSearchText', () => {
  it('covers text, thinking, tool input and tool result', () => {
    const results = new Map([['t1', { content: 'result body', is_error: false }]])
    const text = turnSearchText(
      turn({ text: 'hello', thinking_text: 'pondering', tool_calls: [{ id: 't1', name: 'Bash', input: { command: 'ls -la' } }] }),
      results,
    )
    expect(text).toContain('hello')
    expect(text).toContain('pondering')
    expect(text).toContain('Bash')
    expect(text).toContain('ls -la')
    expect(text).toContain('result body')
  })
})

describe('searchIndex', () => {
  const turns = [
    turn({ uuid: 'a', text: 'Install the dependencies' }),
    turn({ uuid: 'b', type: 'user', text: 'the build is broken' }),
    turn({ uuid: 'c', text: 'Fixed the broken build step' }),
  ]

  it('returns every matching turn in conversation order', () => {
    const hits = searchIndex(buildReplayIndex(turns), 'broken')
    expect(hits.map(h => h.uuid)).toEqual(['b', 'c'])
    expect(hits[0].index).toBe(1)
  })

  it('needs every term to match', () => {
    expect(searchIndex(buildReplayIndex(turns), 'broken install')).toEqual([])
    expect(searchIndex(buildReplayIndex(turns), 'broken build').map(h => h.uuid)).toEqual(['b', 'c'])
  })

  it('matches a phrase only as that phrase', () => {
    expect(searchIndex(buildReplayIndex(turns), '"broken build"').map(h => h.uuid)).toEqual(['c'])
  })

  it('matches loosely when the term has no exact hit', () => {
    const hits = searchIndex(buildReplayIndex(turns), 'depncies')
    expect(hits.map(h => h.uuid)).toEqual(['a'])
  })

  it('is case-insensitive by default', () => {
    expect(searchIndex(buildReplayIndex(turns), 'INSTALL').map(h => h.uuid)).toEqual(['a'])
  })

  it('keeps the case of the query when asked, and matches on it', () => {
    expect(searchTerms('Install THE', { caseSensitive: true })).toEqual(['Install', 'THE'])
    expect(searchIndex(buildReplayIndex(turns, undefined), 'Install', { caseSensitive: true }).map(h => h.uuid)).toEqual(['a'])
    expect(searchIndex(buildReplayIndex(turns, undefined), 'install', { caseSensitive: true })).toEqual([])
    expect(searchIndex(buildReplayIndex(turns, undefined), 'INSTALL', { caseSensitive: true })).toEqual([])
  })

  it('matches a case-sensitive phrase as that phrase', () => {
    expect(searchIndex(buildReplayIndex(turns, undefined), '"broken build"', { caseSensitive: true }).map(h => h.uuid)).toEqual(['c'])
    expect(searchIndex(buildReplayIndex(turns, undefined), '"Broken Build"', { caseSensitive: true })).toEqual([])
  })

  it('takes the whole query as one text in exact mode', () => {
    expect(searchTerms('the broken build', { exact: true })).toEqual(['the broken build'])
    // 'Fixed the broken build step' holds the phrase; 'the build is broken' holds its words
    expect(searchIndex(buildReplayIndex(turns, undefined), 'the broken build', { exact: true }).map(h => h.uuid)).toEqual(['c'])
    expect(searchIndex(buildReplayIndex(turns, undefined), 'the broken build').map(h => h.uuid)).toEqual(['b', 'c'])
    expect(searchIndex(buildReplayIndex(turns, undefined), 'build broken', { exact: true })).toEqual([])
  })

  it('never matches loosely in exact mode', () => {
    expect(searchIndex(buildReplayIndex(turns, undefined), 'depncies').map(h => h.uuid)).toEqual(['a'])
    expect(searchIndex(buildReplayIndex(turns, undefined), 'depncies', { exact: true })).toEqual([])
  })

  it('keeps the quotes typed in exact mode: they are text like any other', () => {
    expect(searchTerms('"broken build"', { exact: true })).toEqual(['"broken build"'])
    expect(searchIndex(buildReplayIndex(turns, undefined), '"broken build"', { exact: true })).toEqual([])
  })

  it('returns nothing for a blank query', () => {
    expect(searchIndex(buildReplayIndex(turns), '  ')).toEqual([])
  })
})

describe('buildReplayIndex', () => {
  const turns = [
    turn({ uuid: 'a', text: 'Install the Dependencies' }),
    turn({ uuid: 'b', type: 'user', text: 'the build\nis broken' }),
  ]

  it('answers the same as an index built for that one query', () => {
    const kept = buildReplayIndex(turns)
    for (const options of [{}, { exact: true }, { caseSensitive: true }, { exact: true, caseSensitive: true }]) {
      for (const q of ['install', 'Install', 'the build is', 'broken', 'zzz']) {
        expect(searchIndex(kept, q, options)).toEqual(searchIndex(buildReplayIndex(turns), q, options))
      }
    }
  })

  it('folds the text at build time, and holds one copy for the default search', () => {
    const index = buildReplayIndex(turns)
    expect(index.lowered[1]).toBe('the build is broken')   // the line break is gone
    expect(index.cased).toBeUndefined()
  })

  it('holds the cased copy only while the case toggle is on', () => {
    const index = buildReplayIndex(turns)
    searchIndex(index, 'Install', { caseSensitive: true })
    expect(index.cased).toBeDefined()
    searchIndex(index, 'install')
    expect(index.cased).toBeUndefined()
  })

  it('finds a term across what was a line break, in both modes', () => {
    const index = buildReplayIndex(turns)
    expect(searchIndex(index, 'the build is', { exact: true }).map(h => h.uuid)).toEqual(['b'])
    expect(searchIndex(index, '"build is broken"').map(h => h.uuid)).toEqual(['b'])
  })
})

describe('matchTurnParts', () => {
  const withTools = turn({
    uuid: 'z',
    text: 'Ran the check',
    thinking_text: 'weighing the parity report',
    tool_calls: [
      { id: 't1', name: 'Bash', input: { command: 'make ci-verify' } },
      { id: 't2', name: 'Read', input: { file_path: 'README.md' } },
    ],
  })
  const results = new Map([
    ['t1', { content: 'EXIT=1\nconflict in LabRepository.php', is_error: true }],
    ['t2', { content: 'a readme', is_error: false }],
  ])

  it('says which parts hold the terms and leaves the others out', () => {
    const m = matchTurnParts(withTools, 'ci-verify', results, { exact: true })
    expect(m.text).toBe(false)
    expect(m.thinking).toBe(false)
    expect([...m.inputs]).toEqual(['t1'])
    expect([...m.results]).toEqual([])
  })

  it('finds a term in a tool result, in the thinking and in the text', () => {
    expect([...matchTurnParts(withTools, 'LabRepository', results, { exact: true }).results]).toEqual(['t1'])
    expect(matchTurnParts(withTools, 'parity', results, { exact: true }).thinking).toBe(true)
    expect(matchTurnParts(withTools, 'Ran the check', results, { exact: true }).text).toBe(true)
  })

  it('matches a phrase that breaks a line inside a result', () => {
    expect([...matchTurnParts(withTools, 'EXIT=1 conflict', results, { exact: true }).results]).toEqual(['t1'])
  })

  it('marks the tool result of a user turn by its call id', () => {
    const user = turn({ uuid: 'u1', type: 'user', text: '', tool_results: [{ tool_use_id: 't9', content: 'no such file', is_error: true }] })
    expect([...matchTurnParts(user, 'no such file', undefined, { exact: true }).results]).toEqual(['t9'])
  })

  it('is empty for a blank query', () => {
    const m = matchTurnParts(withTools, '  ', results)
    expect(m.text || m.thinking || m.inputs.size > 0 || m.results.size > 0).toBe(false)
  })
})

describe('narrowing a search with the one before it', () => {
  const many = [
    turn({ uuid: 'a', text: 'verify the build' }),
    turn({ uuid: 'b', text: 'verify very carefully' }),
    turn({ uuid: 'c', text: 'nothing here' }),
    turn({ uuid: 'd', text: 'verify v2 of the plan' }),
  ]
  const exact = { exact: true }

  it('gives the same hits as a full scan, letter after letter', () => {
    const narrowed = buildReplayIndex(many)
    for (const q of ['v', 've', 'ver', 'veri', 'verify', 'verify v']) {
      const fresh = searchIndex(buildReplayIndex(many), q, exact)
      expect(searchIndex(narrowed, q, exact)).toEqual(fresh)
    }
  })

  it('only narrows when the query grows in the same exact mode', () => {
    const previous = { query: 'verify', options: { exact: true }, hits: [] }
    expect(narrowsFrom(previous, 'verify v', { exact: true })).toBe(true)
    expect(narrowsFrom(previous, 'verif', { exact: true })).toBe(false)      // a letter was taken away
    expect(narrowsFrom(previous, 'verify v', { exact: false })).toBe(false)  // a loose match can widen
    expect(narrowsFrom(previous, 'verify v', { exact: true, caseSensitive: true })).toBe(false)
    expect(narrowsFrom(undefined, 'verify', { exact: true })).toBe(false)
  })

  it('goes back to the full text when the query is cut back', () => {
    const index = buildReplayIndex(many)
    expect(searchIndex(index, 'verify v', exact).map(h => h.uuid)).toEqual(['b', 'd'])
    expect(searchIndex(index, 'verify', exact).map(h => h.uuid)).toEqual(['a', 'b', 'd'])
  })
})

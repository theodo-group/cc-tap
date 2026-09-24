import { describe, it, expect } from 'vitest'
import { searchTerms, fuzzyFind, findTerm, fold, foldText, matchesAll, matchesAny, inputText } from '@/lib/search-query'

describe('searchTerms', () => {
  it('splits words, lowercased, and drops the blanks', () => {
    expect(searchTerms('  Pnpm   ci-verify ')).toEqual(['pnpm', 'ci-verify'])
    expect(searchTerms('   ')).toEqual([])
  })
  it('keeps a quoted phrase whole, its inner whitespace folded', () => {
    expect(searchTerms('no "such file" here')).toEqual(['no', 'such file', 'here'])
    expect(searchTerms('"pnpm ci-verify" backend')).toEqual(['pnpm ci-verify', 'backend'])
    expect(searchTerms('"  pnpm   ci-verify "')).toEqual(['pnpm ci-verify'])
    expect(searchTerms('"unclosed')).toEqual(['"unclosed'])
  })
  it('keeps the case when asked', () => {
    expect(searchTerms('Install THE', { caseSensitive: true })).toEqual(['Install', 'THE'])
  })
  it('takes the whole query as one term in exact mode, quotes included', () => {
    expect(searchTerms('the broken build', { exact: true })).toEqual(['the broken build'])
    expect(searchTerms('"broken build"', { exact: true })).toEqual(['"broken build"'])
    expect(searchTerms('  a   b ', { exact: true })).toEqual(['a b'])
  })
})

describe('fold and foldText', () => {
  it('collapses every whitespace run to one space', () => {
    expect(fold('a \n\n  b\tc')).toBe('a b c')
  })
  it('lowercases unless the search is case-sensitive', () => {
    expect(foldText('The\nBuild')).toBe('the build')
    expect(foldText('The\nBuild', { caseSensitive: true })).toBe('The Build')
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

describe('findTerm', () => {
  it('prefers a literal occurrence', () => {
    expect(findTerm('the rebase step', 'rebase')).toEqual({ start: 4, cost: 0 })
  })
  it('falls back to a loose match for a lone word only', () => {
    expect(findTerm('the rebase step', 'rbase')).toEqual({ start: 4, cost: 1 })
    expect(findTerm('the rebase step', 'rbase', true)).toBeNull()          // exact mode
    expect(findTerm('the rebase step', 'the rbase')).toBeNull()            // a phrase
  })
})

describe('matchesAll', () => {
  it('requires every term, case-insensitively, in any order', () => {
    expect(matchesAll('run CI-Verify with pnpm', ['pnpm', 'ci-verify'])).toBe(true)
    expect(matchesAll('pnpm test', ['pnpm', 'ci-verify'])).toBe(false)
    expect(matchesAll('anything', [])).toBe(false)
  })
  it('matches a phrase as that phrase, across a line break', () => {
    const phrase = searchTerms('"pnpm ci-verify"')
    expect(matchesAll('cd x && pnpm ci-verify', phrase)).toBe(true)
    expect(matchesAll('cd x && pnpm\n  ci-verify', phrase)).toBe(true)
    expect(matchesAll('pnpm run ci-verify', phrase)).toBe(false)
    expect(matchesAll('pnpm install && make ci-verify', phrase)).toBe(false)
    expect(matchesAll('pnpm install && make ci-verify', searchTerms('pnpm ci-verify'))).toBe(true)
  })
  it('matches a lone word loosely out of exact mode, and never in it', () => {
    expect(matchesAll('Install the dependencies', ['depncies'])).toBe(true)
    expect(matchesAll('Install the dependencies', ['depncies'], { exact: true })).toBe(false)
  })
  it('respects the case when asked', () => {
    expect(matchesAll('Install the deps', ['Install'], { caseSensitive: true })).toBe(true)
    expect(matchesAll('Install the deps', ['install'], { caseSensitive: true })).toBe(false)
  })
})

describe('matchesAny', () => {
  it('needs one term only', () => {
    expect(matchesAny('the build is broken', ['zzz', 'broken'])).toBe(true)
    expect(matchesAny('the build is broken', ['zzz'])).toBe(false)
    expect(matchesAny('anything', [])).toBe(false)
  })
})

describe('inputText', () => {
  it('joins the values of a tool input and never its keys', () => {
    expect(inputText({ command: 'ls', nested: { flags: ['-a', 2] } })).toBe('ls\n-a\n2')
    expect(matchesAll(inputText({ command: 'ls' }), ['command'])).toBe(false)
  })
})

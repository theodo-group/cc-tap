import { describe, it, expect } from 'vitest'
import { flattenPieces, locateFlat, flatMatches } from '@/lib/replay-highlight'

describe('flattenPieces', () => {
  it('collapses every whitespace run to one space, across pieces', () => {
    const { flat } = flattenPieces(['  the   file\n', '\n  o-asia-lab-param.json', "  ['local']"])
    expect(flat).toBe("the file o-asia-lab-param.json ['local']")
  })

  it('leaves out a piece that yields nothing', () => {
    // The trailing whitespace piece adds nothing: the run before it already ended
    const { flat, pieces } = flattenPieces(['one ', '\n   ', 'two'])
    expect(flat).toBe('one two')
    expect(pieces.map(p => p.index)).toEqual([0, 2])
  })

  it('maps every flat character back to its raw offset', () => {
    const raws = ['a  b', '\nc']
    const { flat, pieces } = flattenPieces(raws)
    expect(flat).toBe('a b c')
    for (let i = 0; i < flat.length; i++) {
      const at = locateFlat(pieces, raws, i)!
      expect(raws[at.piece][at.offset]).toBe(flat[i] === ' ' ? raws[at.piece][at.offset] : flat[i])
    }
  })
})

describe('flatMatches over pieces', () => {
  const raws = ['Reading ', 'o-asia-lab-param.json\n', "['local'] mail-orders-to-asia"]
  const { flat, pieces } = flattenPieces(raws)

  it('finds a term that spans a line break and several pieces', () => {
    const term = "o-asia-lab-param.json ['local'] mail-orders-t"
    const [m] = flatMatches(flat, [term.toLowerCase()], 10)
    expect(m).toBeDefined()
    const from = locateFlat(pieces, raws, m.start)!
    const last = locateFlat(pieces, raws, m.end - 1)!
    expect(from.piece).toBe(1)
    expect(from.offset).toBe(0)
    expect(last.piece).toBe(2)
    expect(raws[last.piece][last.offset]).toBe('t')
  })

  it('matches the case when asked', () => {
    expect(flatMatches(flat, ['reading'], 10, true)).toEqual([])
    expect(flatMatches(flat, ['Reading'], 10, true)).toHaveLength(1)
  })

  it('stops at the budget', () => {
    expect(flatMatches('a a a a', ['a'], 2)).toHaveLength(2)
  })
})

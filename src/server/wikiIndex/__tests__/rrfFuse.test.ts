import { describe, expect, it } from 'bun:test'
import { rrfFuse, type GrepHit, type VecHit } from '../query.js'

const grep = (file: string, line_no: number, line: string): GrepHit => ({ file, line_no, line })
const vec = (file: string, startLine: number, text: string, title = ''): VecHit => ({
  file, startLine, endLine: startLine, title, text, score: 0.5,
})

describe('rrfFuse', () => {
  it('returns empty when both sources empty', () => {
    expect(rrfFuse([], [])).toEqual([])
  })

  it('keeps grep-only when no vec hits', () => {
    const hits = rrfFuse([grep('a.md', 5, 'hello'), grep('b.md', 7, 'world')], [])
    expect(hits.length).toBe(2)
    expect(hits.every((h) => h.source === 'grep')).toBe(true)
  })

  it('keeps vec-only when no grep hits, formats line with [vec] prefix', () => {
    const hits = rrfFuse([], [vec('c.md', 3, 'semantic content', 'Topic')])
    expect(hits.length).toBe(1)
    expect(hits[0]!.source).toBe('vec')
    expect(hits[0]!.line).toContain('[vec]')
    expect(hits[0]!.line).toContain('Topic')
    expect(hits[0]!.line).toContain('semantic content')
  })

  it('merges and ranks by RRF, higher in both lists wins', () => {
    const grepHits: GrepHit[] = [
      grep('a.md', 1, 'only-grep'),
      grep('b.md', 2, 'mixed'),
      grep('c.md', 3, 'tail'),
    ]
    const vecHits: VecHit[] = [
      vec('d.md', 4, 'only-vec'),
      vec('b.md', 2, 'mixed-vec'),
    ]
    const out = rrfFuse(grepHits, vecHits)
    expect(out.length).toBe(4)
    // b.md#2 appears in both → highest score
    expect(out[0]!.file).toBe('b.md')
    expect(out[0]!.source).toBe('both')
  })

  it('dedupes on (file, line_no/startLine)', () => {
    const out = rrfFuse([grep('x.md', 10, 'g')], [vec('x.md', 10, 'v', 'T')])
    expect(out.length).toBe(1)
    expect(out[0]!.source).toBe('both')
  })

  it('respects custom k (smaller k → higher absolute scores)', () => {
    const small = rrfFuse([grep('a.md', 1, 'x')], [], { k: 1 })
    const big = rrfFuse([grep('a.md', 1, 'x')], [], { k: 100 })
    expect(small[0]!.score).toBeGreaterThan(big[0]!.score)
  })

  it('truncates vec snippet to configured chars', () => {
    const longText = 'x'.repeat(1000)
    const out = rrfFuse([], [vec('a.md', 1, longText)], { vecSnippetChars: 50 })
    // [vec]  + 50 chars; expect line shorter than full text
    expect(out[0]!.line.length).toBeLessThan(longText.length)
    expect(out[0]!.line.length).toBeGreaterThanOrEqual(50)
  })
})

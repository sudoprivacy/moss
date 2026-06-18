import { describe, expect, it } from 'bun:test'
import { splitMarkdown } from '../chunkSplitter.js'

describe('splitMarkdown', () => {
  it('returns empty for empty input', () => {
    expect(splitMarkdown('', 'empty.md')).toEqual([])
  })

  it('skips YAML frontmatter and offsets line numbers', () => {
    const md = [
      '---',
      'title: Foo',
      'type: chunk',
      '---',
      '',
      '# Heading One',
      '',
      'First paragraph body.',
      '',
      'Second paragraph body.',
    ].join('\n')
    const passages = splitMarkdown(md, 'f.md')
    expect(passages.length).toBe(2)
    expect(passages[0]!.title).toBe('Heading One')
    expect(passages[0]!.text).toBe('First paragraph body.')
    // Body of frontmatter is 4 lines. Heading is line 6 in file. Para starts line 8.
    expect(passages[0]!.startLine).toBe(8)
    expect(passages[1]!.startLine).toBe(10)
  })

  it('updates title across multiple headings', () => {
    const md = [
      '# A',
      '',
      'aaa para',
      '',
      '## B',
      '',
      'bbb para',
    ].join('\n')
    const passages = splitMarkdown(md, 'x.md')
    expect(passages.map((p) => p.title)).toEqual(['A', 'B'])
  })

  it('does not embed heading text as its own passage', () => {
    const passages = splitMarkdown('# Only a heading\n', 'x.md')
    expect(passages).toEqual([])
  })

  it('splits on blank lines', () => {
    const md = 'para one\n\npara two\n\npara three'
    const passages = splitMarkdown(md, 'x.md')
    expect(passages.length).toBe(3)
  })

  it('falls back title to filename when no heading present', () => {
    const passages = splitMarkdown('hello world', 'logistics.md')
    expect(passages.length).toBe(1)
    expect(passages[0]!.title).toBe('logistics')
  })

  it('drops image-only lines', () => {
    const md = '![alt](img/a.png)\n\nreal content'
    const passages = splitMarkdown(md, 'x.md')
    expect(passages.length).toBe(1)
    expect(passages[0]!.text).toBe('real content')
  })

  it('splits oversize paragraphs at sentence boundaries', () => {
    // Build a 1500-char paragraph with sentence boundaries every ~200 chars.
    const sentence = 'A'.repeat(180) + '。'
    const big = Array.from({ length: 8 }, () => sentence).join('')
    const passages = splitMarkdown(big, 'big.md', { maxChars: 500 })
    expect(passages.length).toBeGreaterThan(1)
    for (const p of passages) {
      expect(p.text.length).toBeLessThanOrEqual(500)
    }
  })

  it('keeps tables together regardless of intra-table whitespace', () => {
    const md = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'].join('\n')
    const passages = splitMarkdown(md, 't.md')
    expect(passages.length).toBe(1)
    expect(passages[0]!.text).toContain('| 1 | 2 |')
    expect(passages[0]!.text).toContain('| 3 | 4 |')
  })

  it('caps total passages at maxPassages', () => {
    const md = Array.from({ length: 50 }, (_, i) => `p${i}`).join('\n\n')
    const passages = splitMarkdown(md, 'x.md', { maxPassages: 10 })
    expect(passages.length).toBe(10)
  })

  it('handles file with only frontmatter', () => {
    const md = '---\ntitle: a\n---\n'
    expect(splitMarkdown(md, 'x.md')).toEqual([])
  })

  it('preserves passage text content faithfully', () => {
    const md = '一些中文段落。包含标点和换行。\n后面接一行。'
    const passages = splitMarkdown(md, 'x.md')
    expect(passages.length).toBe(1)
    expect(passages[0]!.text).toContain('一些中文段落')
    expect(passages[0]!.text).toContain('后面接一行')
  })
})

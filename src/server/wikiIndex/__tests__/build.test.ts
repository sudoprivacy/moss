import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildVectorIndex } from '../build.js'
import {
  _resetEmbedderForTests,
  _setEmbedderForTests,
  type Embedder,
} from '../embedder.js'
import {
  WIKI_VECTOR_BIN_FILE,
  WIKI_VECTOR_JSONL_FILE,
} from '../../../utils/wikis/localWikiDirectories.js'

/** Deterministic fake embedder: hash text -> repeatable vector. */
function makeFakeEmbedder(dim = 8): Embedder {
  const embed = (text: string): Float32Array => {
    // Simple deterministic hash → float vector. Not real embeddings;
    // good enough to exercise the build pipeline & vectorSearch math.
    const v = new Float32Array(dim)
    let h = 2166136261 >>> 0
    for (let i = 0; i < text.length; i++) {
      h = ((h ^ text.charCodeAt(i)) * 16777619) >>> 0
    }
    for (let d = 0; d < dim; d++) {
      h = (h * 1103515245 + 12345) >>> 0
      v[d] = ((h % 1000) / 1000) - 0.5
    }
    // L2 normalize
    let s = 0
    for (let d = 0; d < dim; d++) s += v[d]! * v[d]!
    const n = Math.sqrt(s) || 1
    for (let d = 0; d < dim; d++) v[d] = v[d]! / n
    return v
  }
  return {
    dim,
    modelId: 'fake-test',
    passage: async (texts: string[]) => texts.map(embed),
    query: async (text: string) => embed(text),
  }
}

describe('buildVectorIndex', () => {
  let stageDir: string

  beforeEach(async () => {
    _resetEmbedderForTests()
    stageDir = await mkdtemp(path.join(tmpdir(), 'moss-wiki-build-'))
  })

  afterEach(async () => {
    _resetEmbedderForTests()
    await rm(stageDir, { recursive: true, force: true })
  })

  it('returns no-passages when stage dir has no markdown', async () => {
    _setEmbedderForTests(makeFakeEmbedder())
    const result = await buildVectorIndex({
      stageDir,
      modelId: 'fake-test',
      cacheDir: stageDir,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-passages')
  })

  it('returns embedder-unavailable when model cannot be loaded', async () => {
    _setEmbedderForTests(null)
    await writeFile(path.join(stageDir, 'WIKI.md'), '# Index\n\nhello world')
    const result = await buildVectorIndex({
      stageDir,
      modelId: 'fake-test',
      cacheDir: stageDir,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('embedder-unavailable')
  })

  it('writes .bin and .jsonl with correct sizes for the embedded passages', async () => {
    const fake = makeFakeEmbedder(8)
    _setEmbedderForTests(fake)
    await writeFile(
      path.join(stageDir, 'WIKI.md'),
      '# Overview\n\nThis is the index page describing the wiki.',
    )
    await writeFile(
      path.join(stageDir, 'chunk-001-foo.md'),
      [
        '---',
        'title: Foo',
        'type: chunk',
        '---',
        '',
        '# Foo',
        '',
        '第一段关于 foo 的内容。',
        '',
        '第二段更详细的解释。',
      ].join('\n'),
    )

    const result = await buildVectorIndex({
      stageDir,
      modelId: 'fake-test',
      cacheDir: stageDir,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.count).toBeGreaterThan(0)

    const binPath = path.join(stageDir, WIKI_VECTOR_BIN_FILE)
    const jsonlPath = path.join(stageDir, WIKI_VECTOR_JSONL_FILE)

    const binStat = await stat(binPath)
    expect(binStat.size).toBe(result.count * 8 * 4)

    const jsonl = await readFile(jsonlPath, 'utf-8')
    const lines = jsonl.split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(result.count + 1) // manifest + passages

    const manifest = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(manifest.version).toBe(1)
    expect(manifest.model).toBe('fake-test')
    expect(manifest.dim).toBe(8)
    expect(manifest.count).toBe(result.count)
    expect(typeof manifest.builtAt).toBe('number')

    const firstPassage = JSON.parse(lines[1]!) as Record<string, unknown>
    expect(typeof firstPassage.file).toBe('string')
    expect(typeof firstPassage.startLine).toBe('number')
    expect(typeof firstPassage.text).toBe('string')
  })

  it('truncates at maxPassages', async () => {
    _setEmbedderForTests(makeFakeEmbedder(4))
    // 60 short paragraphs in one chunk.
    const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}.`).join('\n\n')
    await writeFile(path.join(stageDir, 'chunk-001-big.md'), body)
    const result = await buildVectorIndex({
      stageDir,
      modelId: 'fake-test',
      cacheDir: stageDir,
      maxPassages: 10,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.count).toBe(10)
  })
})

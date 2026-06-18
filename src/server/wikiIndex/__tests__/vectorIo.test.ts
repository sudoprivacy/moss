import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  _resetIndexCacheForTests,
  loadIndex,
  vectorSearch,
} from '../query.js'
import {
  WIKI_VECTOR_BIN_FILE,
  WIKI_VECTOR_JSONL_FILE,
} from '../../../utils/wikis/localWikiDirectories.js'

function l2Normalize(vec: number[]): number[] {
  let s = 0
  for (const v of vec) s += v * v
  const n = Math.sqrt(s) || 1
  return vec.map((v) => v / n)
}

async function writeFakeIndex(
  dir: string,
  vectors: number[][],
  passages: Array<{ file: string; startLine: number; endLine: number; title: string; text: string }>,
  manifestOverride?: Partial<{ dim: number; count: number; builtAt: number; model: string; version: number }>,
): Promise<void> {
  const dim = vectors[0]?.length ?? 0
  const count = vectors.length
  const flat = new Float32Array(count * dim)
  for (let i = 0; i < count; i++) {
    const v = l2Normalize(vectors[i]!)
    for (let d = 0; d < dim; d++) flat[i * dim + d] = v[d]!
  }
  // .bin
  await writeFile(path.join(dir, WIKI_VECTOR_BIN_FILE), Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength))
  // .jsonl
  const manifest = {
    version: 1,
    model: 'fake-model',
    dim,
    count,
    builtAt: Date.now(),
    ...manifestOverride,
  }
  const lines: string[] = [JSON.stringify(manifest)]
  for (const p of passages) lines.push(JSON.stringify(p))
  await writeFile(path.join(dir, WIKI_VECTOR_JSONL_FILE), lines.join('\n') + '\n')
}

describe('loadIndex + vectorSearch', () => {
  let dir: string

  beforeEach(async () => {
    _resetIndexCacheForTests()
    dir = await mkdtemp(path.join(tmpdir(), 'moss-wikiidx-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when sidecar is missing', async () => {
    expect(await loadIndex(dir)).toBeNull()
  })

  it('loads index and recovers manifest', async () => {
    await writeFakeIndex(dir, [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ], [
      { file: 'a.md', startLine: 1, endLine: 2, title: 'A', text: 'alpha' },
      { file: 'b.md', startLine: 1, endLine: 2, title: 'B', text: 'beta' },
      { file: 'c.md', startLine: 1, endLine: 2, title: 'C', text: 'gamma' },
    ])
    const idx = await loadIndex(dir)
    expect(idx).not.toBeNull()
    expect(idx!.manifest.count).toBe(3)
    expect(idx!.manifest.dim).toBe(4)
    expect(idx!.passages.length).toBe(3)
    expect(idx!.vectors.length).toBe(12)
  })

  it('vectorSearch picks the nearest neighbor', async () => {
    await writeFakeIndex(dir, [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ], [
      { file: 'a.md', startLine: 1, endLine: 2, title: 'A', text: 'alpha' },
      { file: 'b.md', startLine: 1, endLine: 2, title: 'B', text: 'beta' },
      { file: 'c.md', startLine: 1, endLine: 2, title: 'C', text: 'gamma' },
    ])
    const idx = await loadIndex(dir)
    const q = new Float32Array(l2Normalize([0, 0.9, 0.1, 0]))
    const hits = vectorSearch(idx!, q, 2)
    expect(hits.length).toBe(2)
    expect(hits[0]!.file).toBe('b.md')
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it('rejects size mismatch between .bin and manifest', async () => {
    await writeFakeIndex(
      dir,
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
      [
        { file: 'a.md', startLine: 1, endLine: 2, title: 'A', text: 'alpha' },
        { file: 'b.md', startLine: 1, endLine: 2, title: 'B', text: 'beta' },
      ],
      // Lie about count → expected bytes won't match actual.
      { count: 99 },
    )
    expect(await loadIndex(dir)).toBeNull()
  })

  it('rejects when jsonl row count disagrees with manifest', async () => {
    // Write a valid bin but extra passage lines.
    await writeFakeIndex(
      dir,
      [
        [1, 0, 0, 0],
      ],
      [
        { file: 'a.md', startLine: 1, endLine: 2, title: 'A', text: 'alpha' },
        { file: 'extra.md', startLine: 1, endLine: 2, title: 'X', text: 'extra' },
      ],
      // manifest claims count=1 but jsonl has 2 passages
      { count: 1 },
    )
    expect(await loadIndex(dir)).toBeNull()
  })

  it('caches across calls (same builtAt)', async () => {
    await writeFakeIndex(
      dir,
      [[1, 0, 0, 0]],
      [{ file: 'a.md', startLine: 1, endLine: 1, title: 'A', text: 'a' }],
      { builtAt: 12345 },
    )
    const a = await loadIndex(dir)
    const b = await loadIndex(dir)
    expect(a).toBe(b) // identity-equal -> served from cache
  })
})

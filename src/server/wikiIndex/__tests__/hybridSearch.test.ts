/**
 * End-to-end test of the hybrid wiki search orchestration without booting
 * the full server. The HTTP route in server.ts wires up these exact
 * primitives in this exact order; testing them as a unit gives us
 * confidence that grep + vec + RRF degrades correctly across the matrix
 * of (index present | absent) × (embedder loadable | not).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  _resetIndexCacheForTests,
  loadIndex,
  rrfFuse,
  runWikiGrep,
  vectorSearch,
} from '../query.js'
import {
  _resetEmbedderForTests,
  _setEmbedderForTests,
  ensureEmbedder,
  type Embedder,
} from '../embedder.js'
import { buildVectorIndex } from '../build.js'

function makeFakeEmbedder(dim = 16): Embedder {
  const embed = (text: string): Float32Array => {
    const v = new Float32Array(dim)
    let h = 2166136261 >>> 0
    for (let i = 0; i < text.length; i++) {
      h = ((h ^ text.charCodeAt(i)) * 16777619) >>> 0
    }
    for (let d = 0; d < dim; d++) {
      h = (h * 1103515245 + 12345) >>> 0
      v[d] = ((h % 1000) / 1000) - 0.5
    }
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

async function setupWikiWithIndex(): Promise<string> {
  const wikiDir = await mkdtemp(path.join(tmpdir(), 'moss-search-test-'))
  await writeFile(
    path.join(wikiDir, 'WIKI.md'),
    [
      '---',
      'title: Test Wiki',
      'type: index',
      '---',
      '',
      '# Test Wiki',
      '',
      '本 Wiki 涵盖产品的核心使用流程。',
    ].join('\n'),
  )
  await writeFile(
    path.join(wikiDir, 'chunk-001-logistics.md'),
    [
      '---',
      'title: 物流流程',
      'type: chunk',
      '---',
      '',
      '# 物流流程',
      '',
      '退货物流编号由仓库录入，格式为 LOG-YYYYMMDD-NNNN。',
      '',
      '物流单号必须满足以下校验规则: 前缀+日期+序号。',
    ].join('\n'),
  )
  await writeFile(
    path.join(wikiDir, 'chunk-002-finance.md'),
    [
      '---',
      'title: 财务对账',
      'type: chunk',
      '---',
      '',
      '# 财务对账',
      '',
      '月度对账由财务团队在每月 5 日前完成。',
      '',
      '海关单匹配需要核对金额和汇率。',
    ].join('\n'),
  )
  return wikiDir
}

/**
 * Mirror of the server.ts hybrid orchestration. Keep in sync with
 * `pathname.match(/agent\/wikis\/[^/]+\/search$/)` handler in server.ts.
 */
async function hybridSearch(
  wikiDir: string,
  query: string,
  opts: { indexEnabled: boolean; topKVector?: number },
): Promise<Array<{ file: string; line_no: number; line: string }>> {
  const grepHits = await runWikiGrep(wikiDir, query)
  let vecHits: ReturnType<typeof vectorSearch> = []
  if (opts.indexEnabled) {
    const idx = await loadIndex(wikiDir)
    if (idx) {
      const emb = await ensureEmbedder({
        modelId: 'fake-test',
        cacheDir: wikiDir,
      })
      if (emb) {
        const qVec = await emb.query(query)
        vecHits = vectorSearch(idx, qVec, opts.topKVector ?? 50)
      }
    }
  }
  const fused = vecHits.length === 0 ? grepHits.slice(0, 100) : rrfFuse(grepHits, vecHits).slice(0, 100)
  return fused.map((h) => ({ file: h.file, line_no: h.line_no, line: h.line }))
}

describe('hybrid wiki search orchestration', () => {
  let wikiDir: string

  beforeEach(async () => {
    _resetIndexCacheForTests()
    _resetEmbedderForTests()
    wikiDir = await setupWikiWithIndex()
  })

  afterEach(async () => {
    _resetEmbedderForTests()
    _resetIndexCacheForTests()
    await rm(wikiDir, { recursive: true, force: true })
  })

  it('returns only grep results when no index sidecar exists', async () => {
    _setEmbedderForTests(makeFakeEmbedder())
    const results = await hybridSearch(wikiDir, '物流', { indexEnabled: true })
    expect(results.length).toBeGreaterThan(0)
    // None of the results should be [vec]-tagged since there's no index.
    expect(results.every((r) => !r.line.startsWith('[vec]'))).toBe(true)
  })

  it('returns only grep results when feature flag is off', async () => {
    _setEmbedderForTests(makeFakeEmbedder())
    const build = await buildVectorIndex({ stageDir: wikiDir, modelId: 'fake-test', cacheDir: wikiDir })
    expect(build.ok).toBe(true)
    const results = await hybridSearch(wikiDir, '物流', { indexEnabled: false })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => !r.line.startsWith('[vec]'))).toBe(true)
  })

  it('fuses grep + vec results when index present and embedder available', async () => {
    _setEmbedderForTests(makeFakeEmbedder())
    const build = await buildVectorIndex({ stageDir: wikiDir, modelId: 'fake-test', cacheDir: wikiDir })
    expect(build.ok).toBe(true)
    const results = await hybridSearch(wikiDir, '物流', { indexEnabled: true })
    expect(results.length).toBeGreaterThan(0)
    // Should include at least one vec-tagged result since the index exists.
    const vecResults = results.filter((r) => r.line.startsWith('[vec]'))
    expect(vecResults.length).toBeGreaterThan(0)
  })

  it('falls back to grep-only when embedder is unavailable', async () => {
    _setEmbedderForTests(null)
    // Build with a fake first so the index file exists.
    const fake = makeFakeEmbedder()
    _setEmbedderForTests(fake)
    const build = await buildVectorIndex({ stageDir: wikiDir, modelId: 'fake-test', cacheDir: wikiDir })
    expect(build.ok).toBe(true)
    // Now flip embedder off for query time.
    _setEmbedderForTests(null)
    const results = await hybridSearch(wikiDir, '物流', { indexEnabled: true })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => !r.line.startsWith('[vec]'))).toBe(true)
  })

  it('grep alone returns nothing for synonym queries (baseline for the value prop)', async () => {
    // Query "返厂" but document only says "退货". Grep should miss entirely.
    const grepOnly = await runWikiGrep(wikiDir, '返厂')
    expect(grepOnly.length).toBe(0)
  })

  it('returns wiki-CLI-compatible shape (file, line_no, line)', async () => {
    _setEmbedderForTests(makeFakeEmbedder())
    const build = await buildVectorIndex({ stageDir: wikiDir, modelId: 'fake-test', cacheDir: wikiDir })
    expect(build.ok).toBe(true)
    const results = await hybridSearch(wikiDir, '物流', { indexEnabled: true })
    for (const r of results) {
      expect(typeof r.file).toBe('string')
      expect(typeof r.line_no).toBe('number')
      expect(typeof r.line).toBe('string')
      expect(r.file.endsWith('.md')).toBe(true)
      expect(r.line_no).toBeGreaterThan(0)
    }
  })

  it('caps output at 100 matches', async () => {
    // Synthesize many grep hits in a fresh wiki.
    const big = await mkdtemp(path.join(tmpdir(), 'moss-search-big-'))
    try {
      const lines = Array.from({ length: 300 }, (_, i) => `line ${i} match-token`).join('\n')
      await writeFile(path.join(big, 'chunk-001.md'), lines)
      const results = await hybridSearch(big, 'match-token', { indexEnabled: false })
      expect(results.length).toBeLessThanOrEqual(100)
    } finally {
      await rm(big, { recursive: true, force: true })
    }
  })
})

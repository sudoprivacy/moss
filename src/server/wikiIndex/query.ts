/**
 * Vector-side query helpers for the wiki vector index.
 *
 * On-disk layout (produced by build.ts, published atomically by
 * WikiJobExecutor.publishStaged):
 *
 *   <wikiDir>/_moss_index.bin    raw Float32Array, length = count * dim
 *                                (L2-normalized, row-major). No header.
 *   <wikiDir>/_moss_index.jsonl  one JSON object per line.
 *     Line 0 = manifest: { version, model, dim, count, builtAt }
 *     Line i (i>=1) = passage: { file, startLine, endLine, title, text }
 *
 * Both files are loaded together; the .bin size MUST equal
 *   manifest.count * manifest.dim * 4
 * otherwise we treat the index as corrupt and return null (callers fall
 * back to grep-only). This is the only consistency gate — we don't verify
 * vector norms or jsonl ordering at load time.
 *
 * loadIndex caches by `${wikiDir}@${manifest.builtAt}`: a fresh build always
 * gets a different builtAt, so cache invalidation happens for free without
 * needing fs-watch or explicit eviction.
 */

import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import { WIKI_VECTOR_BIN_FILE, WIKI_VECTOR_JSONL_FILE } from '../../utils/wikis/localWikiDirectories.js'
import type { Passage } from './chunkSplitter.js'

export interface IndexManifest {
  version: number
  model: string
  dim: number
  count: number
  builtAt: number
}

export interface LoadedIndex {
  wikiDir: string
  manifest: IndexManifest
  /** Flat Float32Array, length = count * dim. Row i = passages[i] embedding. */
  vectors: Float32Array
  passages: Passage[]
}

export interface VecHit {
  file: string
  startLine: number
  endLine: number
  title: string
  text: string
  /** Cosine similarity in [-1, 1]; higher = more similar. */
  score: number
}

export interface GrepHit {
  file: string
  line_no: number
  line: string
}

export interface FusedHit {
  file: string
  line_no: number
  line: string
  /** Combined RRF score (sum of 1/(k+rank) across sources). */
  score: number
  /** Where this hit was found. Useful for debugging; not surfaced to wiki CLI. */
  source: 'grep' | 'vec' | 'both'
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_CAP = 4
const cache = new Map<string, LoadedIndex>()

/** Test hook — drop all cached indexes. */
export function _resetIndexCacheForTests(): void {
  cache.clear()
}

// ---------------------------------------------------------------------------
// loadIndex
// ---------------------------------------------------------------------------

export async function loadIndex(wikiDir: string): Promise<LoadedIndex | null> {
  const binPath = path.join(wikiDir, WIKI_VECTOR_BIN_FILE)
  const jsonlPath = path.join(wikiDir, WIKI_VECTOR_JSONL_FILE)

  // Cheap presence check before we read anything heavy.
  let binSize: number
  try {
    binSize = (await stat(binPath)).size
    await stat(jsonlPath)
  } catch {
    return null // missing sidecar — caller falls back to grep
  }

  // Read jsonl head first to get manifest. We could stream but these files
  // are small (≤ a few MB), so a single readFile is fine.
  let raw: string
  try {
    raw = await readFile(jsonlPath, 'utf-8')
  } catch {
    return null
  }
  const lines = raw.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return null

  let manifest: IndexManifest
  try {
    const parsed = JSON.parse(lines[0]!) as Partial<IndexManifest>
    if (
      typeof parsed.dim !== 'number' ||
      typeof parsed.count !== 'number' ||
      typeof parsed.builtAt !== 'number'
    ) {
      return null
    }
    manifest = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
      dim: parsed.dim,
      count: parsed.count,
      builtAt: parsed.builtAt,
    }
  } catch {
    return null
  }

  // Cache hit?
  const cacheKey = `${wikiDir}@${manifest.builtAt}`
  const cached = cache.get(cacheKey)
  if (cached) {
    // Refresh LRU position.
    cache.delete(cacheKey)
    cache.set(cacheKey, cached)
    return cached
  }

  // Consistency gate: .bin size must match manifest.
  const expectedBytes = manifest.count * manifest.dim * 4
  if (binSize !== expectedBytes) {
    console.warn(
      `[wikiIndex] index size mismatch at ${wikiDir}: bin=${binSize} expected=${expectedBytes}`,
    )
    return null
  }

  // count + 1 because line 0 is manifest, lines 1..count are passages.
  if (lines.length !== manifest.count + 1) {
    console.warn(
      `[wikiIndex] jsonl row mismatch at ${wikiDir}: lines=${lines.length - 1} expected=${manifest.count}`,
    )
    return null
  }

  const passages: Passage[] = []
  for (let i = 1; i < lines.length; i++) {
    try {
      const p = JSON.parse(lines[i]!) as Passage
      passages.push(p)
    } catch {
      return null
    }
  }

  let buf: Buffer
  try {
    buf = await readFile(binPath)
  } catch {
    return null
  }
  // Float32Array view onto the buffer (zero-copy when aligned; small copy otherwise).
  const vectors = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / 4,
  )

  const loaded: LoadedIndex = { wikiDir, manifest, vectors, passages }

  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(cacheKey, loaded)
  return loaded
}

// ---------------------------------------------------------------------------
// vectorSearch
// ---------------------------------------------------------------------------

/**
 * Brute-force cosine top-K. Vectors are assumed L2-normalized (embedder
 * normalizes during embed), so cosine == dot product. For 500–3000 rows ×
 * 384 dims this runs in single-digit ms on a typical workstation.
 *
 * Returns hits sorted by descending score.
 */
export function vectorSearch(idx: LoadedIndex, qVec: Float32Array, topK: number): VecHit[] {
  const { manifest, vectors, passages } = idx
  if (qVec.length !== manifest.dim) {
    console.warn(`[wikiIndex] query dim ${qVec.length} != index dim ${manifest.dim}`)
    return []
  }
  if (topK <= 0) return []
  const k = Math.min(topK, manifest.count)

  // Heap of size k, min-score at top. Use plain array with linear ops since k is small.
  const heap: Array<{ row: number; score: number }> = []
  for (let row = 0; row < manifest.count; row++) {
    const offset = row * manifest.dim
    let dot = 0
    for (let d = 0; d < manifest.dim; d++) {
      dot += (vectors[offset + d] ?? 0) * (qVec[d] ?? 0)
    }
    if (heap.length < k) {
      heap.push({ row, score: dot })
      if (heap.length === k) heap.sort((a, b) => a.score - b.score)
    } else if (dot > (heap[0]?.score ?? -Infinity)) {
      heap[0] = { row, score: dot }
      // Re-heapify by sort — O(k log k) per replacement but k is tiny (≤200).
      heap.sort((a, b) => a.score - b.score)
    }
  }
  heap.sort((a, b) => b.score - a.score)
  return heap.map((h) => {
    const p = passages[h.row]!
    return {
      file: p.file,
      startLine: p.startLine,
      endLine: p.endLine,
      title: p.title,
      text: p.text,
      score: h.score,
    }
  })
}

// ---------------------------------------------------------------------------
// rrfFuse
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion of two ranked lists with k=60 (standard default).
 * Unifies grep (per-line) and vector (per-passage) hits by deduping on
 * (file, line_no/startLine). Returns wiki-CLI-compatible rows.
 *
 * grep hits keep their original line / line_no. Vector hits get rendered as
 * a single-line representative: `[vec] <title>: <text snippet>` so the agent
 * can spot the source. Vector hits' line_no == passage.startLine.
 */
export function rrfFuse(
  grepHits: GrepHit[],
  vecHits: VecHit[],
  opts: { k?: number; vecSnippetChars?: number } = {},
): FusedHit[] {
  const k = opts.k ?? 60
  const snippetChars = opts.vecSnippetChars ?? 200
  const map = new Map<string, FusedHit>()

  grepHits.forEach((h, rank) => {
    const key = `${h.file}#${h.line_no}`
    const inc = 1 / (k + rank)
    const existing = map.get(key)
    if (existing) {
      existing.score += inc
      existing.source = existing.source === 'vec' ? 'both' : existing.source
    } else {
      map.set(key, {
        file: h.file,
        line_no: h.line_no,
        line: h.line,
        score: inc,
        source: 'grep',
      })
    }
  })

  vecHits.forEach((h, rank) => {
    const key = `${h.file}#${h.startLine}`
    const inc = 1 / (k + rank)
    const snippet = h.text.replace(/\s+/g, ' ').slice(0, snippetChars)
    const titlePart = h.title ? `${h.title}: ` : ''
    const repLine = `[vec] ${titlePart}${snippet}`
    const existing = map.get(key)
    if (existing) {
      existing.score += inc
      existing.source = existing.source === 'grep' ? 'both' : existing.source
    } else {
      map.set(key, {
        file: h.file,
        line_no: h.startLine,
        line: repLine,
        score: inc,
        source: 'vec',
      })
    }
  })

  return [...map.values()].sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------------------
// runWikiGrep: literal substring grep used as the keyword arm of hybrid search
// ---------------------------------------------------------------------------

/**
 * Line-level case-insensitive substring grep across `.md` files at the top
 * level of a wiki dir. Caps at `limit` matches to bound work. Returns
 * GrepHit[] in source-file scan order — that order doubles as the rank for
 * RRF fusion, so callers should not reorder before fusing.
 *
 * Errors are swallowed: missing/unreadable wiki dir returns []. The caller
 * sits behind agent auth and rate limiting, so this is fine.
 */
export async function runWikiGrep(
  wikiDir: string,
  query: string,
  limit = 100,
): Promise<GrepHit[]> {
  const matches: GrepHit[] = []
  if (!query) return matches
  const qLower = query.toLowerCase()
  let entries: Array<{ name: string; isFile: () => boolean }>
  try {
    entries = await readdir(wikiDir, { withFileTypes: true })
  } catch {
    return matches
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    let content: string
    try {
      content = await readFile(path.join(wikiDir, e.name), 'utf-8')
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i] ?? ''
      if (ln.toLowerCase().includes(qLower)) {
        matches.push({ file: e.name, line_no: i + 1, line: ln })
        if (matches.length >= limit) return matches
      }
    }
  }
  return matches
}

// ---------------------------------------------------------------------------
// Concurrency limiter for embed+search on the hot path
// ---------------------------------------------------------------------------

/**
 * Tiny semaphore: cap concurrent vector queries to avoid burst-loading the
 * embedder ONNX session. Defaults to 2 — onnxruntime-node is single-session
 * and benefits more from low contention than from higher fan-out.
 */
export function createQuerySemaphore(cap = 2): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = (): Promise<void> => {
    if (active < cap) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active++
        resolve()
      })
    })
  }
  const release = (): void => {
    active--
    const next = waiters.shift()
    if (next) next()
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

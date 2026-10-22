import { ensureEmbedder, type Embedder } from './embedder.js'
import { loadIndex, rrfFuse, runWikiGrep, vectorSearch, type FusedHit } from './query.js'

export interface HybridSearchOptions {
  /** Enable the semantic arm; when false only grep runs (mirrors server wikiIndex.enabled). */
  vectorEnabled: boolean
  modelId: string
  cacheDir: string
  mirror?: string
  topKVector: number
  maxMatches: number
}

export interface HybridMatch {
  file: string
  line_no: number
  line: string
}

/**
 * Hybrid (grep + optional vector) retrieval over one built wiki directory.
 * Mirrors the /api/v1/agent/wikis/:id/search orchestration: grep always on,
 * vector arm best-effort and silently degraded to grep-only on any failure.
 */
export async function hybridSearchWiki(
  wikiStoragePath: string,
  query: string,
  embedder: Embedder | null,
  options: Pick<HybridSearchOptions, 'vectorEnabled' | 'topKVector' | 'maxMatches'>,
): Promise<HybridMatch[]> {
  const grepHits = await runWikiGrep(wikiStoragePath, query)
  let fused: FusedHit[] | typeof grepHits
  if (options.vectorEnabled && embedder) {
    const idx = await loadIndex(wikiStoragePath)
    if (idx) {
      try {
        const qVec = await embedder.query(query)
        const vecHits = vectorSearch(idx, qVec, options.topKVector)
        fused = vecHits.length === 0 ? grepHits.slice(0, options.maxMatches) : rrfFuse(grepHits, vecHits)
      } catch {
        fused = grepHits.slice(0, options.maxMatches)
      }
    } else {
      fused = grepHits.slice(0, options.maxMatches)
    }
  } else {
    fused = grepHits.slice(0, options.maxMatches)
  }
  return (fused as Array<{ file: string; line_no: number; line: string }>).slice(0, options.maxMatches)
}

/** Lazily create the shared embedder; null when the model is unavailable (grep-only). */
export async function createHybridEmbedder(
  options: Pick<HybridSearchOptions, 'vectorEnabled' | 'modelId' | 'cacheDir' | 'mirror'>,
): Promise<Embedder | null> {
  if (!options.vectorEnabled) return null
  try {
    return await ensureEmbedder({ modelId: options.modelId, cacheDir: options.cacheDir, mirror: options.mirror })
  } catch {
    return null
  }
}

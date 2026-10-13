import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DbDriver, SqlRow } from '../db/driver.js'
import type { DocumentStore } from '../documentStore.js'
import { loadIndex, rrfFuse, runWikiGrep, vectorSearch } from '../wikiIndex/query.js'
import type { VecHit } from '../wikiIndex/query.js'
import { ParkApiError } from './parkAuthorization.js'

/**
 * policy.search over the park wiki corpus (plan 2.4). Search scope = the
 * consulting assistant's enabledWikis — NOT auth.orgId (the enterprise org
 * does not own the park wiki; filtering by caller org would return nothing).
 * Hybrid retrieval mirrors the /api/v1/agent/wikis/:id/search endpoint: grep
 * always on, vector arm optional (degrades silently to grep-only).
 */

export type PolicySearchMatch = {
  file: string
  line_no: number
  line: string
  wiki_id: string
}

export type PolicySearchOptions = {
  vector?: { modelId: string; cacheDir: string; mirror?: string } | null
}

export class PolicySearchService {
  constructor(
    private readonly driver: DbDriver,
    private readonly documentStore: DocumentStore,
  ) {}

  /** Enabled wiki ids from the assistant's tenant_assistants row. */
  async enabledWikiIds(parkOrgId: string, assistantId: string): Promise<string[]> {
    const row = await this.driver.get<SqlRow>(
      `SELECT enabled_wikis FROM tenant_assistants WHERE id = ? AND org_id = ?`,
      [assistantId, parkOrgId],
    )
    const raw = row?.enabled_wikis
    if (typeof raw !== 'string' || raw.trim() === '') return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return []
    }
  }

  async search(input: {
    parkOrgId: string
    assistantId: string
    query: string
  }, options: PolicySearchOptions = {}): Promise<PolicySearchMatch[]> {
    const q = input.query.trim()
    if (!q) {
      throw new ParkApiError(400, 'q_required', 'q is required')
    }
    const wikiIds = await this.enabledWikiIds(input.parkOrgId, input.assistantId)
    if (wikiIds.length === 0) return []

    const out: PolicySearchMatch[] = []
    for (const wikiId of wikiIds) {
      // Park-org scope: the wiki belongs to the park organization.
      const wiki = await this.documentStore.getWiki(wikiId, input.parkOrgId)
      if (!wiki) continue
      let matches: Array<{ file: string; line_no: number; line: string }>
      try {
        const grepHits = await runWikiGrep(wiki.storagePath, q)
        let vecHits: VecHit[] = []
        if (options.vector) {
          const idx = await loadIndex(wiki.storagePath)
          if (idx) {
            const { ensureEmbedder } = await import('../wikiIndex/embedder.js')
            const emb = await ensureEmbedder({
              modelId: options.vector.modelId,
              cacheDir: options.vector.cacheDir,
              mirror: options.vector.mirror,
            })
            if (emb) {
              const qVec = await emb.query(q)
              vecHits = vectorSearch(idx, qVec, 20)
            }
          }
        }
        const fused = vecHits.length === 0
          ? grepHits.slice(0, 100)
          : rrfFuse(grepHits, vecHits).slice(0, 100)
        matches = fused.map(h => ({ file: h.file, line_no: h.line_no, line: h.line }))
      } catch {
        matches = []
      }
      for (const m of matches) out.push({ ...m, wiki_id: wikiId })
      if (out.length >= 100) break
    }
    return out.slice(0, 100)
  }

  /** Policy document list for the enterprise side (file names per park wiki). */
  async listPolicyFiles(parkOrgId: string): Promise<Array<{ wiki_id: string; wiki_name: string; files: string[] }>> {
    const wikis = await this.documentStore.listWikis(parkOrgId)
    const out: Array<{ wiki_id: string; wiki_name: string; files: string[] }> = []
    for (const wiki of wikis) {
      let files: string[] = []
      try {
        const entries = await readdir(wiki.storagePath)
        files = entries.filter(name => name.endsWith('.md')).sort()
      } catch {
        files = []
      }
      out.push({ wiki_id: wiki.id, wiki_name: wiki.name, files })
    }
    return out
  }
}

/**
 * Hybrid search over an agent's history: keyword (SQLite FTS5 trigram, which
 * needs no Chinese word segmenter) + vector (the multilingual-e5-small model
 * moss already ships for wiki search), fused with reciprocal rank fusion and
 * weighted towards recent work.
 *
 * Nexus also has a search plugin, but its released build does not load on
 * nexusd 0.8.x and its keyword lane is English-only, so moss indexes the
 * agent-home documents itself. The documents stay in the agent home; this
 * index can be rebuilt from them at any time.
 */
import { splitMarkdown } from '../wikiIndex/chunkSplitter.js'
import type { Embedder } from '../wikiIndex/embedder.js'
import type { AgentifyStore, DocInput, DocKind, DocRow } from './store.js'
import { historyPolicy, type HistoryShare } from './config.js'

export type EmbedderProvider = () => Promise<Embedder | null>

export interface SearchHit {
  docId: string
  kind: DocKind
  title: string
  path: string
  sessionId: string | null
  userId: string | null
  createdAt: number
  /** Last activity of what the document describes. */
  activeAt: number
  score: number
  snippet: string
}

export interface SearchOptions {
  orgId: string
  agentId: string
  query: string
  /** The employee the search is for; null when another agent is reading. */
  viewerUserId: string | null
  share: HistoryShare
  kinds?: DocKind[]
  limit?: number
  /** Total characters of snippets returned. */
  maxChars?: number
  /** Only documents created at or after this time. */
  sinceMs?: number
  /** Administrators: skip the per-viewer visibility rules. */
  includeAll?: boolean
  /** Recency half-life; defaults to the agent's configured policy. 0 = no decay. */
  decayHalfLifeHours?: number
}

/**
 * Weight for how recent a document is: 1 when just active, falling to 0.7 as
 * it ages (half way there after one half-life). Old work still ranks by
 * relevance; recency only breaks near-ties.
 */
export function recencyWeight(ageMs: number, halfLifeHours: number): number {
  if (halfLifeHours <= 0) return 1
  const recency = Math.pow(0.5, Math.max(0, ageMs) / (halfLifeHours * 3_600_000))
  return 0.7 + 0.3 * recency
}

const CJK = /[㐀-鿿豈-﫿]/
const RRF_K = 60
const EXACT_BONUS = 1.6

/** Query words to look for verbatim (whitespace-separated, at least 2 characters). */
export function exactWords(query: string): string[] {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s,，。;；、]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2)
    .slice(0, 8)
}

/** Can this viewer see this document? */
export function canSeeDoc(doc: Pick<DocRow, 'visibility' | 'userId' | 'kind'>, viewerUserId: string | null, share: HistoryShare): boolean {
  if (doc.visibility === 'shared') return true
  if (viewerUserId && doc.userId === viewerUserId) return true
  if (share !== 'full') return false
  // `full` sharing opens other employees' conversations and input files, never
  // their private memory. Other agents (no viewer) get input files, not
  // conversations.
  if (doc.kind === 'input') return true
  return doc.kind === 'conversation' && viewerUserId !== null
}

/**
 * Split a natural-language query into FTS terms. Chinese runs have no spaces,
 * so each run becomes its overlapping trigrams (OR-ed, bm25 rewards chunks
 * that share more of them). Words of 3+ characters are matched as phrases.
 * Anything shorter is returned separately for substring matching.
 */
export function buildQueryTerms(query: string): { fts: string; short: string[] } {
  const tokens = query
    .normalize('NFKC')
    .split(/[\s,，。.!！?？;；:：、()（）[\]【】"'“”‘’<>《》]+/)
    .map(t => t.trim())
    .filter(Boolean)
  const phrases = new Set<string>()
  const short = new Set<string>()
  for (const token of tokens) {
    // Split mixed tokens into CJK and non-CJK runs.
    const runs = token.match(/[㐀-鿿豈-﫿]+|[^㐀-鿿豈-﫿]+/g) ?? []
    for (const run of runs) {
      if (CJK.test(run)) {
        if (run.length < 3) short.add(run)
        else if (run.length <= 4) phrases.add(run)
        else for (let i = 0; i + 3 <= run.length; i++) phrases.add(run.slice(i, i + 3))
      } else {
        const word = run.replace(/[^\p{L}\p{N}_\-./]+/gu, '')
        if (word.length >= 3) phrases.add(word)
        else if (word.length > 0) short.add(word)
      }
    }
  }
  const list = [...phrases].slice(0, 48)
  const fts = list.map(p => `"${p.replace(/"/g, '""')}"`).join(' OR ')
  return { fts, short: [...short].slice(0, 8) }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot // both vectors are L2-normalized by the embedder
}

export function chunkDocument(text: string, title: string): string[] {
  const passages = splitMarkdown(text, title, { maxChars: 500, maxPassages: 400 })
  const chunks = passages
    .map(p => (p.title && p.title !== title ? `${p.title}\n${p.text}` : p.text).trim())
    .filter(t => t.length > 0)
  return chunks.length > 0 ? chunks : text.trim() ? [text.trim().slice(0, 2000)] : []
}

export class HistoryIndex {
  constructor(private readonly store: AgentifyStore, private readonly embedder: EmbedderProvider) {}

  /**
   * Index (or re-index) one document. Returns the stored row. `chunks`
   * replaces the default splitting (extracted files come pre-chunked); chunks
   * with `embed: false` are keyword-searchable only.
   */
  async indexDoc(input: DocInput & { chunks?: Array<{ text: string; embed: boolean }> }): Promise<DocRow> {
    const specs = input.chunks ?? chunkDocument(input.text, input.title).map(text => ({ text, embed: true }))
    const texts = specs.map(c => c.text)
    const vectors: Array<Float32Array | null> = texts.map(() => null)
    const emb = await this.embedder().catch(() => null)
    const toEmbed = specs.map((c, i) => (c.embed ? i : -1)).filter(i => i >= 0)
    if (emb && toEmbed.length > 0) {
      try {
        const out = await emb.passage(toEmbed.map(i => `${input.title}\n${texts[i]}`))
        toEmbed.forEach((i, k) => {
          vectors[i] = out[k] ?? null
        })
      } catch (err) {
        console.warn(`[agentify] embedding failed, indexing keywords only: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return this.store.replaceDoc(input, texts.map((text, i) => ({ text, embedding: vectors[i] ?? null })))
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50)
    const maxChars = opts.maxChars ?? 6000
    const query = opts.query.trim()
    const rankLists: number[][] = []

    if (query) {
      const { fts, short } = buildQueryTerms(query)
      const kw = this.store.keywordCandidates(opts.orgId, opts.agentId, fts, 200)
      if (kw.length > 0) rankLists.push(kw.map(k => k.chunkId))
      const sub = this.store.substringCandidates(opts.orgId, opts.agentId, short, 100)
      if (sub.length > 0) rankLists.push(sub.map(k => k.chunkId))

      const emb = await this.embedder().catch(() => null)
      if (emb) {
        try {
          const q = await emb.query(query)
          const scored = this.store
            .vectorRows(opts.orgId, opts.agentId)
            .map(r => ({ id: r.chunkId, s: cosine(q, r.embedding) }))
            .filter(r => r.s > 0.2)
            .sort((a, b) => b.s - a.s)
            .slice(0, 100)
          if (scored.length > 0) rankLists.push(scored.map(r => r.id))
        } catch (err) {
          console.warn(`[agentify] vector search failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    const fused = new Map<number, number>()
    for (const list of rankLists) {
      list.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
    }

    let candidates: Array<{ chunkId: number; base: number }>
    if (query) {
      candidates = [...fused.entries()].map(([chunkId, base]) => ({ chunkId, base }))
    } else {
      // Empty query: most recent documents, one chunk each.
      const docs = this.store.listDocs({ orgId: opts.orgId, agentId: opts.agentId, kinds: opts.kinds, limit: limit * 4 })
      return this.recentHits(docs, opts, limit, maxChars)
    }

    const rows = this.store.getChunksWithDocs(candidates.map(c => c.chunkId))
    const byId = new Map(rows.map(r => [r.id, r]))
    const now = Date.now()
    const halfLife = opts.decayHalfLifeHours ?? historyPolicy(this.store.getAgent(opts.orgId, opts.agentId)?.config).decayHalfLifeHours
    const words = exactWords(query)
    const bestPerDoc = new Map<string, SearchHit>()
    for (const c of candidates) {
      const row = byId.get(c.chunkId)
      if (!row) continue
      const doc = row.doc
      if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes(doc.kind)) continue
      if (opts.sinceMs && doc.createdAt < opts.sinceMs) continue
      if (!opts.includeAll && !canSeeDoc(doc, opts.viewerUserId, opts.share)) continue
      const kindBoost = doc.kind === 'summary' || doc.kind === 'memory' ? 1.15 : 1
      // Every word of the query appears verbatim (an id, an order number, a
      // name): that passage beats one that is only similar in meaning.
      const lower = row.text.toLowerCase()
      const exact = words.length > 0 && words.every(w => lower.includes(w)) ? EXACT_BONUS : 1
      const score = c.base * recencyWeight(now - doc.activeAt, halfLife) * kindBoost * exact
      const prev = bestPerDoc.get(doc.id)
      if (!prev || prev.score < score) {
        bestPerDoc.set(doc.id, {
          docId: doc.id,
          kind: doc.kind,
          title: doc.title,
          path: doc.path,
          sessionId: doc.sessionId,
          userId: doc.userId,
          createdAt: doc.createdAt,
          activeAt: doc.activeAt,
          score,
          snippet: row.text,
        })
      }
    }
    const hits = [...bestPerDoc.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    return capSnippets(hits, maxChars)
  }

  private recentHits(docs: DocRow[], opts: SearchOptions, limit: number, maxChars: number): SearchHit[] {
    const visible = docs.filter(d => (opts.includeAll || canSeeDoc(d, opts.viewerUserId, opts.share)) && (!opts.sinceMs || d.createdAt >= opts.sinceMs))
    const hits: SearchHit[] = []
    for (const doc of visible.slice(0, limit)) {
      const chunk = this.store.firstChunk(doc.id)
      hits.push({
        docId: doc.id,
        kind: doc.kind,
        title: doc.title,
        path: doc.path,
        sessionId: doc.sessionId,
        userId: doc.userId,
        createdAt: doc.createdAt,
        activeAt: doc.activeAt,
        score: 0,
        snippet: chunk ?? '',
      })
    }
    return capSnippets(hits, maxChars)
  }
}

function capSnippets(hits: SearchHit[], maxChars: number): SearchHit[] {
  let budget = maxChars
  const out: SearchHit[] = []
  for (const h of hits) {
    if (budget <= 0) break
    const snippet = h.snippet.length > budget ? `${h.snippet.slice(0, Math.max(0, budget - 1))}…` : h.snippet
    budget -= snippet.length
    out.push({ ...h, snippet })
  }
  return out
}

import { mkdir, rm, writeFile } from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type { DirectConnectStore } from './db.js'
import {
  MOSS_DOCS_DIR,
  MOSS_WIKIS_DIR,
  getDocumentDir,
  getDocumentStoragePath,
  getWikiDir,
} from '../utils/wikis/localWikiDirectories.js'

// ============================================================
// Public types — kept independent from SQL row shape so that
// server.ts/admin can use them without knowing about node:sqlite.
// ============================================================

export type DocumentTreeNode = {
  id: string
  orgId: string
  parentId: string | null
  name: string
  description: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
  // Document Center v2: source-managed metadata.
  sourceId: string | null
  sourcePath: string | null
  autoManaged: boolean
  alias: string | null
  lastSyncedAt: number | null
}

export type DocumentRecord = {
  id: string
  orgId: string
  nodeId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  uploadedBy: string
  uploadedAt: number
}

export type WikiRecord = {
  id: string
  orgId: string
  nodeId: string | null
  name: string
  description: string | null
  storagePath: string
  buildStatus: 'pending' | 'running' | 'succeeded' | 'failed'
  sourceDocumentIds: string[]
  lastBuiltAt: number | null
  lastBuildError: string | null
  createdBy: string
  createdAt: number
  updatedAt: number
  // Document Center v2: set by SourceSyncWorker when a source doc changes.
  needsRebuild: boolean
}

export type WikiBuildJob = {
  id: string
  wikiId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  currentStep: string | null
  errorMessage: string | null
  sessionId: string | null
  triggeredBy: string
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type WikiBuildJobListItem = WikiBuildJob & {
  wikiName: string
  wikiNodeId: string | null
  wikiBuildStatus: WikiRecord['buildStatus']
  wikiNeedsRebuild: boolean
}

type SqlRow = Record<string, unknown>

// ============================================================
// Row mappers
// ============================================================

function mapTreeNode(row: SqlRow): DocumentTreeNode {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    parentId: typeof row.parent_id === 'string' ? row.parent_id : null,
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    sourceId: typeof row.source_id === 'string' ? row.source_id : null,
    sourcePath: typeof row.source_path === 'string' ? row.source_path : null,
    autoManaged: Number(row.auto_managed ?? 0) === 1,
    alias: typeof row.alias === 'string' ? row.alias : null,
    lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
  }
}

function mapDocument(row: SqlRow): DocumentRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    nodeId: String(row.node_id),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    storagePath: String(row.storage_path),
    uploadedBy: String(row.uploaded_by),
    uploadedAt: Number(row.uploaded_at),
  }
}

function parseDocIds(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : []
  } catch {
    return []
  }
}

function mapWiki(row: SqlRow): WikiRecord {
  const status = String(row.build_status)
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    nodeId: typeof row.node_id === 'string' ? row.node_id : null,
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
    storagePath: String(row.storage_path),
    buildStatus: (['pending', 'running', 'succeeded', 'failed'].includes(status)
      ? status
      : 'pending') as WikiRecord['buildStatus'],
    sourceDocumentIds: parseDocIds(row.source_document_ids),
    lastBuiltAt: row.last_built_at == null ? null : Number(row.last_built_at),
    lastBuildError: typeof row.last_build_error === 'string' ? row.last_build_error : null,
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    needsRebuild: Number(row.needs_rebuild ?? 0) === 1,
  }
}

function mapBuildJob(row: SqlRow): WikiBuildJob {
  const status = String(row.status)
  return {
    id: String(row.id),
    wikiId: String(row.wiki_id),
    status: (['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status)
      ? status
      : 'queued') as WikiBuildJob['status'],
    progress: Number(row.progress ?? 0),
    currentStep: typeof row.current_step === 'string' ? row.current_step : null,
    errorMessage: typeof row.error_message === 'string' ? row.error_message : null,
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    triggeredBy: String(row.triggered_by),
    queuedAt: Number(row.queued_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  }
}

function mapBuildJobListItem(row: SqlRow): WikiBuildJobListItem {
  const job = mapBuildJob(row)
  const wikiStatus = String(row.wiki_build_status)
  return {
    ...job,
    wikiName: String(row.wiki_name ?? ''),
    wikiNodeId: typeof row.wiki_node_id === 'string' ? row.wiki_node_id : null,
    wikiBuildStatus: (['pending', 'running', 'succeeded', 'failed'].includes(wikiStatus)
      ? wikiStatus
      : 'pending') as WikiRecord['buildStatus'],
    wikiNeedsRebuild: Number(row.wiki_needs_rebuild ?? 0) === 1,
  }
}

// ============================================================
// DocumentStore — high-level API used by server.ts
// ============================================================

export class DocumentStore {
  constructor(private store: DirectConnectStore) {}

  // ---------- Tree ----------

  listTree(orgId: string): DocumentTreeNode[] {
    return this.store.listDocumentTreeNodes(orgId).map(mapTreeNode)
  }

  getNode(id: string, orgId: string): DocumentTreeNode | null {
    const row = this.store.getDocumentTreeNode(id, orgId)
    return row ? mapTreeNode(row) : null
  }

  createNode(input: {
    orgId: string
    parentId: string | null
    name: string
    description?: string
    sortOrder?: number
  }): DocumentTreeNode {
    if (input.parentId) {
      const parent = this.getNode(input.parentId, input.orgId)
      if (!parent) {
        throw new Error(`parent node not found: ${input.parentId}`)
      }
    }
    const id = randomUUID()
    this.store.createDocumentTreeNode({
      id,
      org_id: input.orgId,
      parent_id: input.parentId,
      name: input.name,
      description: input.description ?? null,
      sort_order: input.sortOrder ?? 0,
    })
    return this.getNode(id, input.orgId)!
  }

  updateNode(id: string, orgId: string, updates: {
    parentId?: string | null
    name?: string
    description?: string | null
    sortOrder?: number
  }): DocumentTreeNode {
    // Move guard: do not allow moving under a descendant (cycle).
    if (updates.parentId !== undefined && updates.parentId !== null) {
      if (updates.parentId === id) {
        throw new Error('cannot set node as its own parent')
      }
      if (this.isDescendant(updates.parentId, id, orgId)) {
        throw new Error('cannot move node under its own descendant')
      }
    }
    this.store.updateDocumentTreeNode(id, orgId, {
      parent_id: updates.parentId,
      name: updates.name,
      description: updates.description,
      sort_order: updates.sortOrder,
    })
    const updated = this.getNode(id, orgId)
    if (!updated) throw new Error(`node ${id} disappeared after update`)
    return updated
  }

  /**
   * Delete a node. ON DELETE CASCADE in DB removes child nodes + documents.
   * We also remove the on-disk files for all those documents.
   */
  async deleteNode(id: string, orgId: string): Promise<void> {
    const descendantIds = this.collectDescendantNodeIds(id, orgId)
    descendantIds.add(id)
    // Gather all document storage paths before cascade deletes them
    const docPaths: string[] = []
    for (const nid of descendantIds) {
      for (const doc of this.listDocumentsForNode(nid, orgId)) {
        docPaths.push(doc.storagePath)
      }
    }
    this.store.deleteDocumentTreeNode(id, orgId)
    // Clean up on-disk files (best effort)
    for (const p of docPaths) {
      try {
        const dir = path.dirname(p)
        if (dir.startsWith(MOSS_DOCS_DIR)) {
          await rm(dir, { recursive: true, force: true })
        }
      } catch {
        // ignore individual cleanup failures
      }
    }
  }

  /** True if `candidate` is a descendant of `root` (inclusive root → false). */
  private isDescendant(candidate: string, root: string, orgId: string): boolean {
    const all = this.listTree(orgId)
    const byId = new Map(all.map(n => [n.id, n]))
    let cur: DocumentTreeNode | undefined = byId.get(candidate)
    while (cur) {
      if (cur.parentId === root) return true
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return false
  }

  private collectDescendantNodeIds(rootId: string, orgId: string): Set<string> {
    const all = this.listTree(orgId)
    const childrenByParent = new Map<string, DocumentTreeNode[]>()
    for (const n of all) {
      if (n.parentId) {
        if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, [])
        childrenByParent.get(n.parentId)!.push(n)
      }
    }
    const out = new Set<string>()
    const walk = (id: string) => {
      const kids = childrenByParent.get(id) ?? []
      for (const k of kids) {
        if (!out.has(k.id)) {
          out.add(k.id)
          walk(k.id)
        }
      }
    }
    walk(rootId)
    return out
  }

  // ---------- Documents ----------

  listDocumentsForNode(nodeId: string, orgId: string): DocumentRecord[] {
    return this.store.listDocumentsByNode(nodeId, orgId).map(mapDocument)
  }

  getDocument(id: string, orgId: string): DocumentRecord | null {
    const row = this.store.getDocument(id, orgId)
    return row ? mapDocument(row) : null
  }

  /**
   * Upload a document. Caller passes the raw bytes; this writes them to disk
   * at `$MOSS_HOME/docs/<docId>/<fileName>` and creates a DB record.
   */
  async uploadDocument(input: {
    orgId: string
    nodeId: string
    fileName: string
    mimeType: string
    content: Buffer
    uploadedBy: string
  }): Promise<DocumentRecord> {
    // Validate node exists
    const node = this.getNode(input.nodeId, input.orgId)
    if (!node) {
      throw new Error(`node not found: ${input.nodeId}`)
    }

    const id = randomUUID()
    const safeName = sanitizeFileName(input.fileName)
    const storagePath = getDocumentStoragePath(id, safeName)

    await mkdir(getDocumentDir(id), { recursive: true })
    await writeFile(storagePath, input.content)

    this.store.createDocument({
      id,
      org_id: input.orgId,
      node_id: input.nodeId,
      file_name: safeName,
      mime_type: input.mimeType,
      size_bytes: input.content.byteLength,
      storage_path: storagePath,
      uploaded_by: input.uploadedBy,
    })

    return this.getDocument(id, input.orgId)!
  }

  async deleteDocument(id: string, orgId: string): Promise<void> {
    const doc = this.getDocument(id, orgId)
    if (!doc) return
    this.store.deleteDocument(id, orgId)
    // Best-effort on-disk cleanup
    try {
      const dir = path.dirname(doc.storagePath)
      if (dir.startsWith(MOSS_DOCS_DIR)) {
        await rm(dir, { recursive: true, force: true })
      }
    } catch {
      // ignore
    }
  }

  // ---------- Wikis ----------

  listWikis(orgId: string, filter?: { nodeId?: string; buildStatus?: WikiRecord['buildStatus'] }): WikiRecord[] {
    return this.store.listWikis(orgId, filter).map(mapWiki)
  }

  getWiki(id: string, orgId: string): WikiRecord | null {
    const row = this.store.getWiki(id, orgId)
    return row ? mapWiki(row) : null
  }

  /** Cross-org getter for runtime / build worker. Caller is responsible for auth. */
  getWikiById(id: string): WikiRecord | null {
    const row = this.store.getWikiById(id)
    return row ? mapWiki(row) : null
  }

  async createWiki(input: {
    orgId: string
    nodeId?: string | null
    name: string
    description?: string
    sourceDocumentIds: string[]
    createdBy: string
  }): Promise<WikiRecord> {
    if (input.nodeId) {
      const node = this.getNode(input.nodeId, input.orgId)
      if (!node) {
        throw new Error(`node not found: ${input.nodeId}`)
      }
    }
    const id = randomUUID()
    const storagePath = getWikiDir(id)
    await mkdir(storagePath, { recursive: true })

    this.store.createWiki({
      id,
      org_id: input.orgId,
      node_id: input.nodeId ?? null,
      name: input.name,
      description: input.description ?? null,
      storage_path: storagePath,
      source_document_ids: input.sourceDocumentIds,
      created_by: input.createdBy,
    })

    return this.getWiki(id, input.orgId)!
  }

  updateWiki(id: string, orgId: string, updates: {
    name?: string
    description?: string | null
    nodeId?: string | null
    sourceDocumentIds?: string[]
  }): WikiRecord {
    this.store.updateWiki(id, orgId, {
      name: updates.name,
      description: updates.description,
      node_id: updates.nodeId,
      source_document_ids: updates.sourceDocumentIds,
    })
    const wiki = this.getWiki(id, orgId)
    if (!wiki) throw new Error(`wiki ${id} disappeared after update`)
    return wiki
  }

  async deleteWiki(id: string, orgId: string): Promise<void> {
    const wiki = this.getWiki(id, orgId)
    if (!wiki) return
    this.store.deleteWiki(id, orgId)
    try {
      if (wiki.storagePath.startsWith(MOSS_WIKIS_DIR)) {
        await rm(wiki.storagePath, { recursive: true, force: true })
      }
    } catch {
      // ignore
    }
  }

  setWikiBuildResult(id: string, result: {
    status: WikiRecord['buildStatus']
    lastBuiltAt?: number
    lastBuildError?: string | null
  }): void {
    this.store.updateWikiBuildResult(id, {
      build_status: result.status,
      last_built_at: result.lastBuiltAt,
      last_build_error: result.lastBuildError,
    })
  }

  // ---------- Build Jobs ----------

  listBuildJobs(wikiId: string, limit?: number): WikiBuildJob[] {
    return this.store.listWikiBuildJobs(wikiId, limit).map(mapBuildJob)
  }

  listBuildJobsForOrg(orgId: string, filter?: {
    status?: WikiBuildJob['status']
    wikiId?: string
    limit?: number
    offset?: number
  }): { items: WikiBuildJobListItem[]; total: number } {
    const result = this.store.listWikiBuildJobsForOrg(orgId, filter)
    return {
      items: result.items.map(mapBuildJobListItem),
      total: result.total,
    }
  }

  getBuildJobForOrg(id: string, orgId: string): WikiBuildJobListItem | null {
    const row = this.store.getWikiBuildJobForOrg(id, orgId)
    return row ? mapBuildJobListItem(row) : null
  }

  getBuildJob(id: string): WikiBuildJob | null {
    const row = this.store.getWikiBuildJob(id)
    return row ? mapBuildJob(row) : null
  }

  getLatestBuildJob(wikiId: string): WikiBuildJob | null {
    const row = this.store.getLatestWikiBuildJob(wikiId)
    return row ? mapBuildJob(row) : null
  }

  countActiveBuildJobs(): number {
    return this.store.countRunningWikiBuildJobs()
  }

  listQueuedBuildJobs(limit?: number): WikiBuildJob[] {
    return this.store.listQueuedWikiBuildJobs(limit).map(mapBuildJob)
  }

  createBuildJob(input: { wikiId: string; triggeredBy: string }): WikiBuildJob {
    const id = randomUUID()
    this.store.createWikiBuildJob({
      id,
      wiki_id: input.wikiId,
      triggered_by: input.triggeredBy,
    })
    const job = this.getBuildJob(id)
    if (!job) throw new Error(`build job ${id} not found after create`)
    return job
  }

  updateBuildJob(id: string, updates: Partial<{
    status: WikiBuildJob['status']
    progress: number
    currentStep: string | null
    errorMessage: string | null
    sessionId: string | null
    startedAt: number
    finishedAt: number
  }>): void {
    this.store.updateWikiBuildJob(id, {
      status: updates.status,
      progress: updates.progress,
      current_step: updates.currentStep,
      error_message: updates.errorMessage,
      session_id: updates.sessionId,
      started_at: updates.startedAt,
      finished_at: updates.finishedAt,
    })
  }
}

// ============================================================
// Helpers
// ============================================================

function sanitizeFileName(name: string): string {
  // Strip path separators and control chars; keep dots / unicode letters.
  return name.replace(/[/\\\x00-\x1f]/g, '_').slice(0, 200) || 'document'
}

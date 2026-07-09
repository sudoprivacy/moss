/**
 * Document Center v2 — Source Sync Worker.
 *
 * Polls every enabled `external_sources` row at its configured
 * `sync_interval_sec`, walks the connector's tree, and diffs the result
 * against the local `document_tree_nodes` + `documents` mirror.
 *
 * For each external file:
 *   - new           → download bytes, compute sha256, insert document
 *   - etag changed  → re-download, update bytes/sha256, mark referencing
 *                     wikis as needs_rebuild if content_sha256 actually changed
 *   - missing       → soft-delete (deleted_at = now). A daily purge cron
 *                     hard-deletes rows older than 30d.
 *
 * For each external folder: same diff logic, with rename/move detection.
 *
 * The worker also exposes `syncSourceNow(sourceId)` so the AdminHub
 * "Sync now" button can force an immediate sync without waiting for the
 * next tick.
 *
 * Concurrency model:
 *   - Tick every TICK_INTERVAL_MS scans enabled sources
 *   - A source is only synced if it's not already running and the
 *     elapsed time since last_sync_at >= sync_interval_sec
 *   - Per-source mutex prevents overlap with manual triggers
 */

import { createHash, randomUUID } from 'crypto'
import { mkdir, rm, writeFile } from 'fs/promises'
import type { DirectConnectStore } from '../db.js'
import type { DocumentStore } from '../documentStore.js'
import { getDocumentDir, getDocumentStoragePath } from '../../utils/wikis/localWikiDirectories.js'
import { createConnector } from './types.js'
import type { ExternalFileNode, ExternalSourceConfig, ExternalSourceCredentials } from './types.js'

const TICK_INTERVAL_MS = 30_000
const SOFT_DELETE_RETENTION_MS = 30 * 24 * 60 * 60_000
const DAILY_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000

type ExternalSourceRow = {
  id: string
  org_id: string
  type: string
  name: string
  config_json: string
  credentials_secret_key: string | null
  sync_interval_sec: number
  auto_build_enabled: number
  enabled: number
  last_sync_at: number | null
  last_sync_status: string | null
  last_sync_error: string | null
  created_by: string
}

type SyncRunStats = {
  foldersCreated: number
  foldersUpdated: number
  foldersDeleted: number
  filesCreated: number
  filesUpdated: number
  filesDeleted: number
  filesSkipped: number
  wikisMarked: number
  errors: number
}

function emptyStats(): SyncRunStats {
  return {
    foldersCreated: 0,
    foldersUpdated: 0,
    foldersDeleted: 0,
    filesCreated: 0,
    filesUpdated: 0,
    filesDeleted: 0,
    filesSkipped: 0,
    wikisMarked: 0,
    errors: 0,
  }
}

function sanitizeFileName(name: string): string {
  // Same rule as DocumentStore.uploadDocument — strip dir separators.
  return name.replace(/[\\/]/g, '_').replace(/^\.+/, '') || 'file'
}

function rowToSource(row: Record<string, unknown>): ExternalSourceRow {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    type: String(row.type),
    name: String(row.name),
    config_json: String(row.config_json),
    credentials_secret_key:
      typeof row.credentials_secret_key === 'string' ? row.credentials_secret_key : null,
    sync_interval_sec: Number(row.sync_interval_sec ?? 3600),
    auto_build_enabled: Number(row.auto_build_enabled ?? 0),
    enabled: Number(row.enabled ?? 0),
    last_sync_at: row.last_sync_at == null ? null : Number(row.last_sync_at),
    last_sync_status: typeof row.last_sync_status === 'string' ? row.last_sync_status : null,
    last_sync_error: typeof row.last_sync_error === 'string' ? row.last_sync_error : null,
    created_by: String(row.created_by),
  }
}

export class SourceSyncWorker {
  private timer: NodeJS.Timeout | null = null
  private cleanupTimer: NodeJS.Timeout | null = null
  private inflightCleanupTimer: NodeJS.Timeout | null = null
  private stopped = false
  /** Per-source mutex to prevent overlap with manual triggers. */
  private inflight = new Map<string, number>() // sourceId -> startTime
  /** Timeout for inflight syncs (30 minutes) */
  private static readonly INFLIGHT_TIMEOUT_MS = 30 * 60 * 1000

  constructor(
    private db: DirectConnectStore,
    private docStore: DocumentStore,
    /** Optional hook so the worker can enqueue build jobs after sync. */
    private onWikiNeedsRebuild?: (wikiId: string, orgId: string, sourceId: string) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.stopped = false

    const tick = () => {
      if (this.stopped) return
      this.tickOnce()
        .catch((err) => console.error('[SourceSyncWorker] tick error:', err))
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, TICK_INTERVAL_MS)
            this.timer.unref()
          }
        })
    }
    this.timer = setTimeout(tick, 1_000)
    this.timer.unref()

    const cleanupTick = () => {
      if (this.stopped) return
      try {
        const cutoff = Date.now() - SOFT_DELETE_RETENTION_MS
        const purged = this.db.purgeOldSoftDeletes(cutoff)
        if (purged.documents > 0 || purged.nodes > 0) {
          console.log(
            `[SourceSyncWorker] purged ${purged.documents} documents + ${purged.nodes} nodes older than 30d`,
          )
        }
      } catch (err) {
        console.error('[SourceSyncWorker] cleanup error:', err)
      } finally {
        if (!this.stopped) {
          this.cleanupTimer = setTimeout(cleanupTick, DAILY_CLEANUP_INTERVAL_MS)
          this.cleanupTimer.unref()
        }
      }
    }
    // First cleanup fires a minute after boot so it doesn't compete with startup work.
    this.cleanupTimer = setTimeout(cleanupTick, 60_000)
    this.cleanupTimer.unref()

    // Start inflight cleanup timer (every 5 minutes)
    this.inflightCleanupTimer = setInterval(() => {
      this.cleanupStaleInflight()
    }, 5 * 60 * 1000)
    this.inflightCleanupTimer.unref()

    console.log('[SourceSyncWorker] started')
  }

  private cleanupStaleInflight(): void {
    const now = Date.now()
    for (const [sourceId, startTime] of this.inflight) {
      if (now - startTime > SourceSyncWorker.INFLIGHT_TIMEOUT_MS) {
        this.inflight.delete(sourceId)
        console.warn(`[SourceSyncWorker] Cleaned up stale inflight sync for source ${sourceId}`)
      }
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer)
      this.cleanupTimer = null
    }
    if (this.inflightCleanupTimer) {
      clearInterval(this.inflightCleanupTimer)
      this.inflightCleanupTimer = null
    }
    console.log('[SourceSyncWorker] stopped')
  }

  /**
   * Force an immediate sync of one source, bypassing the interval check.
   * Used by the AdminHub "Sync now" button. Returns the stats.
   */
  async syncSourceNow(sourceId: string): Promise<SyncRunStats> {
    const row = this.db.getExternalSourceById(sourceId)
    if (!row) throw new Error(`external_source not found: ${sourceId}`)
    const source = rowToSource(row)
    if (source.enabled !== 1) {
      throw new Error(`external_source is disabled: ${sourceId}`)
    }
    return this.runSync(source)
  }

  /** Run one polling tick: pick all due sources and sync them sequentially. */
  private async tickOnce(): Promise<void> {
    const rows = this.db.listAllEnabledExternalSources()
    const now = Date.now()
    for (const r of rows) {
      const src = rowToSource(r)
      const due = src.last_sync_at == null
        ? true
        : (now - src.last_sync_at) >= src.sync_interval_sec * 1_000
      if (!due) continue
      if (this.inflight.has(src.id)) continue
      try {
        await this.runSync(src)
      } catch (err) {
        console.error(`[SourceSyncWorker] sync failed for ${src.name} (${src.id}):`, err)
      }
    }
  }

  // ============================================================
  // Source root node
  // ============================================================

  /**
   * Ensure the source's top-level, locked, source-named root node exists and
   * is named after the source. All synced content mounts under it. Returns the
   * root node's DB id.
   */
  private ensureSourceRootNode(source: ExternalSourceRow): string {
    const existing = this.db.findSourceRootNode(source.id) as Record<string, unknown> | null
    if (existing) {
      const id = String(existing.id)
      // Keep the root named after the source (rename-follow).
      if (existing.name !== source.name) {
        this.db.renameTreeNode(id, source.name)
      }
      return id
    }
    const id = randomUUID()
    this.db.createDocumentTreeNode({
      id,
      org_id: source.org_id,
      parent_id: null,
      name: source.name,
      source_id: source.id,
      source_path: '',
      auto_managed: 1,
      last_synced_at: Date.now(),
    })
    return id
  }

  // ============================================================
  // Per-source sync run
  // ============================================================

  private async runSync(source: ExternalSourceRow): Promise<SyncRunStats> {
    this.inflight.set(source.id, Date.now())
    const stats = emptyStats()

    this.db.updateExternalSourceSyncStatus(source.id, {
      last_sync_status: 'running',
      last_sync_error: null,
    })

    try {
      const config = this.parseConfig(source)
      const credentials = await this.loadCredentials(source)
      const connector = createConnector(source.type)
      await connector.init(config, credentials)

      // Track what we've seen so the reverse-sweep can find missing ones.
      const seenDocIds = new Set<string>()
      const seenNodeIds = new Set<string>()
      // Tree nodes touched this run (file/folder add/update/delete). Dir-mode
      // wikis tracking any of these (or an ancestor) are flagged once after the
      // walk + reverse-sweep, avoiding per-file rebuild storms.
      const dirtyNodeIds = new Set<string>()

      // externalId → tree-node DB id mapping, populated as we walk.
      // Used so children can look up their parent's DB id.
      const folderExternalIdToDbId = new Map<string, string>()
      // Every source gets its own auto-created, locked, source-named root node.
      // All synced content mounts under it (no separate mount node).
      const rootParentDbId = this.ensureSourceRootNode(source)
      seenNodeIds.add(rootParentDbId)

      for await (const node of connector.walkTree('')) {
        const parentDbId =
          node.parentExternalId == null
            ? rootParentDbId
            : (folderExternalIdToDbId.get(node.parentExternalId) ?? rootParentDbId)

        if (node.type === 'folder') {
          const dbId = await this.upsertFolder(source, node, parentDbId, stats)
          if (dbId) {
            folderExternalIdToDbId.set(node.externalId, dbId)
            seenNodeIds.add(dbId)
          }
        } else {
          const dbId = await this.upsertFile(source, node, parentDbId, connector, stats, dirtyNodeIds)
          if (dbId) seenDocIds.add(dbId)
        }
      }

      // Reverse sweep: soft-delete anything for this source not seen this run.
      this.reverseSweep(source, seenNodeIds, seenDocIds, stats, dirtyNodeIds)

      // Flush dir-mode wiki rebuilds once for all nodes touched this run.
      this.flushDirtyWikis(source, dirtyNodeIds, stats)

      this.db.updateExternalSourceSyncStatus(source.id, {
        last_sync_at: Date.now(),
        last_sync_status: 'success',
        last_sync_error: null,
      })
      console.log(
        `[SourceSyncWorker] ${source.name} (${source.type}) synced: ` +
          `+${stats.filesCreated}/${stats.filesUpdated}/${stats.filesDeleted} files, ` +
          `+${stats.foldersCreated}/${stats.foldersUpdated}/${stats.foldersDeleted} folders, ` +
          `${stats.wikisMarked} wiki(s) marked rebuild`,
      )
    } catch (err) {
      stats.errors++
      const msg = err instanceof Error ? err.message : String(err)
      this.db.updateExternalSourceSyncStatus(source.id, {
        last_sync_at: Date.now(),
        last_sync_status: 'failed',
        last_sync_error: msg,
      })
      console.error(`[SourceSyncWorker] ${source.name} failed: ${msg}`)
    } finally {
      this.inflight.delete(source.id)
    }
    return stats
  }

  // ============================================================
  // Folder upsert
  // ============================================================

  private async upsertFolder(
    source: ExternalSourceRow,
    node: ExternalFileNode,
    parentDbId: string | null,
    stats: SyncRunStats,
  ): Promise<string | null> {
    const existing = this.db.findTreeNodeBySource(source.id, node.relativePath)

    if (existing) {
      const existingRow = existing as Record<string, unknown>
      const existingId = String(existingRow.id)
      // Restore from soft-delete if needed
      if (existingRow.deleted_at != null) {
        this.db.undeleteTreeNode(existingId)
      }
      // Update name / parent / last_synced_at — handles rename/move
      const nameChanged = (existingRow.name as string) !== node.name
      const parentChanged = (existingRow.parent_id as string | null | undefined) !== parentDbId
      if (nameChanged || parentChanged) {
        this.db.updateTreeNodeSourceLocation(existingId, {
          parent_id: parentDbId,
          name: node.name,
          source_path: node.relativePath,
          last_synced_at: Date.now(),
        })
        stats.foldersUpdated++
      } else {
        // touch last_synced_at so reverse-sweep can tell apart "seen this run"
        this.db.updateTreeNodeSourceLocation(existingId, {
          last_synced_at: Date.now(),
        })
      }
      return existingId
    }

    // Create new auto-managed folder
    const id = randomUUID()
    try {
      this.db.createDocumentTreeNode({
        id,
        org_id: source.org_id,
        parent_id: parentDbId,
        name: node.name,
        source_id: source.id,
        source_path: node.relativePath,
        auto_managed: 1,
        last_synced_at: Date.now(),
      })
      stats.foldersCreated++
      return id
    } catch (err) {
      console.error(
        `[SourceSyncWorker] failed to create folder ${node.relativePath}:`,
        err,
      )
      stats.errors++
      return null
    }
  }

  // ============================================================
  // File upsert
  // ============================================================

  private async upsertFile(
    source: ExternalSourceRow,
    node: ExternalFileNode,
    parentDbId: string,
    connector: { download: (externalId: string) => Promise<Buffer> },
    stats: SyncRunStats,
    dirtyNodeIds: Set<string>,
  ): Promise<string | null> {
    const existing = this.db.findDocumentBySource(source.id, node.externalId)

    if (existing) {
      const existingRow = existing as Record<string, unknown>
      const existingId = String(existingRow.id)
      const existingEtag = (existingRow.external_etag as string | null) ?? ''
      const existingSha = (existingRow.content_sha256 as string | null) ?? ''

      if (existingRow.deleted_at != null) {
        this.db.undeleteDocument(existingId)
      }

      if (existingEtag === node.etag) {
        // Fast path: etag unchanged. Touch nothing else.
        stats.filesSkipped++
        return existingId
      }

      // Etag changed → re-download
      let bytes: Buffer
      try {
        bytes = await connector.download(node.externalId)
      } catch (err) {
        console.error(
          `[SourceSyncWorker] download failed for ${node.relativePath}:`,
          err,
        )
        stats.errors++
        return existingId
      }
      const sha = createHash('sha256').update(bytes).digest('hex')

      // Update content on disk + DB. Reuse existing storage_path's directory
      // since the storage_path itself depends on filename, which may have
      // changed (rename). Compute fresh path keyed by doc id.
      const safeName = sanitizeFileName(node.name)
      const storagePath = getDocumentStoragePath(existingId, safeName)

      try {
        await mkdir(getDocumentDir(existingId), { recursive: true })
        // Clean stale files with old name, then write fresh.
        const oldStoragePath = (existingRow.storage_path as string) ?? ''
        if (oldStoragePath && oldStoragePath !== storagePath) {
          try {
            await rm(oldStoragePath, { force: true })
          } catch {
            // ignore
          }
        }
        await writeFile(storagePath, bytes)
      } catch (err) {
        console.error(
          `[SourceSyncWorker] write failed for ${node.relativePath}:`,
          err,
        )
        stats.errors++
        return existingId
      }

      this.db.updateDocumentContent(existingId, {
        external_etag: node.etag,
        content_sha256: sha,
        storage_path: storagePath,
        size_bytes: bytes.byteLength,
      })

      // If sha256 actually changed: mark file-list wikis referencing this doc,
      // and record this doc's node as dirty so dir-mode wikis get flagged in
      // the post-run flush.
      if (sha !== existingSha) {
        const wikis = this.db.findWikisReferencingDocument(existingId)
        for (const w of wikis) {
          this.markAndMaybeEnqueue(String(w.id), source, stats)
        }
        dirtyNodeIds.add(parentDbId)
      }

      stats.filesUpdated++
      return existingId
    }

    // New file: download → dedup-check by sha → create document row
    let bytes: Buffer
    try {
      bytes = await connector.download(node.externalId)
    } catch (err) {
      console.error(
        `[SourceSyncWorker] download failed for ${node.relativePath}:`,
        err,
      )
      stats.errors++
      return null
    }
    const sha = createHash('sha256').update(bytes).digest('hex')

    // Content-hash dedup: if there's already a (non-deleted) document with
    // the same sha in this org, we still create a new document row (the
    // tree position differs) but reuse the storage_path so we don't waste
    // disk on duplicate bytes. Wiki references are doc-id based so this
    // doesn't affect wiki dedup.
    let storagePath: string
    const dedup = this.db.findDocumentByHash(source.org_id, sha)
    const id = randomUUID()
    if (dedup && typeof (dedup as Record<string, unknown>).storage_path === 'string') {
      storagePath = String((dedup as Record<string, unknown>).storage_path)
    } else {
      const safeName = sanitizeFileName(node.name)
      storagePath = getDocumentStoragePath(id, safeName)
      try {
        await mkdir(getDocumentDir(id), { recursive: true })
        await writeFile(storagePath, bytes)
      } catch (err) {
        console.error(
          `[SourceSyncWorker] write failed for ${node.relativePath}:`,
          err,
        )
        stats.errors++
        return null
      }
    }

    try {
      this.db.createDocument({
        id,
        org_id: source.org_id,
        node_id: parentDbId,
        file_name: sanitizeFileName(node.name),
        mime_type: node.mimeType ?? 'application/octet-stream',
        size_bytes: bytes.byteLength,
        storage_path: storagePath,
        uploaded_by: source.created_by,
        source_id: source.id,
        external_id: node.externalId,
        external_etag: node.etag,
        content_sha256: sha,
      })
      stats.filesCreated++
      // New file under this node — dir-mode wikis tracking it should rebuild.
      dirtyNodeIds.add(parentDbId)
      return id
    } catch (err) {
      console.error(
        `[SourceSyncWorker] failed to insert document ${node.relativePath}:`,
        err,
      )
      stats.errors++
      return null
    }
  }

  // ============================================================
  // Reverse sweep
  // ============================================================

  private reverseSweep(
    source: ExternalSourceRow,
    seenNodeIds: Set<string>,
    seenDocIds: Set<string>,
    stats: SyncRunStats,
    dirtyNodeIds: Set<string>,
  ): void {
    // Documents
    const existingDocs = this.db.listDocumentsBySource(source.id)
    for (const d of existingDocs) {
      const id = String(d.id)
      if (seenDocIds.has(id)) continue
      this.db.softDeleteDocument(id)
      stats.filesDeleted++
      // Deleted file → its containing node is dirty for dir-mode wikis.
      const nodeId = typeof d.node_id === 'string' ? d.node_id : null
      if (nodeId) dirtyNodeIds.add(nodeId)
    }
    // Folders
    const existingNodes = this.db.listTreeNodesBySource(source.id)
    for (const n of existingNodes) {
      const id = String(n.id)
      if (seenNodeIds.has(id)) continue
      this.db.softDeleteTreeNode(id)
      stats.foldersDeleted++
      // Deleted folder → mark the folder itself and its parent dirty so a
      // dir-mode wiki tracking either (or an ancestor) rebuilds.
      dirtyNodeIds.add(id)
      const parentId = typeof n.parent_id === 'string' ? n.parent_id : null
      if (parentId) dirtyNodeIds.add(parentId)
    }
  }

  // ============================================================
  // Wiki rebuild flagging
  // ============================================================

  /**
   * Mark one wiki as needing rebuild and — if its own `auto_rebuild` toggle is
   * on — enqueue a build via the onWikiNeedsRebuild hook. Rebuild policy is now
   * per-wiki, not per-source.
   */
  private markAndMaybeEnqueue(
    wikiId: string,
    source: ExternalSourceRow,
    stats: SyncRunStats,
  ): void {
    this.db.markWikiNeedsRebuild(wikiId, true)
    stats.wikisMarked++
    const wikiRow = this.db.getWikiById(wikiId) as Record<string, unknown> | null
    const autoRebuild = wikiRow ? Number(wikiRow.auto_rebuild ?? 0) === 1 : false
    if (autoRebuild && this.onWikiNeedsRebuild) {
      this.onWikiNeedsRebuild(wikiId, source.org_id, source.id)
    }
  }

  /**
   * After a sync run, flag every dir-mode wiki that tracks any touched node or
   * an ancestor of one. Deduped so each wiki is marked/enqueued at most once.
   */
  private flushDirtyWikis(
    source: ExternalSourceRow,
    dirtyNodeIds: Set<string>,
    stats: SyncRunStats,
  ): void {
    if (dirtyNodeIds.size === 0) return
    // Build a child→parent map once from the org's node list so we can expand
    // each dirty node to its full ancestor chain (root-ward).
    const nodes = this.db.listDocumentTreeNodes(source.org_id)
    const parentOf = new Map<string, string | null>()
    for (const n of nodes) {
      parentOf.set(String(n.id), (n.parent_id as string | null) ?? null)
    }
    const chain = new Set<string>()
    for (const start of dirtyNodeIds) {
      let cur: string | null = start
      const guard = new Set<string>()
      while (cur && !guard.has(cur)) {
        guard.add(cur)
        chain.add(cur)
        cur = parentOf.get(cur) ?? null
      }
    }
    const wikis = this.db.findDirWikisForNode([...chain])
    const marked = new Set<string>()
    for (const w of wikis) {
      const wikiId = String(w.id)
      if (marked.has(wikiId)) continue
      marked.add(wikiId)
      this.markAndMaybeEnqueue(wikiId, source, stats)
    }
  }

  // ============================================================
  // Config + credentials
  // ============================================================

  private parseConfig(source: ExternalSourceRow): ExternalSourceConfig {
    let parsed: unknown
    try {
      parsed = JSON.parse(source.config_json)
    } catch {
      throw new Error(`external_source ${source.id}: config_json is not valid JSON`)
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`external_source ${source.id}: config_json must be a JSON object`)
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.rootPath !== 'string') {
      // Default to empty string (connector decides what '' means — FS treats as rootAbsolute)
      obj.rootPath = ''
    }
    return obj as ExternalSourceConfig
  }

  /**
   * Resolve credentials for the source via the AES-256-GCM secret store
   * (see ./secrets.ts). Returns an empty object on missing key / failure.
   */
  private async loadCredentials(source: ExternalSourceRow): Promise<ExternalSourceCredentials> {
    if (!source.credentials_secret_key) return {}
    try {
      const { readSecret } = await import('./secrets.js')
      return await readSecret(source.credentials_secret_key)
    } catch (err) {
      console.error(
        `[SourceSyncWorker] failed to load credentials for ${source.id}:`,
        err,
      )
      return {}
    }
  }
}

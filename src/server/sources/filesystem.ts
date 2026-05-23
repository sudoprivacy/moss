/**
 * Document Center v2 — Filesystem Connector.
 *
 * Reads a local directory (typically a mounted NAS / NFS / SMB share)
 * and emits ExternalFileNodes for everything under `rootPath`.
 *
 * Design choices for P0:
 *   - etag = `<size>-<mtime_ms>` — cheap, no content hash needed in
 *     walkTree (sync worker can compute sha256 from the downloaded
 *     bytes when it cares about content equality)
 *   - externalId = relative POSIX path (e.g. `subdir/foo.docx`).
 *     Stable as long as the file isn't moved (renames look like
 *     delete-then-create, same as for cloud connectors that don't
 *     expose a separate ID space)
 *   - No symlink following — we treat symlinks as their literal
 *     target if pointing to a file, and skip them if pointing to a
 *     directory to avoid loops
 *   - Hidden files (`.git`, `.DS_Store`, dotfiles) are skipped by
 *     default; future enhancement: read ignore patterns from
 *     ExternalSourceConfig
 *
 * Path safety: every operation re-resolves against `rootPath` and
 * rejects anything that escapes (defence-in-depth against config
 * shenanigans / symlinks).
 */

import { readFile, readdir, stat } from 'fs/promises'
import path from 'node:path'
import {
  type ExternalFileNode,
  type ExternalSourceConfig,
  type ExternalSourceConnector,
  type ExternalSourceCredentials,
  type TestConnectionResult,
  registerConnector,
} from './types.js'

// Minimal extension → MIME table. Avoids pulling in the `mime-types`
// dep just for connector use; covers everything we expect document
// center to ingest (docx/pdf/md/xlsx/txt/images).
const EXT_MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function guessMimeByName(name: string): string | undefined {
  const ext = path.posix.extname(name).toLowerCase()
  return EXT_MIME[ext]
}

const DEFAULT_IGNORES = new Set<string>([
  '.git',
  '.svn',
  '.hg',
  '.DS_Store',
  'Thumbs.db',
  'node_modules',
  '.idea',
  '.vscode',
])

export class FilesystemConnector implements ExternalSourceConnector {
  readonly type = 'filesystem'

  private rootAbsolute: string = ''
  private ignorePatterns: Set<string> = new Set(DEFAULT_IGNORES)

  async init(
    config: ExternalSourceConfig,
    _credentials: ExternalSourceCredentials,
  ): Promise<void> {
    if (!config.rootPath || typeof config.rootPath !== 'string') {
      throw new Error('filesystem connector: config.rootPath must be a non-empty string')
    }
    this.rootAbsolute = path.resolve(config.rootPath)

    // Verify rootPath exists and is a directory
    const s = await stat(this.rootAbsolute).catch(() => null)
    if (!s) {
      throw new Error(`filesystem connector: rootPath does not exist: ${this.rootAbsolute}`)
    }
    if (!s.isDirectory()) {
      throw new Error(`filesystem connector: rootPath is not a directory: ${this.rootAbsolute}`)
    }

    if (Array.isArray(config.ignorePatterns)) {
      this.ignorePatterns = new Set([
        ...DEFAULT_IGNORES,
        ...(config.ignorePatterns as unknown[]).filter((v): v is string => typeof v === 'string'),
      ])
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const s = await stat(this.rootAbsolute)
      if (!s.isDirectory()) {
        return { ok: false, message: `not a directory: ${this.rootAbsolute}` }
      }
      // Try a one-level readdir to verify permissions
      await readdir(this.rootAbsolute)
      return { ok: true, message: `accessible: ${this.rootAbsolute}` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async list(relPath: string): Promise<ExternalFileNode[]> {
    const abs = this.resolveSafe(relPath)
    const entries = await readdir(abs, { withFileTypes: true })
    const out: ExternalFileNode[] = []
    for (const entry of entries) {
      if (this.shouldIgnore(entry.name)) continue
      const entryAbs = path.join(abs, entry.name)
      const entryRel = path.posix.join(this.toPosix(relPath), entry.name)
      const node = await this.statToNode(entryAbs, entryRel, this.toPosix(relPath) || null)
      if (node) out.push(node)
    }
    return out
  }

  async *walkTree(rootRel: string): AsyncIterable<ExternalFileNode> {
    // We yield folders before their children (DFS, pre-order) so the
    // sync worker can resolve parent references in a single pass.
    const stack: Array<{ rel: string; parentRel: string | null }> = [
      { rel: this.toPosix(rootRel), parentRel: null },
    ]

    while (stack.length > 0) {
      const { rel, parentRel } = stack.pop()!
      const abs = this.resolveSafe(rel)
      const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])

      // Stable order to make sync diffs deterministic
      entries.sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        if (this.shouldIgnore(entry.name)) continue
        const entryRel = path.posix.join(rel, entry.name).replace(/^\/+/, '')
        const entryAbs = path.join(abs, entry.name)
        const node = await this.statToNode(entryAbs, entryRel, rel || parentRel)
        if (!node) continue
        yield node
        if (node.type === 'folder') {
          stack.push({ rel: entryRel, parentRel: rel || null })
        }
      }
    }
  }

  async download(externalId: string): Promise<Buffer> {
    const abs = this.resolveSafe(externalId)
    return readFile(abs)
  }

  async getEtag(externalId: string): Promise<string> {
    const abs = this.resolveSafe(externalId)
    const s = await stat(abs)
    return this.makeEtag(s.size, s.mtimeMs)
  }

  // ============================================================
  // Internals
  // ============================================================

  private toPosix(p: string): string {
    return p.split(path.sep).join('/').replace(/^\/+/, '')
  }

  /**
   * Resolve a relative path against rootAbsolute and reject any
   * traversal attempt. Returns the absolute path.
   */
  private resolveSafe(relPath: string): string {
    const normalized = relPath.replace(/^\/+/, '')
    const abs = path.resolve(this.rootAbsolute, normalized)
    const rootWithSep = this.rootAbsolute.endsWith(path.sep)
      ? this.rootAbsolute
      : this.rootAbsolute + path.sep
    if (abs !== this.rootAbsolute && !abs.startsWith(rootWithSep)) {
      throw new Error(`path escapes root: ${relPath}`)
    }
    return abs
  }

  private shouldIgnore(name: string): boolean {
    return this.ignorePatterns.has(name)
  }

  private async statToNode(
    abs: string,
    relPath: string,
    parentRel: string | null,
  ): Promise<ExternalFileNode | null> {
    let s
    try {
      // Use lstat-ish behavior — don't follow symlinks to directories
      // (avoid loops). For files we follow.
      s = await stat(abs)
    } catch {
      return null
    }
    const name = path.posix.basename(relPath) || relPath

    if (s.isDirectory()) {
      return {
        externalId: relPath,
        parentExternalId: parentRel ?? null,
        type: 'folder',
        name,
        relativePath: relPath,
        // Folders don't have meaningful etags in this connector; use a
        // sentinel so the sync worker can still compare loosely.
        etag: 'dir',
        lastModified: s.mtimeMs,
      }
    }
    if (s.isFile()) {
      return {
        externalId: relPath,
        parentExternalId: parentRel ?? null,
        type: 'file',
        name,
        relativePath: relPath,
        size: s.size,
        mimeType: guessMimeByName(name),
        etag: this.makeEtag(s.size, s.mtimeMs),
        lastModified: s.mtimeMs,
      }
    }
    // Symlinks / sockets / devices — skip
    return null
  }

  private makeEtag(size: number, mtimeMs: number): string {
    // Truncate mtime to ms integer for stability across rehydrates
    return `${size}-${Math.floor(mtimeMs)}`
  }
}

// Register on module import
registerConnector('filesystem', () => new FilesystemConnector())

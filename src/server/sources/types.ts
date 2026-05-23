/**
 * Document Center v2 — Connector abstraction.
 *
 * An ExternalSourceConnector pulls a (subset of a) filesystem-like tree
 * from some external system (WeCom Drive, local filesystem, future:
 * Feishu Drive / SharePoint / DingTalk Drive / etc) into Moss's
 * document_tree_nodes + documents tables.
 *
 * Two implementations land in P0:
 *   - WecomDriveConnector (sources/wecomDrive.ts) — Ruigu's case
 *   - FilesystemConnector (sources/filesystem.ts) — works for any
 *     locally mounted directory and is the cleanest validation of the
 *     abstraction.
 *
 * Future connectors only need to implement this interface and register
 * themselves with `registerConnector(type, factory)` below.
 *
 * The generic SourceSyncWorker (sources/syncWorker.ts) consumes
 * connectors via this interface and knows nothing of provider-specific
 * APIs — that's the whole point of the abstraction.
 */

// ============================================================
// Types
// ============================================================

/**
 * One node in an external source tree. Connectors emit these from
 * `list()` / `walkTree()` and the sync worker maps them to
 * document_tree_nodes (folders) / documents (files).
 */
export type ExternalFileNode = {
  /** Stable ID in the source. For WeCom this is fileid; for FS this is the relative path. */
  externalId: string

  /** Parent's externalId. `null` for top-level nodes under `rootPath`. */
  parentExternalId: string | null

  type: 'folder' | 'file'

  /** Display name (one path segment, no slashes). */
  name: string

  /**
   * Relative path inside the source, from `rootPath`. Used as a stable
   * key for the sync diff alongside externalId so we can detect renames
   * even when externalId stays the same.
   *
   * For files this is the path including the file name; for folders it
   * does not have a trailing slash.
   */
  relativePath: string

  /** File size in bytes (undefined for folders). */
  size?: number

  /** MIME type (best-effort; undefined for folders or when source doesn't tell us). */
  mimeType?: string

  /**
   * An opaque content fingerprint provided by the source. Compared via
   * `===` to detect changes. The sync worker doesn't interpret this —
   * connectors decide the format (etag, lastModified epoch, content
   * hash, etc).
   */
  etag: string

  /** Optional last-modified time in epoch ms. Purely informational. */
  lastModified?: number
}

/**
 * Configuration payload for a connector. Stored in
 * external_sources.config_json. Each connector type defines its own
 * required keys; the abstraction only requires `rootPath`.
 */
export type ExternalSourceConfig = {
  /** Root path inside the source. Connector decides interpretation. */
  rootPath: string

  /**
   * Optional: ID of the document_tree_node under which the mirrored
   * tree should be mounted. If omitted, the source is mounted as a
   * top-level tree.
   */
  mountedNodeId?: string | null

  /** Connector-specific options. */
  [key: string]: unknown
}

/**
 * Credentials handed to the connector at init time. Stored encrypted
 * by the secret store and resolved by the worker before calling
 * `init()`. The shape is connector-specific.
 */
export type ExternalSourceCredentials = Record<string, string>

/**
 * Change event for the optional `watchChanges` path (P0 doesn't use
 * this; webhook-based real-time sync is a Phase 2 goal).
 */
export type ChangeEvent =
  | { kind: 'upsert'; node: ExternalFileNode }
  | { kind: 'delete'; externalId: string }
  | { kind: 'rename'; externalId: string; newRelativePath: string; newName: string }

/**
 * Result of `testConnection()` — shown in the AdminHub config dialog.
 */
export type TestConnectionResult = {
  ok: boolean
  message?: string
}

// ============================================================
// Connector interface
// ============================================================

export interface ExternalSourceConnector {
  /** Connector type identifier — also the value stored in external_sources.type. */
  readonly type: string

  /**
   * Establish a session with the source using `config` + `credentials`.
   * Implementations should keep state in-memory; the worker creates a
   * new connector instance per sync run, so no need for explicit
   * teardown beyond a connection close hint.
   */
  init(config: ExternalSourceConfig, credentials: ExternalSourceCredentials): Promise<void>

  /**
   * List immediate children of `path`. `path` is relative to `rootPath`
   * (so the empty string `''` means "list rootPath itself"). Used by
   * the AdminHub UI for browsing; the sync worker uses `walkTree`
   * instead.
   */
  list(path: string): Promise<ExternalFileNode[]>

  /**
   * Yield every node under `rootPath`, depth-first. The order doesn't
   * matter for correctness, but emitting folders before their children
   * keeps the sync worker's parent-resolution simple.
   */
  walkTree(rootPath: string): AsyncIterable<ExternalFileNode>

  /**
   * Download a file's bytes. `externalId` is whatever the connector
   * put in ExternalFileNode.externalId.
   */
  download(externalId: string): Promise<Buffer>

  /**
   * Fetch the current etag for a file (without downloading). Used by
   * the sync worker's fast-path skip when the etag hasn't changed.
   *
   * Implementations that don't have a cheaper etag source than
   * `walkTree` itself can simply return the etag the worker already
   * holds — the worker calls this only when it explicitly wants to
   * re-verify, not in the hot path.
   */
  getEtag(externalId: string): Promise<string>

  /**
   * Test the connection with the given config + credentials. Should be
   * cheap (no full tree walk) — typically just authenticate + list the
   * root directory.
   */
  testConnection(): Promise<TestConnectionResult>

  /**
   * Optional: subscribe to live change events. Returns an unsubscribe
   * function. Connectors that support webhooks (WeCom does, with
   * proper plumbing) can implement this in Phase 2. P0 sync worker
   * doesn't call it.
   */
  watchChanges?(callback: (event: ChangeEvent) => void): () => void
}

// ============================================================
// Connector registry
// ============================================================

export type ConnectorFactory = () => ExternalSourceConnector

const registry = new Map<string, ConnectorFactory>()

/**
 * Register a connector type. Called once at module init time by each
 * connector implementation (sources/wecomDrive.ts, sources/filesystem.ts).
 */
export function registerConnector(type: string, factory: ConnectorFactory): void {
  if (registry.has(type)) {
    throw new Error(`connector type already registered: ${type}`)
  }
  registry.set(type, factory)
}

/**
 * Construct a fresh connector instance for the given type. Throws if
 * the type isn't registered. The sync worker creates one per sync run
 * so connectors don't need to be reentrant.
 */
export function createConnector(type: string): ExternalSourceConnector {
  const factory = registry.get(type)
  if (!factory) {
    throw new Error(`unknown connector type: ${type}`)
  }
  return factory()
}

/** Return all registered connector type names. */
export function listConnectorTypes(): string[] {
  return Array.from(registry.keys()).sort()
}

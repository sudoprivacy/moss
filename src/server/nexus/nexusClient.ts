/**
 * NexusClient implementation using gRPC VFS (Rust nexusd-cluster).
 *
 * Secrets are stored as JSON files in the Nexus VFS:
 *   /secrets/{namespace}/{key}.json
 *
 * Each file contains: { value: string, status: string, version: number, updatedAt: number }
 *
 * Since Rust nexusd-cluster doesn't support list/readdir operations,
 * we maintain a local index in SQLite for metadata tracking.
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

// Lazy-load the native gRPC client
function loadNativeBinding(): typeof import('../../../native/nexus-napi') {
  try {
    const { app } = require('electron')
    const path = require('path')
    const appRoot = app.isPackaged
      ? app.getAppPath().replace('app.asar', 'app.asar.unpacked')
      : app.getAppPath()
    return require(path.join(appRoot, 'native', 'nexus-napi'))
  } catch {
    // Fallback for non-Electron environment (standalone server)
    try {
      return require('../../../native/nexus-napi')
    } catch {
      throw new Error('nexus-napi native module not available. Run `bun run build:native` first.')
    }
  }
}

interface SecretRecord {
  value: string | null
  status: string
  version: number
  updatedAt: number
}

interface SecretMetadata {
  namespace: string
  key: string
  value: string | null
  status: string
  version: number
}

// VFS root under which secrets are stored. Defaults to `/secrets` (embedded
// serve-local, which lands in the daemon's node-local root zone). On the merged
// cluster, point this at a moss-owned zone subtree (e.g. `/moss/secrets`) via
// MOSS_NEXUS_SECRETS_ROOT so writes are zone-scoped rather than in the shared
// federated root — avoiding cross-node leakage on a multi-node cluster.
const SECRETS_ROOT = process.env.MOSS_NEXUS_SECRETS_ROOT?.trim().replace(/\/+$/, '') || '/secrets'

/** mTLS material for connecting to an auth-on external `nexusd-cluster`. */
export type NexusClientTlsConfig = {
  caPath: string
  certPath: string
  keyPath: string
  /** Server-cert SAN to validate; defaults to the cluster's `nexus-node`. */
  serverName?: string
}

let db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (!db) {
    const dataDir = join(homedir(), '.moss', 'nexus')
    mkdirSync(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'secrets_index.db')
    db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        status TEXT DEFAULT 'enabled',
        version INTEGER DEFAULT 1,
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        PRIMARY KEY (namespace, key)
      )
    `)
  }
  return db
}

export class NexusClient {
  private client: InstanceType<ReturnType<typeof loadNativeBinding>['NexusGrpcClient']> | null = null
  private readonly endpoint: string
  private readonly authToken: string
  private readonly tls: NexusClientTlsConfig | null
  private nativeBinding: ReturnType<typeof loadNativeBinding> | null = null

  constructor(grpcEndpoint: string, authToken = '', tls: NexusClientTlsConfig | null = null) {
    this.endpoint = grpcEndpoint
    this.authToken = authToken
    this.tls = tls
  }

  private getClient(): InstanceType<ReturnType<typeof loadNativeBinding>['NexusGrpcClient']> {
    if (!this.client) {
      this.nativeBinding = loadNativeBinding()
      // mTLS to an auth-on cluster vs. plaintext trusted-loopback serve-local.
      this.client = this.tls
        ? this.nativeBinding.NexusGrpcClient.withMtls(
            this.endpoint,
            this.tls.caPath,
            this.tls.certPath,
            this.tls.keyPath,
            this.tls.serverName,
          )
        : new this.nativeBinding.NexusGrpcClient(this.endpoint)
    }
    return this.client
  }

  private namespaceToPath(namespace: string): string {
    // Sanitize namespace for filesystem: replace : with /
    const sanitized = namespace.replace(/:/g, '/')
    return `${SECRETS_ROOT}/${sanitized}`
  }

  private keyToPath(namespace: string, key: string): string {
    const nsPath = this.namespaceToPath(namespace)
    // Sanitize key: only allow alphanumeric, dash, underscore
    const sanitizedKey = key.replace(/[^a-zA-Z0-9_-]/g, '_')
    return `${nsPath}/${sanitizedKey}.json`
  }

  private parseSecretContent(content: Buffer): SecretRecord {
    try {
      const parsed = JSON.parse(content.toString('utf8'))
      return {
        value: parsed.value ?? null,
        status: parsed.status ?? 'enabled',
        version: parsed.version ?? 1,
        updatedAt: parsed.updatedAt ?? Date.now(),
      }
    } catch {
      return { value: null, status: 'enabled', version: 1, updatedAt: Date.now() }
    }
  }

  private serializeSecret(record: SecretRecord): Buffer {
    return Buffer.from(JSON.stringify(record), 'utf8')
  }

  async putSecret(namespace: string, key: string, value: string, subject?: string): Promise<void> {
    const client = this.getClient()
    const filePath = this.keyToPath(namespace, key)

    // Read existing secret to increment version
    let version = 1
    try {
      const existing = client.read(filePath, this.authToken)
      const existingRecord = this.parseSecretContent(existing)
      version = existingRecord.version + 1
    } catch {
      // File doesn't exist, start with version 1
    }

    // Write the secret
    const record: SecretRecord = {
      value,
      status: 'enabled',
      version,
      updatedAt: Date.now(),
    }
    client.write(filePath, this.serializeSecret(record), this.authToken)

    // Update index
    const db = getDb()
    db.prepare(`
      INSERT INTO secrets (namespace, key, status, version, updated_at)
      VALUES (?, ?, 'enabled', ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        status = 'enabled',
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(namespace, key, version, record.updatedAt)
  }

  async getSecret(namespace: string, key: string, subject?: string): Promise<{ value: string | null; status: string; version: number } | null> {
    const client = this.getClient()
    const filePath = this.keyToPath(namespace, key)

    try {
      const content = client.read(filePath, this.authToken)
      const record = this.parseSecretContent(content)
      return {
        value: record.value,
        status: record.status,
        version: record.version,
      }
    } catch {
      // File doesn't exist
      return null
    }
  }

  async deleteSecret(namespace: string, key: string, subject?: string): Promise<void> {
    const client = this.getClient()
    const filePath = this.keyToPath(namespace, key)

    try {
      client.delete(filePath, this.authToken)
    } catch {
      // Ignore deletion errors (file might not exist)
    }

    // Update index
    const db = getDb()
    db.prepare(`DELETE FROM secrets WHERE namespace = ? AND key = ?`).run(namespace, key)
  }

  async enableSecret(namespace: string, key: string, subject?: string): Promise<void> {
    const client = this.getClient()
    const filePath = this.keyToPath(namespace, key)

    try {
      const content = client.read(filePath, this.authToken)
      const record = this.parseSecretContent(content)
      record.status = 'enabled'
      record.updatedAt = Date.now()
      client.write(filePath, this.serializeSecret(record), this.authToken)

      // Update index
      const db = getDb()
      db.prepare(`UPDATE secrets SET status = 'enabled', updated_at = ? WHERE namespace = ? AND key = ?`)
        .run(record.updatedAt, namespace, key)
    } catch {
      // File doesn't exist, nothing to enable
    }
  }

  async disableSecret(namespace: string, key: string, subject?: string): Promise<void> {
    const client = this.getClient()
    const filePath = this.keyToPath(namespace, key)

    try {
      const content = client.read(filePath, this.authToken)
      const record = this.parseSecretContent(content)
      record.status = 'disabled'
      record.updatedAt = Date.now()
      client.write(filePath, this.serializeSecret(record), this.authToken)

      // Update index
      const db = getDb()
      db.prepare(`UPDATE secrets SET status = 'disabled', updated_at = ? WHERE namespace = ? AND key = ?`)
        .run(record.updatedAt, namespace, key)
    } catch {
      // File doesn't exist, nothing to disable
    }
  }

  async listSecrets(namespace?: string, subject?: string): Promise<SecretMetadata[]> {
    const client = this.getClient()
    const db = getDb()

    // Query from index
    let rows: Array<{ namespace: string; key: string; status: string; version: number }>
    if (namespace) {
      rows = db.prepare(`
        SELECT namespace, key, status, version
        FROM secrets
        WHERE namespace = ? OR namespace LIKE ?
        ORDER BY namespace, key
      `).all(namespace, `${namespace}:%`) as Array<{ namespace: string; key: string; status: string; version: number }>
    } else {
      rows = db.prepare(`
        SELECT namespace, key, status, version
        FROM secrets
        ORDER BY namespace, key
      `).all() as Array<{ namespace: string; key: string; status: string; version: number }>
    }

    // Build result, read values from VFS
    const results: SecretMetadata[] = []
    for (const row of rows) {
      const filePath = this.keyToPath(row.namespace, row.key)
      let value: string | null = null
      try {
        const content = client.read(filePath, this.authToken)
        const record = this.parseSecretContent(content)
        value = record.value
      } catch {
        // Can't read, value stays null
      }
      results.push({
        namespace: row.namespace,
        key: row.key,
        value,
        status: row.status,
        version: row.version,
      })
    }

    return results
  }

  /**
   * List namespaces that have at least one secret record.
   * Only queries the local SQLite index — no VFS reads.
   */
  listConfiguredNamespaces(prefix?: string): Set<string> {
    const d = getDb()
    let rows: Array<{ namespace: string }>
    if (prefix) {
      rows = d.prepare(
        'SELECT DISTINCT namespace FROM secrets WHERE namespace = ? OR namespace LIKE ?'
      ).all(prefix, `${prefix}:%`) as Array<{ namespace: string }>
    } else {
      rows = d.prepare(
        'SELECT DISTINCT namespace FROM secrets'
      ).all() as Array<{ namespace: string }>
    }
    return new Set(rows.map(r => r.namespace))
  }
}
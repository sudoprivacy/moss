import { readFile, readdir, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type SqlRow = Record<string, unknown>

export interface SudoworkSourceConfigEntry {
  id: number
  configKey: string
  name: string
  description: string | null
  required: boolean
  createdAt: number
  updatedAt: number
}

export interface SudoworkSourceConfigItem {
  id: number
  name: string
  description: string | null
  icon: string | null
  pinyin: string | null
  urlPattern: string | null
  scheme: string | null
  bearerPrefix: string | null
  visibleToAll: boolean
  status: number
  createdById: number | null
  createdByName: string | null
  updatedById: number | null
  updatedByName: string | null
  createdAt: number
  updatedAt: number
  entries: SudoworkSourceConfigEntry[]
  enterpriseIds: number[]
}

export interface SudoworkHubResource {
  id: string
  tenantIds: string[]
  name: string
  displayName: string | null
  authorId: string
  status: number | string
  version: string | null
  checksum: string | null
  artifactPath: string
  metadata: Record<string, unknown>
}

export interface SudoworkHubManifest {
  schemaVersion: 1
  source: {
    sudoworkServerCommit: string
    sudoworkClientCommit: string
    hubProviderId: string
    hubExportId: string
    exportedAt: string
  }
  agents: SudoworkHubResource[]
  skills: SudoworkHubResource[]
}

export interface SudoworkManagedImage {
  kind: 'config-item' | 'enterprise'
  filename: string
  mimeType: string
  bytes: Buffer
}

export class SudoworkP2SourceError extends Error {
  constructor(readonly code: 'INVALID_MANIFEST' | 'UNSAFE_PATH' | 'INVALID_SOURCE', message: string) {
    super(message)
    this.name = 'SudoworkP2SourceError'
  }
}

export class SudoworkP2SourceReader {
  private readonly root: string

  constructor(snapshotDir: string) {
    this.root = resolve(snapshotDir)
  }

  readConfigItems(): SudoworkSourceConfigItem[] {
    return this.withDatabase(db => {
      if (!tableExists(db, 'config_items')) return []
      const entries = tableExists(db, 'config_entries')
        ? db.prepare('SELECT * FROM config_entries ORDER BY config_item_id, id').all() as SqlRow[]
        : []
      const relations = tableExists(db, 'config_enterprise_rel')
        ? db.prepare('SELECT config_item_id, enterprise_id FROM config_enterprise_rel ORDER BY config_item_id, enterprise_id').all() as SqlRow[]
        : []
      const entriesByItem = groupByNumber(entries, 'config_item_id')
      const relationsByItem = groupByNumber(relations, 'config_item_id')
      return (db.prepare('SELECT * FROM config_items ORDER BY id').all() as SqlRow[]).map(row => ({
        id: integer(row.id, 'config_items.id'),
        name: requiredText(row.name, 'config_items.name'),
        description: nullableText(row.description),
        icon: nullableText(row.icon),
        pinyin: nullableText(row.pinyin),
        urlPattern: nullableText(row.url_pattern),
        scheme: nullableText(row.scheme),
        bearerPrefix: nullableText(row.bearer_prefix),
        visibleToAll: Number(row.visible_to_all ?? 0) === 1,
        status: integer(row.status ?? 1, 'config_items.status'),
        createdById: nullableInteger(row.created_by_id),
        createdByName: nullableText(row.created_by_name),
        updatedById: nullableInteger(row.updated_by_id),
        updatedByName: nullableText(row.updated_by_name),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
        entries: (entriesByItem.get(Number(row.id)) ?? []).map(entry => ({
          id: integer(entry.id, 'config_entries.id'),
          configKey: requiredText(entry.config_key, 'config_entries.config_key'),
          name: requiredText(entry.name, 'config_entries.name'),
          description: nullableText(entry.config_desc),
          required: Number(entry.required ?? 1) === 1,
          createdAt: timestamp(entry.created_at),
          updatedAt: timestamp(entry.updated_at),
        })),
        enterpriseIds: (relationsByItem.get(Number(row.id)) ?? [])
          .map(relation => integer(relation.enterprise_id, 'config_enterprise_rel.enterprise_id')),
      }))
    })
  }

  readSystemConfig(): Record<string, string> {
    return this.withDatabase(db => {
      if (!tableExists(db, 'system_config')) return {}
      return Object.fromEntries((db.prepare('SELECT key, value FROM system_config ORDER BY key').all() as SqlRow[])
        .map(row => [requiredText(row.key, 'system_config.key'), String(row.value ?? '')]))
    })
  }

  async readHubManifest(): Promise<SudoworkHubManifest> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(join(this.root, 'hub-catalog.json'), 'utf8'))
    } catch (error) {
      throw new SudoworkP2SourceError('INVALID_MANIFEST', `无法读取 Hub 清单: ${message(error)}`)
    }
    const root = record(raw, 'Hub 清单')
    if (root.schema_version !== 1) throw invalidManifest('schema_version 必须为 1')
    const source = record(root.source, 'source')
    const manifest: SudoworkHubManifest = {
      schemaVersion: 1,
      source: {
        sudoworkServerCommit: requiredText(source.sudowork_server_commit, 'source.sudowork_server_commit'),
        sudoworkClientCommit: requiredText(source.sudowork_client_commit, 'source.sudowork_client_commit'),
        hubProviderId: requiredText(source.hub_provider_id, 'source.hub_provider_id'),
        hubExportId: requiredText(source.hub_export_id, 'source.hub_export_id'),
        exportedAt: requiredText(source.exported_at, 'source.exported_at'),
      },
      agents: resources(root.agents, 'agents'),
      skills: resources(root.skills, 'skills'),
    }
    assertUniqueIds(manifest.agents, 'Agent')
    assertUniqueIds(manifest.skills, 'Skill')
    return manifest
  }

  async readArtifact(artifactPath: string): Promise<Buffer> {
    return this.readRelativeFile(artifactPath, '制品')
  }

  async readManagedImages(): Promise<SudoworkManagedImage[]> {
    const result: SudoworkManagedImage[] = []
    for (const [kind, directory] of [
      ['config-item', 'config-items'],
      ['enterprise', 'enterprises'],
    ] as const) {
      let entries
      try {
        entries = await readdir(join(this.root, 'uploads', directory), { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new SudoworkP2SourceError('INVALID_SOURCE', `无法读取历史图片目录 ${directory}: ${message(error)}`)
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile()) {
          throw new SudoworkP2SourceError('UNSAFE_PATH', `历史图片目录包含非普通文件: ${directory}/${entry.name}`)
        }
        const mimeType = imageMimeType(entry.name)
        if (!mimeType) throw new SudoworkP2SourceError('INVALID_SOURCE', `历史图片扩展名不受支持: ${entry.name}`)
        result.push({
          kind,
          filename: entry.name,
          mimeType,
          bytes: await this.readRelativeFile(join('uploads', directory, entry.name), '历史图片'),
        })
      }
    }
    return result
  }

  private async readRelativeFile(artifactPath: string, label: string): Promise<Buffer> {
    if (!artifactPath.trim() || isAbsolute(artifactPath)) {
      throw new SudoworkP2SourceError('UNSAFE_PATH', `${label}路径必须是快照目录内的相对路径`)
    }
    const target = resolve(this.root, artifactPath)
    if (escapes(this.root, target)) throw new SudoworkP2SourceError('UNSAFE_PATH', '制品路径逃逸快照目录')
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(this.root), realpath(target)])
      if (escapes(realRoot, realTarget)) throw new SudoworkP2SourceError('UNSAFE_PATH', '制品符号链接逃逸快照目录')
      return await readFile(realTarget)
    } catch (error) {
      if (error instanceof SudoworkP2SourceError) throw error
      throw new SudoworkP2SourceError('INVALID_SOURCE', `无法读取${label} ${artifactPath}: ${message(error)}`)
    }
  }

  private withDatabase<T>(read: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(join(this.root, 'sudowork.sqlite'), { readOnly: true })
      db.exec('PRAGMA query_only = ON')
      return read(db)
    } catch (error) {
      if (error instanceof SudoworkP2SourceError) throw error
      throw new SudoworkP2SourceError('INVALID_SOURCE', `无法读取 Sudowork SQLite 快照: ${message(error)}`)
    } finally {
      db?.close()
    }
  }
}

function imageMimeType(filename: string): string | null {
  const extension = extname(filename).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.svg') return 'image/svg+xml'
  return null
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function groupByNumber(rows: SqlRow[], key: string): Map<number, SqlRow[]> {
  const result = new Map<number, SqlRow[]>()
  for (const row of rows) {
    const id = integer(row[key], key)
    result.set(id, [...(result.get(id) ?? []), row])
  }
  return result
}

function resources(value: unknown, field: string): SudoworkHubResource[] {
  if (!Array.isArray(value)) throw invalidManifest(`${field} 必须为数组`)
  return value.map((item, index) => {
    const row = record(item, `${field}[${index}]`)
    if (!Array.isArray(row.tenant_ids) || row.tenant_ids.some(code => typeof code !== 'string' || !code.trim())) {
      throw invalidManifest(`${field}[${index}].tenant_ids 必须是非空字符串数组`)
    }
    return {
      id: requiredText(row.id, `${field}[${index}].id`),
      tenantIds: row.tenant_ids.map(code => String(code).trim()),
      name: requiredText(row.name, `${field}[${index}].name`),
      displayName: nullableText(row.display_name),
      authorId: requiredText(row.author_id, `${field}[${index}].author_id`),
      status: typeof row.status === 'number' || typeof row.status === 'string'
        ? row.status
        : (() => { throw invalidManifest(`${field}[${index}].status 无效`) })(),
      version: nullableText(row.version),
      checksum: nullableText(row.checksum),
      artifactPath: requiredText(row.artifact_path, `${field}[${index}].artifact_path`),
      metadata: Object.fromEntries(Object.entries(row).filter(([key]) => ![
        'id', 'tenant_ids', 'name', 'display_name', 'author_id', 'status', 'version', 'checksum', 'artifact_path',
      ].includes(key))),
    }
  })
}

function assertUniqueIds(resources: SudoworkHubResource[], label: string): void {
  const seen = new Set<string>()
  for (const resource of resources) {
    if (seen.has(resource.id)) throw invalidManifest(`${label} 存在重复资源 ID: ${resource.id}`)
    seen.add(resource.id)
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidManifest(`${field} 必须为对象`)
  return value as Record<string, unknown>
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidManifest(`${field} 不能为空`)
  return value.trim()
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function integer(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new SudoworkP2SourceError('INVALID_SOURCE', `${field} 必须为整数`)
  return parsed
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  return integer(value, 'nullable integer')
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return 0
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) throw new SudoworkP2SourceError('INVALID_SOURCE', `时间格式无效: ${value}`)
  return parsed
}

function escapes(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)
}

function invalidManifest(message: string): SudoworkP2SourceError {
  return new SudoworkP2SourceError('INVALID_MANIFEST', message)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

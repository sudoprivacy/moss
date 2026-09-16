import type { DatabaseSync } from 'node:sqlite'
import { migrationCommandContext } from '../application/commandContext.js'
import type { ImportedConfigItem } from '../api/compat/sudowork/configService.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import type { SudoworkSourceConfigItem } from './sudoworkP2SourceReader.js'

type SqlRow = Record<string, unknown>

interface P2ConfigurationSource {
  readConfigItems(): SudoworkSourceConfigItem[]
}

interface P2ConfigurationImporter {
  importConfigItem(actor: IdentityActor, input: ImportedConfigItem, context: ReturnType<typeof migrationCommandContext>): { id: number }
}

export interface P2ConfigurationMigrationIssue {
  sourceId: string
  reason: string
}

interface PlannedConfigItem {
  action: 'import' | 'reuse'
  source: SudoworkSourceConfigItem
  ownerOrgId: string
  assignedOrgIds: string[]
}

export interface P2ConfigurationMigrationPlan {
  status: 'ready' | 'blocked'
  counts: { source: number; imports: number; reuses: number }
  conflicts: P2ConfigurationMigrationIssue[]
  orphans: P2ConfigurationMigrationIssue[]
  items: PlannedConfigItem[]
}

export interface P2ConfigurationMigrationExecution {
  migrationRunId: string
  imported: number
  reused: number
  source: number
}

export class P2ConfigurationMigrationBlockedError extends Error {
  constructor(readonly report: P2ConfigurationMigrationPlan) {
    super(`P2 配置迁移预检失败: ${report.conflicts.length} 个冲突, ${report.orphans.length} 个孤儿`)
    this.name = 'P2ConfigurationMigrationBlockedError'
  }
}

export class P2ConfigurationMigrationService {
  constructor(private readonly options: {
    db: DatabaseSync
    identities: IdentityRepository
    config: P2ConfigurationImporter
    source: P2ConfigurationSource
    platformConfigOrgId: string
  }) {}

  plan(): P2ConfigurationMigrationPlan {
    const sourceItems = this.options.source.readConfigItems()
    const conflicts: P2ConfigurationMigrationIssue[] = []
    const orphans: P2ConfigurationMigrationIssue[] = []
    const items: PlannedConfigItem[] = []
    const sourceIds = new Set<number>()
    const sourceEntryIds = new Set<number>()

    for (const source of sourceItems) {
      if (sourceIds.has(source.id)) {
        conflicts.push({ sourceId: String(source.id), reason: `配置项 ID ${source.id} 在源数据中重复` })
        continue
      }
      sourceIds.add(source.id)
      if (source.status !== 0 && source.status !== 1) {
        conflicts.push({ sourceId: String(source.id), reason: `配置项状态无效: ${source.status}` })
        continue
      }

      let hasEntryConflict = false
      for (const entry of source.entries) {
        if (sourceEntryIds.has(entry.id)) {
          conflicts.push({ sourceId: String(source.id), reason: `配置字段 ID ${entry.id} 在源数据中重复` })
          hasEntryConflict = true
        }
        sourceEntryIds.add(entry.id)
      }
      if (hasEntryConflict) continue

      const assignedOrgIds: string[] = []
      for (const enterpriseId of new Set(source.enterpriseIds)) {
        const alias = this.options.identities.resolveNumericAliasGlobal('enterprise', enterpriseId)
        if (!alias || !this.options.identities.getOrganizationProfile(alias.resourceId)) {
          orphans.push({ sourceId: String(source.id), reason: `企业 ID ${enterpriseId} 未映射到 Moss Organization` })
        } else {
          assignedOrgIds.push(alias.resourceId)
        }
      }
      if (assignedOrgIds.length !== new Set(source.enterpriseIds).size) continue

      const alias = this.options.identities.resolveNumericAliasGlobal('config_item', source.id)
      if (alias) {
        const nativeId = numericResourceId(alias.resourceId)
        if (nativeId === null || !this.matchesExisting(nativeId, source, assignedOrgIds)) {
          conflicts.push({ sourceId: String(source.id), reason: '已有配置项 ID 映射与源数据不一致' })
          continue
        }
        items.push({ action: 'reuse', source, ownerOrgId: alias.orgId, assignedOrgIds })
        continue
      }

      const existing = this.options.db.prepare(`
        SELECT id FROM config_items
        WHERE org_id = ? AND (name = ? OR (? IS NOT NULL AND pinyin = ?))
        LIMIT 1
      `).get(this.options.platformConfigOrgId, source.name, source.pinyin, source.pinyin) as SqlRow | undefined
      if (existing) {
        conflicts.push({ sourceId: String(source.id), reason: `名称或拼音已被目标配置项 ${existing.id} 使用` })
        continue
      }

      const occupiedEntry = source.entries.find(entry =>
        this.options.identities.resolveNumericAliasGlobal('config_entry', entry.id) !== null)
      if (occupiedEntry) {
        conflicts.push({ sourceId: String(source.id), reason: `配置字段 ID ${occupiedEntry.id} 已被占用` })
        continue
      }
      items.push({
        action: 'import',
        source,
        ownerOrgId: this.options.platformConfigOrgId,
        assignedOrgIds,
      })
    }

    const imports = items.filter(item => item.action === 'import').length
    const reuses = items.filter(item => item.action === 'reuse').length
    return {
      status: conflicts.length || orphans.length ? 'blocked' : 'ready',
      counts: { source: sourceItems.length, imports, reuses },
      conflicts,
      orphans,
      items,
    }
  }

  execute(migrationRunId: string): P2ConfigurationMigrationExecution {
    const plan = this.plan()
    if (plan.status === 'blocked') throw new P2ConfigurationMigrationBlockedError(plan)
    const actor: IdentityActor = {
      userId: 'migration-system',
      orgId: this.options.platformConfigOrgId,
      role: 'super_admin',
    }
    let imported = 0
    let reused = 0
    for (const item of plan.items) {
      if (item.action === 'reuse') {
        reused += 1
        continue
      }
      this.options.config.importConfigItem(actor, {
        legacyId: item.source.id,
        ownerOrgId: item.ownerOrgId,
        assignedOrgIds: item.assignedOrgIds,
        name: item.source.name,
        description: item.source.description,
        icon: item.source.icon,
        pinyin: item.source.pinyin,
        urlPattern: item.source.urlPattern,
        scheme: item.source.scheme,
        bearerPrefix: item.source.bearerPrefix,
        visibleToAll: item.source.visibleToAll,
        status: item.source.status,
        createdAt: item.source.createdAt,
        updatedAt: item.source.updatedAt,
        entries: item.source.entries.map(entry => ({
          legacyId: entry.id,
          config_key: entry.configKey,
          name: entry.name,
          config_desc: entry.description ?? undefined,
          required: entry.required,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        })),
      }, migrationCommandContext(migrationRunId, `config-item:${item.source.id}`))
      imported += 1
    }
    return { migrationRunId, imported, reused, source: plan.counts.source }
  }

  private matchesExisting(nativeId: number, source: SudoworkSourceConfigItem, assignedOrgIds: string[]): boolean {
    const row = this.options.db.prepare('SELECT * FROM config_items WHERE id = ?').get(nativeId) as SqlRow | undefined
    if (!row) return false
    const expectedAvailability = source.visibleToAll ? 'all' : assignedOrgIds.length > 0 ? 'assigned' : 'organization'
    if (
      row.name !== source.name
      || nullable(row.description) !== source.description
      || nullable(row.icon) !== source.icon
      || nullable(row.pinyin) !== source.pinyin
      || nullable(row.url_pattern) !== source.urlPattern
      || nullable(row.scheme) !== source.scheme
      || nullable(row.bearer_prefix) !== source.bearerPrefix
      || Number(row.status) !== source.status
      || row.availability !== expectedAvailability
    ) return false

    const assigned = (this.options.db.prepare(`
      SELECT org_id FROM config_item_org_assignments WHERE config_item_id = ? ORDER BY org_id
    `).all(nativeId) as Array<{ org_id: string }>).map(item => item.org_id)
    if (!sameStrings(assigned, assignedOrgIds)) return false

    const entries = this.options.db.prepare(`
      SELECT * FROM config_entries WHERE config_item_id = ? ORDER BY config_key
    `).all(nativeId) as SqlRow[]
    if (entries.length !== source.entries.length) return false
    const sourceByKey = new Map(source.entries.map(entry => [entry.configKey, entry]))
    return entries.every(entry => {
      const expected = sourceByKey.get(String(entry.config_key))
      if (!expected) return false
      const alias = this.options.identities.getNumericAlias('config_entry', String(entry.id))
      return alias === expected.id
        && entry.name === expected.name
        && nullable(entry.config_desc) === expected.description
        && Number(entry.required) === (expected.required ? 1 : 0)
    })
  }
}

function numericResourceId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function sameStrings(left: string[], right: string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0')
}

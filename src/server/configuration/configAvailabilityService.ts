import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'

type Availability = 'organization' | 'all' | 'assigned'
type Row = Record<string, unknown>

export class ConfigAvailabilityService {
  constructor(private readonly db: DatabaseSync) {}

  get(configItemId: number): {
    availability: Availability
    ownerOrgId: string
    organizationIds: string[]
    organizations: Array<{ id: string; name: string }>
  } {
    const item = this.item(configItemId)
    return {
      availability: String(item.availability) as Availability,
      ownerOrgId: String(item.org_id),
      organizationIds: (this.db.prepare(`
        SELECT org_id FROM config_item_org_assignments
        WHERE config_item_id = ? ORDER BY org_id
      `).all(configItemId) as Row[]).map(row => String(row.org_id)),
      organizations: (this.db.prepare('SELECT id, name FROM organizations ORDER BY name, id').all() as Row[])
        .map(row => ({ id: String(row.id), name: String(row.name) })),
    }
  }

  replace(configItemId: number, input: {
    availability: Availability
    organizationIds: readonly string[]
  }): void {
    if (!['organization', 'all', 'assigned'].includes(input.availability)) throw new Error('可见范围无效')
    const item = this.item(configItemId)
    if (item.scope === 'user') throw new Error('用户级配置项不能设置组织授权')
    const organizationIds = [...new Set(input.organizationIds.map(id => id.trim()).filter(Boolean))].sort()
    if (input.availability === 'assigned' && organizationIds.length === 0) throw new Error('指定组织不能为空')
    if (input.availability !== 'assigned' && organizationIds.length > 0) throw new Error('非指定组织模式不能包含组织列表')
    const known = new Set((this.db.prepare('SELECT id FROM organizations').all() as Row[]).map(row => String(row.id)))
    const missing = organizationIds.filter(id => !known.has(id))
    if (missing.length > 0) throw new Error(`组织不存在: ${missing.join(', ')}`)

    runInTransaction(this.db, () => {
      this.db.prepare('DELETE FROM config_item_org_assignments WHERE config_item_id = ?').run(configItemId)
      const insert = this.db.prepare(`
        INSERT INTO config_item_org_assignments (config_item_id, org_id, created_at)
        VALUES (?, ?, ?)
      `)
      const timestamp = Date.now()
      for (const orgId of organizationIds) insert.run(configItemId, orgId, timestamp)
      this.db.prepare('UPDATE config_items SET availability = ?, updated_at = ? WHERE id = ?')
        .run(input.availability, timestamp, configItemId)
    })
  }

  private item(configItemId: number): Row {
    const item = this.db.prepare('SELECT id, scope, org_id, availability FROM config_items WHERE id = ?')
      .get(configItemId) as Row | undefined
    if (!item) throw new Error('配置项不存在')
    if (!item.org_id) throw new Error('配置项缺少所属组织')
    return item
  }
}

import type { DbDriver } from '../db/driver.js'

type Availability = 'organization' | 'all' | 'assigned'
type Row = Record<string, unknown>

export class ConfigAvailabilityService {
  constructor(private readonly driver: DbDriver) {}

  async get(configItemId: number): Promise<{
    availability: Availability
    ownerOrgId: string
    organizationIds: string[]
    organizations: Array<{ id: string; name: string }>
  }> {
    const item = await this.item(configItemId)
    return {
      availability: String(item.availability) as Availability,
      ownerOrgId: String(item.org_id),
      organizationIds: (await this.driver.all<Row>(`
        SELECT org_id FROM config_item_org_assignments
        WHERE config_item_id = ? ORDER BY org_id
      `, [configItemId])).map(row => String(row.org_id)),
      organizations: (await this.driver.all<Row>('SELECT id, name FROM organizations ORDER BY name, id'))
        .map(row => ({ id: String(row.id), name: String(row.name) })),
    }
  }

  async replace(configItemId: number, input: {
    availability: Availability
    organizationIds: readonly string[]
  }): Promise<void> {
    if (!['organization', 'all', 'assigned'].includes(input.availability)) throw new Error('可见范围无效')
    return this.replaceAsync(configItemId, input)
  }

  private async replaceAsync(configItemId: number, input: {
    availability: Availability
    organizationIds: readonly string[]
  }): Promise<void> {
    const item = await this.item(configItemId)
    if (item.scope === 'user') throw new Error('用户级配置项不能设置组织授权')
    const organizationIds = [...new Set(input.organizationIds.map(id => id.trim()).filter(Boolean))].sort()
    if (input.availability === 'assigned' && organizationIds.length === 0) throw new Error('指定组织不能为空')
    if (input.availability !== 'assigned' && organizationIds.length > 0) throw new Error('非指定组织模式不能包含组织列表')
    const known = new Set((await this.driver.all<Row>('SELECT id FROM organizations')).map(row => String(row.id)))
    const missing = organizationIds.filter(id => !known.has(id))
    if (missing.length > 0) throw new Error(`组织不存在: ${missing.join(', ')}`)

    await this.driver.transaction(async () => {
      await this.driver.run('DELETE FROM config_item_org_assignments WHERE config_item_id = ?', [configItemId])
      const timestamp = Date.now()
      for (const orgId of organizationIds) {
        await this.driver.run(`
          INSERT INTO config_item_org_assignments (config_item_id, org_id, created_at)
          VALUES (?, ?, ?)
        `, [configItemId, orgId, timestamp])
      }
      await this.driver.run(
        'UPDATE config_items SET availability = ?, updated_at = ? WHERE id = ?',
        [input.availability, timestamp, configItemId],
      )
    })
  }

  private async item(configItemId: number): Promise<Row> {
    const item = await this.driver.get<Row>(
      'SELECT id, scope, org_id, availability FROM config_items WHERE id = ?',
      [configItemId],
    )
    if (!item) throw new Error('配置项不存在')
    if (!item.org_id) throw new Error('配置项缺少所属组织')
    return item
  }
}

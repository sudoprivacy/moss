import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { ConfigAvailabilityService } from './configAvailabilityService.js'

async function setup() {
  const db = new DatabaseSync(':memory:')
  const auth = new AuthCenterDb(db)
  await auth.createOrganization('org-a', '企业 A', 1)
  await auth.createOrganization('org-b', '企业 B', 1)
  createIdentityTestRepository(db, {}, auth.driver)
  db.exec(`CREATE TABLE config_items (
    id INTEGER PRIMARY KEY, scope TEXT NOT NULL, org_id TEXT,
    availability TEXT NOT NULL DEFAULT 'organization', updated_at INTEGER NOT NULL
  )`)
  db.prepare("INSERT INTO config_items VALUES (1, 'system', 'org-a', 'organization', 1)").run()
  db.exec(`CREATE TABLE config_item_org_assignments (
    config_item_id INTEGER NOT NULL, org_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (config_item_id, org_id)
  )`)
  return { db, service: new ConfigAvailabilityService(auth.driver) }
}

void describe('ConfigAvailabilityService', () => {
  void test('超级管理员原子替换指定组织授权', async () => {
    const { db, service } = await setup()
    await service.replace(1, { availability: 'assigned', organizationIds: ['org-b'] })
    assert.deepEqual(await service.get(1), {
      availability: 'assigned', ownerOrgId: 'org-a', organizationIds: ['org-b'],
      organizations: [{ id: 'org-a', name: '企业 A' }, { id: 'org-b', name: '企业 B' }],
    })
    db.close()
  })

  void test('未知组织或 user scope 时拒绝且不留下部分写入', async () => {
    const { db, service } = await setup()
    await assert.rejects(service.replace(1, { availability: 'assigned', organizationIds: ['org-b', 'missing'] }), /组织不存在/)
    assert.equal((await service.get(1)).availability, 'organization')
    db.prepare("UPDATE config_items SET scope = 'user' WHERE id = 1").run()
    await assert.rejects(service.replace(1, { availability: 'all', organizationIds: [] }), /用户级/)
    db.close()
  })
})

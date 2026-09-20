import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'

function createLegacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO organizations VALUES ('org-a', 'A', 1), ('org-b', 'B', 1), ('org-c', 'C', 1);
    CREATE TABLE organization_profiles (
      org_id TEXT PRIMARY KEY REFERENCES organizations(id),
      code TEXT NOT NULL UNIQUE,
      login_method TEXT NOT NULL,
      local_enabled INTEGER NOT NULL,
      cloud_enabled INTEGER NOT NULL,
      logo TEXT, app_name TEXT, top_name TEXT, about_name TEXT,
      app_company_name TEXT, login_description TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO organization_profiles (
      org_id, code, login_method, local_enabled, cloud_enabled, created_at, updated_at
    ) VALUES
      ('org-a', 'A', 'password', 1, 1, 1, 1),
      ('org-b', 'B', 'password', 1, 1, 1, 1);
  `)
  return db
}

void describe('Organization 企业自动化策略', () => {
  void it('升级旧 Profile 时继承旧全局开关，之后各组织独立修改', async () => {
    const repository = createIdentityTestRepository(createLegacyDatabase(), {
      legacyClientCronEnabled: false,
    })

    assert.equal((await repository.getOrganizationProfile('org-a'))?.clientCronEnabled, false)
    assert.equal((await repository.getOrganizationProfile('org-b'))?.clientCronEnabled, false)

    await repository.setOrganizationClientCronEnabled('org-a', true)

    assert.equal((await repository.getOrganizationProfile('org-a'))?.clientCronEnabled, true)
    assert.equal((await repository.getOrganizationProfile('org-b'))?.clientCronEnabled, false)
  })

  void it('新 Organization 默认允许本地 Cron，更新其他资料不会覆盖策略', async () => {
    const repository = createIdentityTestRepository(createLegacyDatabase())
    await repository.putOrganizationProfile({
      orgId: 'org-c', code: 'C', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
    })
    assert.equal((await repository.getOrganizationProfile('org-c'))?.clientCronEnabled, true)

    await repository.setOrganizationClientCronEnabled('org-c', false)
    await repository.putOrganizationProfile({
      orgId: 'org-c', code: 'C', loginMethod: 'cas', localEnabled: true, cloudEnabled: true,
    })

    assert.equal((await repository.getOrganizationProfile('org-c'))?.clientCronEnabled, false)
  })
})

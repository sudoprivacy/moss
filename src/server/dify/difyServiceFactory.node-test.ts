import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AuthService } from '../auth/service.js'
import { AuthCenterDb } from '../authCenter/db.js'
import {
  createCatalogTestRepository,
  createDifyTestRepository,
  createIdentityTestRepository,
} from '../testing/compatibilityRepositories.js'
import { DifyAdministrationService } from './difyAdministrationService.js'
import { DifyDatasetService } from './difyDatasetService.js'
import { DifyEnhancementService } from './difyEnhancementService.js'
import { DifyRuntimeService } from './difyRuntimeService.js'

void test('AuthService creates one unified Dify service graph for Sudowork compatibility', async () => {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  await authDb.createOrganization('org-a', 'Organization A', Date.now())
  createIdentityTestRepository(db, {}, authDb.driver)
  createCatalogTestRepository(db, authDb.driver)
  createDifyTestRepository(db, authDb.driver)
  const auth = new AuthService(authDb, 3600)
  const services = auth.createSudoworkDifyServices({
    baseUrl: 'https://dify.example.test',
    systemToken: 'system-token',
    provisionSecret: 'provision-secret',
    ssoSecret: 'sso-secret',
    publicBaseUrl: 'https://moss.example.test',
    artifactsRoot: '/tmp/moss-dify-factory-test',
    secrets: {
      async putSecret() {},
      async getSecret() { return null },
      async deleteSecret() {},
    },
  })

  assert(services.runtime instanceof DifyRuntimeService)
  assert(services.enhancement instanceof DifyEnhancementService)
  assert(services.dataset instanceof DifyDatasetService)
  assert(services.administration instanceof DifyAdministrationService)
  assert.equal(await services.resolveEnterpriseAlias(404), null)
  assert.deepEqual(await services.buildVisibility({ userId: 'u', orgId: 'org-a', role: 'admin' }), {
    userId: 'u', role: 'admin', departmentId: null, visibleDepartmentIds: null, isAdmin: true,
  })
  auth.destroy()
  db.close()
})

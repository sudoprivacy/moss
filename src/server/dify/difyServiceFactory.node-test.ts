import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AuthService } from '../auth/service.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { DifyAdministrationService } from './difyAdministrationService.js'
import { DifyDatasetService } from './difyDatasetService.js'
import { DifyEnhancementService } from './difyEnhancementService.js'
import { DifyRuntimeService } from './difyRuntimeService.js'

test('AuthService creates one unified Dify service graph for Sudowork compatibility', () => {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  authDb.createOrganization('org-a', 'Organization A', Date.now())
  db.exec(`
    CREATE TABLE tenant_assistants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
      version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT DEFAULT 'pending',
      source_url TEXT, checksum TEXT, file_path TEXT, enabled_skills TEXT,
      publish_note TEXT, review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
      enabled INTEGER DEFAULT 1, visible_to TEXT, org_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE tenant_skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
      version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT DEFAULT 'pending',
      source_url TEXT, checksum TEXT, file_path TEXT, publish_note TEXT,
      review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
      enabled INTEGER DEFAULT 1, visible_to TEXT, org_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
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
  assert.equal(services.resolveEnterpriseAlias(404), null)
  assert.deepEqual(services.buildVisibility({ userId: 'u', orgId: 'org-a', role: 'admin' }), {
    userId: 'u', role: 'admin', departmentId: null, visibleDepartmentIds: null, isAdmin: true,
  })
  auth.destroy()
  db.close()
})

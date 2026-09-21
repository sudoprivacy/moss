import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import type { NexusClient } from '../nexus/nexusClient.js'
import { resolveConfigurationActor, ConfigurationScopeError } from './adminScope.js'
import { SqliteDriver } from '../db/driver.js'

const testHome = mkdtempSync(join(os.tmpdir(), 'moss-model-policy-test-'))
const originalHome = os.homedir
os.homedir = () => testHome
syncBuiltinESMExports()
const settings = await import('../systemSettings.js')
const { ConfigStore, initConfigStore, organizationConfigKey } = await import('../configStore/configStore.js')
const { OrganizationModelSettingsRepository, ensureOrganizationModelSettingsSchema } = await import('./organizationModelSettingsRepository.js')
const { migrateLegacyModelSettings } = await import('./migrateLegacyModelSettings.js')
const { getModelsForSelection } = await import('../modelListCache.js')
assert.equal(settings.SYSTEM_SETTINGS_PATH, join(testHome, '.moss', 'settings.json'))

const records = new Map<string, { value: string }>()
let failKey: string | undefined
const client = {
  async getSecret(namespace: string, key: string) { return records.get(`${namespace}:${key}`) ?? null },
  async putSecret(namespace: string, key: string, value: string) {
    records.set(`${namespace}:${key}`, { value })
    if (failKey === key) {
      failKey = undefined
      throw new Error('Nexus write failure')
    }
  },
  async deleteSecret(namespace: string, key: string) { records.delete(`${namespace}:${key}`) },
} as unknown as NexusClient
const store: InstanceType<typeof ConfigStore> = initConfigStore(client)
const originalFetch = globalThis.fetch
const envKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const
const originalEnv = envKeys.map(key => process.env[key])

beforeEach(async () => {
  failKey = undefined
  for (const key of store.keys()) await store.remove(key)
  for (const key of envKeys) delete process.env[key]
  rmSync(settings.SYSTEM_SETTINGS_PATH, { force: true, recursive: true })
})
after(() => {
  os.homedir = originalHome
  syncBuiltinESMExports()
  globalThis.fetch = originalFetch
  envKeys.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[index]
  })
  rmSync(testHome, { recursive: true, force: true })
})

function database() {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-a'), ('org-b')")
  ensureOrganizationModelSettingsSchema(db)
  const driver = new SqliteDriver(db)
  return { db, driver, repository: new OrganizationModelSettingsRepository(driver) }
}

void test('root can explicitly manage home organization or platform; org admin cannot select platform', () => {
  const root = { userId: 'root', role: 'super_admin', orgId: 'org-a' }
  assert.equal(resolveConfigurationActor(root, null).organizationScoped, true)
  assert.equal(resolveConfigurationActor(root, 'organization').orgId, 'org-a')
  assert.equal(resolveConfigurationActor(root, 'platform').organizationScoped, false)
  assert.throws(() => resolveConfigurationActor({ ...root, role: 'admin' }, 'platform'),
    error => error instanceof ConfigurationScopeError && error.statusCode === 403)
  assert.throws(() => resolveConfigurationActor(root, 'other'),
    error => error instanceof ConfigurationScopeError && error.statusCode === 400)
})

void test('migrates text, image and provider credentials only to default org and starts its authenticated model catalog', async () => {
  const { db, driver, repository } = database()
  try {
    await settings.updateSystemSettings({
      apiKey: 'legacy-text', image: { apiKey: 'legacy-image', model: 'image-model' }, model: 'fixture-model',
      modelProviders: [{ id: 'private', name: 'Private', baseUrl: 'https://example.invalid/v1', enabled: true, apiKey: 'private-key' }],
      defaultModelProviderId: 'private',
    })
    await migrateLegacyModelSettings(driver, 'org-a')
    const org = await settings.getOrganizationSystemSettings('org-a', repository)
    const other = await settings.getOrganizationSystemSettings('org-b', repository)
    assert.equal(org.apiKey, 'legacy-text')
    assert.equal(org.image.apiKey, 'legacy-image')
    assert.equal(other.apiKeyConfigured, false)
    assert.equal(other.image.apiKeyConfigured, false)
    assert.equal(other.modelProviders[0]?.apiKeyConfigured, false)
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-key')
      return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
    }) as typeof fetch
    const catalog = await getModelsForSelection('fixture-model', { orgId: 'org-a', settings: org })
    assert.equal(catalog.selection.provider.id, 'private')
    const publicSettings = await settings.getOrganizationSystemSettings('org-a', repository, { redactSecrets: true })
    assert.equal(publicSettings.scopeType, 'organization')
    assert.equal(publicSettings.organizationId, 'org-a')
    assert.equal(publicSettings.apiKey, '')
    assert.equal(publicSettings.image.apiKey, '')
    assert(!JSON.stringify(publicSettings).includes('private-key'))
    assert(!JSON.stringify(await repository.get('org-a')).includes('legacy-text'))
    await settings.updateOrganizationSystemSettings('org-a', repository, { apiKey: '', image: { apiKey: '' }, modelProviders: [] }, 'admin')
    await migrateLegacyModelSettings(driver, 'org-a')
    await migrateLegacyModelSettings(driver, 'org-b')
    assert.equal((await settings.getOrganizationSystemSettings('org-a', repository)).apiKeyConfigured, false)
    assert.equal((await settings.getOrganizationSystemSettings('org-b', repository)).apiKeyConfigured, false)
  } finally { db.close() }
})

void test('migration respects previously configured or explicitly cleared organization credentials', async () => {
  const { db, driver, repository } = database()
  try {
    await settings.updateSystemSettings({ apiKey: 'platform-key' })
    await settings.updateOrganizationSystemSettings('org-a', repository, { apiKey: '' }, 'admin')
    await migrateLegacyModelSettings(driver, 'org-a')
    assert.equal((await settings.getOrganizationSystemSettings('org-a', repository)).apiKeyConfigured, false)
  } finally { db.close() }
})

void test('fresh installation marker prevents later platform credentials from becoming organization credentials', async () => {
  const { db, driver, repository } = database()
  try {
    await migrateLegacyModelSettings(driver, 'org-a')
    await settings.updateSystemSettings({ apiKey: 'later-platform-key' })
    await migrateLegacyModelSettings(driver, 'org-a')
    assert.equal((await settings.getOrganizationSystemSettings('org-a', repository)).apiKeyConfigured, false)
    await settings.updateOrganizationSystemSettings('org-a', repository, { apiKey: 'installer-org-key' }, 'installer')
    const own = await settings.getOrganizationSystemSettings('org-a', repository, { redactSecrets: true })
    const platform = await settings.getOrganizationSystemSettings(undefined, repository, { redactSecrets: true })
    assert.equal(own.apiKeyConfigured, true)
    assert.equal(platform.scopeType, 'platform')
    assert.equal(platform.apiKey, '')
    assert.equal(store.get(organizationConfigKey('org-a', 'settings.anthropic-auth-token')), 'installer-org-key')
  } finally { db.close() }
})

void test('organization multi-key and database failures restore earlier credential writes', async () => {
  const { db, repository } = database()
  try {
    await settings.updateOrganizationSystemSettings('org-a', repository, { apiKey: 'old-text', image: { apiKey: 'old-image' } }, 'admin')
    failKey = organizationConfigKey('org-a', 'settings.image-api-key')
    await assert.rejects(settings.updateOrganizationSystemSettings('org-a', repository, {
      apiKey: 'new-text', image: { apiKey: 'new-image' },
    }, 'admin'), /Nexus write failure/)
    assert.equal((await settings.getOrganizationSystemSettings('org-a', repository)).apiKey, 'old-text')
    failKey = undefined
    db.exec("CREATE TRIGGER fail_model_update BEFORE UPDATE ON organization_model_settings BEGIN SELECT RAISE(ABORT, 'DB rejected'); END")
    await assert.rejects(settings.updateOrganizationSystemSettings('org-a', repository, {
      apiKey: 'new-text', image: { apiKey: 'new-image' }, model: 'new-model',
    }, 'admin'), /DB rejected/)
    const after = await settings.getOrganizationSystemSettings('org-a', repository)
    assert.equal(after.apiKey, 'old-text')
    assert.equal(after.image.apiKey, 'old-image')
  } finally { db.close() }
})

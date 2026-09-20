// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import { after, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'

const settingsHome = mkdtempSync(join(tmpdir(), 'moss-enterprise-settings-'))
const homeMock = mock.method(os, 'homedir', () => settingsHome)
const { DirectConnectStore } = await import('../db.js')
const { createEnterpriseApi } = await import('../api/enterprise.js')
const { getSystemSettings, updateSystemSettings, SYSTEM_SETTINGS_PATH } = await import('../systemSettings.js')
const { AuthCenterDb } = await import('../authCenter/db.js')
const { IdentityRepository } = await import('../identity/identityRepository.js')
const { migrateLegacyEnterpriseCronPolicy } = await import('../migration/legacyEnterpriseCronPolicy.js')
assert.equal(SYSTEM_SETTINGS_PATH, join(settingsHome, '.moss', 'settings.json'))
beforeEach(async () => { await updateSystemSettings({ clientCronEnabled: true }) })
after(() => {
  homeMock.mock.restore()
  rmSync(settingsHome, { recursive: true, force: true })
})

describe('enterprise configuration organization isolation', () => {
  it('keeps organization writes isolated and retains the legacy default as a fallback', async () => {
    const store = new DirectConnectStore(':memory:')
    await store.updateEnterprise('org-a', { app_name: 'Organization A', top_name: 'A' })

    assert.equal((await store.getEnterprise('org-a')).app_name, 'Organization A')
    assert.equal((await store.getEnterprise('org-a')).top_name, 'A')
    assert.equal((await store.getEnterprise('org-b')).app_name, null)
    assert.equal((await store.getEnterprise('org-b')).top_name, null)
    assert.equal((await store.getEnterprise()).app_name, null)

    await store.updateEnterprise('org-b', { app_name: 'Organization B', top_name: 'B' })

    assert.equal((await store.getEnterprise('org-a')).app_name, 'Organization A')
    assert.equal((await store.getEnterprise('org-b')).app_name, 'Organization B')
    assert.equal((await store.getEnterprise()).app_name, null)
  })

  it('copies pre-migration defaults only when an organization first saves', async () => {
    const store = new DirectConnectStore(':memory:')
    store.db.prepare(`
      UPDATE enterprises SET app_name = ?, top_name = ? WHERE id = 'default'
    `).run('Legacy deployment name', 'Legacy')

    // Read-only tenants still inherit the public deployment default.
    assert.equal((await store.getEnterprise('org-a')).app_name, 'Legacy deployment name')

    await store.updateEnterprise('org-a', { top_name: 'Organization A' })

    assert.equal((await store.getEnterprise('org-a')).app_name, 'Legacy deployment name')
    assert.equal((await store.getEnterprise('org-a')).top_name, 'Organization A')
    assert.equal((await store.getEnterprise('org-b')).top_name, 'Legacy')
    assert.equal((await store.getEnterprise()).top_name, 'Legacy')
  })
})

describe('legacy enterprise cron migration', () => {
  function setup() {
    const store = new DirectConnectStore(':memory:')
    new AuthCenterDb(store.db)
    const identities = new IdentityRepository(store.db)
    const addOrg = (orgId: string) => {
      store.db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run(orgId, orgId, Date.now())
      identities.putOrganizationProfile({
        orgId, code: orgId, loginMethod: 'password', localEnabled: true, cloudEnabled: true,
      })
    }
    const hooks = {
      getClientCronEnabled: (orgId: string) => identities.getOrganizationProfile(orgId)?.clientCronEnabled ?? true,
      setClientCronEnabled: (orgId: string, enabled: boolean) => identities.setOrganizationClientCronEnabled(orgId, enabled),
    }
    return { store, identities, addOrg, hooks }
  }

  it('imports each old effective override once, preserving later policy edits and new org defaults', async () => {
    const { store, identities, addOrg, hooks } = setup()
    try {
      for (const orgId of ['org-a', 'org-b', 'org-inherited', 'org-null']) addOrg(orgId)
      await store.updateEnterprise('default', { client_cron_enabled: false })
      await store.updateEnterprise('org-a', { client_cron_enabled: false })
      await store.updateEnterprise('org-b', { client_cron_enabled: true })
      await store.updateEnterprise('org-null', { client_cron_enabled: null })

      const api = createEnterpriseApi(store, settingsHome, hooks)
      for (const [orgId, expected] of [
        ['org-a', false], ['org-b', true], ['org-inherited', false], ['org-null', true],
      ] as const) {
        assert.equal(identities.getOrganizationProfile(orgId)?.clientCronEnabled, expected, orgId)
        assert.equal((await api.getEffectivePolicy(orgId)).clientCronEnabled, expected, orgId)
      }

      await api.updateConfig('org-a', { client_cron_enabled: true })
      identities.setOrganizationClientCronEnabled('org-b', false)
      addOrg('org-new')
      // A later branding save can copy the legacy column; it must never reapply policy.
      await store.updateEnterprise('org-new', { app_name: 'New organization' })
      const restarted = createEnterpriseApi(store, settingsHome, hooks)
      assert.equal(migrateLegacyEnterpriseCronPolicy(store.db), 0)
      assert.equal((await restarted.getEffectivePolicy('org-a')).clientCronEnabled, true)
      assert.equal((await restarted.getEffectivePolicy('org-b')).clientCronEnabled, false)
      assert.equal((await restarted.getEffectivePolicy('org-new')).clientCronEnabled, true)
      assert.equal((await store.getEnterprise('org-a')).client_cron_enabled, false)
    } finally {
      await store.close()
    }
  })

  it('leaves no-hook embeddings and their legacy values unmigrated', async () => {
    const { store, identities, addOrg, hooks } = setup()
    try {
      addOrg('org-a')
      await store.updateEnterprise('org-a', { client_cron_enabled: false })
      const legacy = createEnterpriseApi(store, settingsHome)
      assert.equal((await legacy.getEffectivePolicy('org-a')).clientCronEnabled, false)
      assert.equal(identities.getOrganizationProfile('org-a')?.clientCronEnabled, true)
      assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'enterprise_cron_policy_migrations'").get(), undefined)
      createEnterpriseApi(store, settingsHome, hooks)
      assert.equal(identities.getOrganizationProfile('org-a')?.clientCronEnabled, false)
      assert.equal((await legacy.getEffectivePolicy('org-a')).clientCronEnabled, false)
    } finally {
      await store.close()
    }
  })

  it('preserves preexisting profile restrictions despite legacy default or tenant true', async () => {
    const { store, identities, addOrg, hooks } = setup()
    try {
      for (const orgId of ['org-inherited', 'org-explicit']) {
        addOrg(orgId)
        identities.setOrganizationClientCronEnabled(orgId, false)
      }
      await store.updateEnterprise('default', { client_cron_enabled: true })
      await store.updateEnterprise('org-explicit', { client_cron_enabled: true })
      const api = createEnterpriseApi(store, settingsHome, hooks)
      for (const orgId of ['org-inherited', 'org-explicit']) {
        assert.equal((await api.getEffectivePolicy(orgId)).clientCronEnabled, false)
        await api.updateConfig(orgId, { client_cron_enabled: true })
      }
      createEnterpriseApi(store, settingsHome, hooks)
      assert.equal(identities.getOrganizationProfile('org-inherited')?.clientCronEnabled, true)
      assert.equal(identities.getOrganizationProfile('org-explicit')?.clientCronEnabled, true)
    } finally {
      await store.close()
    }
  })

  it('does not mark migration before profiles exist or before existing organizations are seeded', async () => {
    const store = new DirectConnectStore(':memory:')
    try {
      await store.updateEnterprise('default', { client_cron_enabled: false })
      new AuthCenterDb(store.db)
      store.db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run('org-a', 'A', 1)
      const hooks = { getClientCronEnabled: () => true, setClientCronEnabled: () => {} }
      createEnterpriseApi(store, settingsHome, hooks)
      assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'enterprise_cron_policy_migrations'").get(), undefined)

      const identities = new IdentityRepository(store.db)
      assert.throws(() => createEnterpriseApi(store, settingsHome, hooks), /profiles must be initialized/)
      identities.putOrganizationProfile({
        orgId: 'org-a', code: 'A', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
      })
      const api = createEnterpriseApi(store, settingsHome, {
        getClientCronEnabled: orgId => identities.getOrganizationProfile(orgId)?.clientCronEnabled ?? true,
        setClientCronEnabled: (orgId, enabled) => identities.setOrganizationClientCronEnabled(orgId, enabled),
      })
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, false)
      assert.equal(migrateLegacyEnterpriseCronPolicy(store.db), 0)
    } finally {
      await store.close()
    }
  })

  it('rolls back profile changes and the marker on failure so the next attempt retries', async () => {
    const { store, identities, addOrg } = setup()
    try {
      addOrg('org-a')
      addOrg('org-b')
      await store.updateEnterprise('default', { client_cron_enabled: false })
      store.db.exec(`
        CREATE TRIGGER fail_cron_migration BEFORE UPDATE OF client_cron_enabled ON organization_profiles
        WHEN NEW.org_id = 'org-b' BEGIN SELECT RAISE(ABORT, 'migration failed'); END
      `)
      assert.throws(() => migrateLegacyEnterpriseCronPolicy(store.db), /migration failed/)
      assert.equal(identities.getOrganizationProfile('org-a')?.clientCronEnabled, true)
      assert.equal(identities.getOrganizationProfile('org-b')?.clientCronEnabled, true)
      store.db.exec('DROP TRIGGER fail_cron_migration')
      assert.equal(migrateLegacyEnterpriseCronPolicy(store.db), 2)
      assert.equal(identities.getOrganizationProfile('org-a')?.clientCronEnabled, false)
      assert.equal(identities.getOrganizationProfile('org-b')?.clientCronEnabled, false)
    } finally {
      await store.close()
    }
  })

  it('keeps global AND organization semantics without copying the global switch into profiles', async () => {
    const { store, identities, addOrg, hooks } = setup()
    try {
      addOrg('org-a')
      await updateSystemSettings({ clientCronEnabled: false })
      const api = createEnterpriseApi(store, settingsHome, hooks)
      assert.equal(identities.getOrganizationProfile('org-a')?.clientCronEnabled, true)
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, false)
      await updateSystemSettings({ clientCronEnabled: true })
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, true)
      identities.setOrganizationClientCronEnabled('org-a', false)
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, false)
      await store.updateEnterprise('default', { client_cron_enabled: true })
      await updateSystemSettings({ clientCronEnabled: false })
      assert.equal((await createEnterpriseApi(store, settingsHome).getEffectivePolicy()).clientCronEnabled, false)
    } finally {
      await store.close()
    }
  })
})

describe('enterprise configuration API', () => {
  it('uses the server-supplied organization id for reads and writes', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-config-'))
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir)
      await api.updateConfig('org-a', { app_name: 'Organization A' })
      await api.updateConfig('org-b', { app_name: 'Organization B' })

      const orgA = await api.getConfig('org-a')
      const orgB = await api.getConfig('org-b')
      const publicDefault = await api.getConfig()

      assert.equal(orgA.success, true)
      assert.ok(orgA.data)
      assert.ok(orgB.data)
      assert.ok(publicDefault.data)
      assert.equal(orgA.data.app_name, 'Organization A')
      assert.equal(orgB.data.app_name, 'Organization B')
      assert.equal(publicDefault.data.app_name, null)
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('uses organization-scoped client policy before deployment defaults', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-policy-'))
    const orgPolicies = new Map<string, Record<string, unknown>>()
    const cronEnabled = new Map<string, boolean>()
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir, {
        getClientCronEnabled: orgId => cronEnabled.get(orgId) ?? true,
        setClientCronEnabled: (orgId, enabled) => { cronEnabled.set(orgId, enabled) },
        getClientPolicy: orgId => orgId ? orgPolicies.get(orgId) ?? {} : {},
        putClientPolicy: (orgId, patch) => {
          orgPolicies.set(orgId, { ...(orgPolicies.get(orgId) ?? {}), ...patch })
        },
      })

      await api.updateConfig('org-a', {
        client_cron_enabled: false,
        client_show_tool_calls: false,
        workspace_upload_limit_bytes: 4096,
      }, 'admin-a')

      const orgA = await api.getConfig('org-a')
      const orgB = await api.getConfig('org-b')

      assert.ok(orgA.data)
      assert.ok(orgB.data)
      assert.equal(orgA.data.client_cron_enabled, false)
      assert.equal(orgA.data.client_show_tool_calls, false)
      assert.equal(orgA.data.workspace_upload_limit_bytes, 4096)
      assert.equal(orgB.data.client_cron_enabled, true)
      assert.equal(orgB.data.client_show_tool_calls, true)
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('keeps no-hook cron read-after-write on the legacy enterprise store', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-no-hook-'))
    const original = getSystemSettings()
    try {
      await updateSystemSettings({ clientCronEnabled: true })
      const store = new DirectConnectStore(':memory:')
      await store.updateEnterprise('org-a', { client_cron_enabled: false } as never)
      const api = createEnterpriseApi(store, runtimeDir)

      assert.equal((await api.getConfig('org-a')).data?.client_cron_enabled, false)
      await api.updateConfig('org-a', { client_cron_enabled: true })
      assert.equal((await api.getConfig('org-a')).data?.client_cron_enabled, true)
      await api.updateConfig({ client_cron_enabled: false }, 'org-a')
      assert.equal((await api.getConfig('org-a')).data?.client_cron_enabled, false)
    } finally {
      await updateSystemSettings({ clientCronEnabled: original.clientCronEnabled })
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('rejects invalid workspace upload limits instead of widening to defaults', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-upload-limit-'))
    const orgPolicies = new Map<string, Record<string, unknown>>()
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir, {
        getClientPolicy: orgId => orgId ? orgPolicies.get(orgId) ?? {} : {},
        putClientPolicy: (orgId, patch) => {
          orgPolicies.set(orgId, { ...(orgPolicies.get(orgId) ?? {}), ...patch })
        },
      })
      orgPolicies.set('org-a', { workspaceUploadLimitBytes: 4 * 1024 * 1024 })

      for (const invalid of [0, -1, '4096', Number.NaN, 1024 * 1024 * 1024 + 1]) {
        const response = await api.updateConfig('org-a', { workspace_upload_limit_bytes: invalid }, 'admin-a')
        assert.equal(response.success, false)
        assert.equal(orgPolicies.get('org-a')?.workspaceUploadLimitBytes, 4 * 1024 * 1024)
      }
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('validates all client policy fields before writing any organization override', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-atomic-policy-'))
    const orgPolicies = new Map<string, Record<string, unknown>>()
    const cronEnabled = new Map<string, boolean>()
    let cronWrites = 0
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir, {
        getClientCronEnabled: orgId => cronEnabled.get(orgId) ?? true,
        setClientCronEnabled: (orgId, enabled) => {
          cronWrites += 1
          cronEnabled.set(orgId, enabled)
        },
        getClientPolicy: orgId => orgId ? orgPolicies.get(orgId) ?? {} : {},
        putClientPolicy: (orgId, patch) => {
          orgPolicies.set(orgId, { ...(orgPolicies.get(orgId) ?? {}), ...patch })
        },
      })

      const response = await api.updateConfig('org-a', {
        client_cron_enabled: false,
        workspace_upload_limit_bytes: 0,
      }, 'admin-a')

      assert.equal(response.success, false)
      assert.equal(cronWrites, 0)
      assert.equal(cronEnabled.has('org-a'), false)
      assert.deepEqual(orgPolicies.get('org-a'), undefined)
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('rejects string booleans for client policy fields', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-bool-policy-'))
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir)

      for (const field of ['client_cron_enabled', 'client_show_tool_calls'] as const) {
        const response = await api.updateConfig('org-a', { [field]: 'false' }, 'admin-a')
        assert.equal(response.success, false)
        assert.match(response.message ?? '', new RegExp(field))
      }
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('reads each organization logo from its own storage directory', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-logo-'))
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir)
      for (const [orgId, filename, contents] of [
        ['org-a', 'logo-a.png', 'A'],
        ['org-b', 'logo-b.png', 'B'],
      ] as const) {
        const uploadDir = join(runtimeDir, 'uploads', 'enterprise', encodeURIComponent(orgId))
        await mkdir(uploadDir, { recursive: true })
        await writeFile(join(uploadDir, filename), contents)
        await api.updateConfig(orgId, { logo: filename })
      }

      const orgA = await api.getConfig('org-a')
      const orgB = await api.getConfig('org-b')

      assert.ok(orgA.data)
      assert.ok(orgB.data)
      assert.equal(orgA.data.logo, 'data:image/png;base64,QQ==')
      assert.equal(orgB.data.logo, 'data:image/png;base64,Qg==')
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })
})

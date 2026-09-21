// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import { after, beforeEach, describe, it, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbDriver, PgPoolLike } from '../db/driver.js'
import type { CronActor, CronServiceConfig } from '../services/cron/CronService.js'

const settingsHome = mkdtempSync(join(tmpdir(), 'moss-enterprise-settings-'))
const homeMock = mock.method(os, 'homedir', () => settingsHome)
const { DirectConnectStore, forPostgresDirectConnectStore } = await import('../db.js')
const { createEnterpriseApi } = await import('../api/enterprise.js')
const { getSystemSettings, updateSystemSettings, SYSTEM_SETTINGS_PATH } = await import('../systemSettings.js')
const { AuthCenterDb } = await import('../authCenter/db.js')
const { IdentityRepository, ensureIdentitySchema } = await import('../identity/identityRepository.js')
const { ClientPolicyRepository, ensureClientPolicySchema } = await import('../configuration/clientPolicyRepository.js')
const { migrateLegacyEnterpriseCronPolicy } = await import('../migration/legacyEnterpriseCronPolicy.js')
const { PgDriver } = await import('../db/driver.js')
assert.equal(SYSTEM_SETTINGS_PATH, join(settingsHome, '.moss', 'settings.json'))
beforeEach(async () => { await updateSystemSettings({ clientCronEnabled: true }) })
after(() => {
  homeMock.mock.restore()
  rmSync(settingsHome, { recursive: true, force: true })
})

async function openPolicyFixture(t: TestContext, kind: DbDriver['kind']) {
  let store: InstanceType<typeof DirectConnectStore>
  let openPeer: () => DbDriver
  if (kind === 'postgres') {
    const { Pool, types } = await import('pg')
    const { applyPgSchema } = await import('../db/pg_schema.js')
    types.setTypeParser(20, Number)
    const admin = new Pool({ connectionString: process.env.MOSS_PG_TEST_URL, max: 1 })
    const database = `moss_cron_${randomUUID().replace(/-/g, '')}`
    const url = new URL(process.env.MOSS_PG_TEST_URL!)
    url.pathname = `/${database}`
    const pools: InstanceType<typeof Pool>[] = []
    t.after(async () => {
      await Promise.all(pools.map(pool => pool.end()))
      try { await admin.query(`DROP DATABASE IF EXISTS ${database}`) } finally { await admin.end() }
    })
    await admin.query(`CREATE DATABASE ${database}`)
    openPeer = () => {
      const pool = new Pool({ connectionString: url.toString(), max: 3 })
      pools.push(pool)
      return new PgDriver(pool as unknown as PgPoolLike)
    }
    const driver = openPeer()
    await applyPgSchema(driver)
    store = forPostgresDirectConnectStore(driver)
    assert.equal(store.db, undefined)
  } else {
    store = new DirectConnectStore(':memory:')
    t.after(() => store.close())
    new AuthCenterDb(store)
    ensureIdentitySchema(store.requireSqliteDb())
    ensureClientPolicySchema(store.requireSqliteDb())
    openPeer = () => store.driver
  }
  // openStoreAsync seeds this after applyPgSchema in production.
  await store.driver.run(`
    INSERT INTO enterprises (id, created_at, updated_at) VALUES ('default', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `, [Date.now(), Date.now()])
  const identities = new IdentityRepository(store.driver)
  const policies = new ClientPolicyRepository(store.driver)
  const addOrg = async (orgId: string) => {
    await store.driver.run('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)', [orgId, orgId, Date.now()])
    await identities.putOrganizationProfile({
      orgId, code: orgId, loginMethod: 'password', localEnabled: true, cloudEnabled: true,
    })
  }
  const hooks = {
    getClientCronEnabled: async (orgId: string) => (await identities.getOrganizationProfile(orgId))?.clientCronEnabled ?? true,
    setClientCronEnabled: (orgId: string, enabled: boolean) => identities.setOrganizationClientCronEnabled(orgId, enabled),
    getClientPolicy: (orgId?: string) => policies.getEffective(orgId),
    putClientPolicy: (orgId: string, patch: Record<string, unknown>, updatedBy: string) => policies.putOrganization(orgId, patch, updatedBy),
  }
  await addOrg('org-a')
  await addOrg('org-b')
  return { store, identities, policies, addOrg, hooks, openPeer }
}

for (const kind of ['sqlite', 'postgres'] as const) {
  describe(`enterprise ${kind} Driver transactions`, { skip: kind === 'postgres' && !process.env.MOSS_PG_TEST_URL }, () => {
    it('awaits async profile and policy hooks and commits branding with both policies', async t => {
      const { store, identities, policies, hooks } = await openPolicyFixture(t, kind)
      const api = createEnterpriseApi(store, settingsHome, hooks)
      const result = await api.updateConfig('org-a', {
        app_name: 'A', client_cron_enabled: false, client_show_tool_calls: false, workspace_upload_limit_bytes: 2048,
      }, 'admin-a')
      assert.equal(result.success, true)
      assert.equal(result.data?.app_name, 'A')
      assert.equal(result.data?.client_cron_enabled, false)
      assert.equal(result.data?.client_show_tool_calls, false)
      assert.equal(result.data?.workspace_upload_limit_bytes, 2048)
      assert.equal((await identities.getOrganizationProfile('org-b'))?.clientCronEnabled, true)
      assert.deepEqual(await policies.getOrganization('org-b'), {})
      assert.equal((await store.getEnterprise('org-b')).app_name, null)
    })

    for (const failure of ['policy', 'branding'] as const) {
      it(`rolls back all enterprise writes when async ${failure} fails after writing`, async t => {
        const { store, identities, policies, hooks } = await openPolicyFixture(t, kind)
        if (failure === 'branding') {
          const update = store.updateEnterprise.bind(store)
          t.mock.method(store, 'updateEnterprise', async (...args: Parameters<typeof update>) => {
            await update(...args)
            throw new Error('branding failed')
          })
        }
        const api = createEnterpriseApi(store, settingsHome, {
          ...hooks,
          putClientPolicy: async (orgId, patch, updatedBy) => {
            await hooks.putClientPolicy(orgId, patch, updatedBy)
            if (failure === 'policy') throw new Error('policy failed')
          },
        })
        const result = await api.updateConfig('org-a', {
          app_name: 'Must roll back', client_cron_enabled: false, client_show_tool_calls: false,
        }, 'admin-a')
        assert.equal(result.success, false)
        assert.match(result.message ?? '', new RegExp(`${failure} failed`))
        assert.equal((await identities.getOrganizationProfile('org-a'))?.clientCronEnabled, true)
        assert.deepEqual(await policies.getOrganization('org-a'), {})
        assert.equal(await store.driver.get('SELECT 1 FROM enterprises WHERE id = ?', ['org-a']), undefined)
      })
    }

    it('migrates only restrictions once and keeps later profile edits and new org defaults', async t => {
      const { store, identities, addOrg, hooks } = await openPolicyFixture(t, kind)
      await store.updateEnterprise('default', { client_cron_enabled: true })
      await identities.setOrganizationClientCronEnabled('org-b', false)
      await store.updateEnterprise('org-a', { client_cron_enabled: false })
      assert.equal(await migrateLegacyEnterpriseCronPolicy(store.driver), 1)
      const api = createEnterpriseApi(store, settingsHome, hooks)
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, false)
      assert.equal((await api.getEffectivePolicy('org-b')).clientCronEnabled, false)
      assert.equal((await api.updateConfig('org-a', { client_cron_enabled: true })).success, true)
      await store.updateEnterprise('default', { client_cron_enabled: false })
      await addOrg('org-new')
      assert.equal(await migrateLegacyEnterpriseCronPolicy(store.driver), 0)
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, true)
      assert.equal((await api.getEffectivePolicy('org-new')).clientCronEnabled, true)
      await updateSystemSettings({ clientCronEnabled: false })
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, false)
    })

    it('rolls back migration changes and marker after an awaited write failure', async t => {
      const { store, identities } = await openPolicyFixture(t, kind)
      await store.updateEnterprise('default', { client_cron_enabled: false })
      const run = store.driver.run.bind(store.driver)
      const failure = t.mock.method(store.driver, 'run', async (...args: Parameters<typeof run>) => {
        const changed = await run(...args)
        if (args[0].includes('INSERT INTO enterprise_cron_policy_migrations')) throw new Error('marker failed')
        return changed
      })
      await assert.rejects(migrateLegacyEnterpriseCronPolicy(store.driver), /marker failed/)
      assert.equal((await identities.getOrganizationProfile('org-a'))?.clientCronEnabled, true)
      assert.equal((await identities.getOrganizationProfile('org-b'))?.clientCronEnabled, true)
      failure.mock.restore()
      assert.equal(await migrateLegacyEnterpriseCronPolicy(store.driver), 2)
      assert.equal((await identities.getOrganizationProfile('org-a'))?.clientCronEnabled, false)
    })

    it('enforces migrated async org policy and live caller auth through the cron API and service', async t => {
      const { CronService } = await import('../services/cron/CronService.js')
      const { createCronApi } = await import('../api/cron.js')
      const { store, hooks } = await openPolicyFixture(t, kind)
      await store.updateEnterprise('org-a', { client_cron_enabled: false })
      await migrateLegacyEnterpriseCronPolicy(store.driver)
      const enterprise = createEnterpriseApi(store, settingsHome, hooks)
      let active = true
      const sessionActors: CronActor[] = []
      const getClientCronEnabled = async (orgId: string) => (await enterprise.getEffectivePolicy(orgId)).clientCronEnabled
      const service = new CronService(store.driver, {
        runtimeDir: settingsHome, defaultRuntime: 'host', dockerContainerMode: 'session',
        getClientCronEnabled,
        getUserAuth: async () => active ? { role: 'user', scopes: [] } : null,
        runtimeService: {
          async createSession(actor: CronActor) {
            sessionActors.push(actor)
            return { sessionId: 'cron-session' }
          },
        } as unknown as CronServiceConfig['runtimeService'],
      })
      t.mock.method(service as unknown as { completeRunInSession(): Promise<void> }, 'completeRunInSession', async () => {})
      const job = await service.getStore().insert({
        orgId: 'org-a', userId: 'owner', name: 'Cron report', payloadMessage: 'run',
        schedule: { kind: 'every', value: '1h' }, conversationMode: 'new',
      })
      const api = createCronApi(store.driver, { cronService: service, getClientCronEnabled })
      assert.deepEqual(await api.triggerJob({ orgId: 'org-a', userId: 'owner', role: 'user', scopes: [] }, job.id), {
        success: false, message: 'cron_disabled_by_org',
      })
      const actor: CronActor = { orgId: 'org-a', userId: 'operator', role: 'user', scopes: ['admin:cron'] }
      active = false
      assert.deepEqual(await api.triggerJob(actor, job.id), { success: false, message: 'User auth not found for operator' })
      assert.deepEqual(await service.getStore().listRunsByJob(job.id), [])
      active = true
      assert.equal((await api.triggerJob(actor, job.id)).success, true)
      const { orgId, userId, role, scopes } = sessionActors[0]
      assert.deepEqual({ orgId, userId, role, scopes }, actor)
    })
  })
}

it('PG peer startup waits for the migration holder to commit before trusting its marker', {
  skip: !process.env.MOSS_PG_TEST_URL,
}, async t => {
  const { store, identities, openPeer } = await openPolicyFixture(t, 'postgres')
  await store.updateEnterprise('org-a', { client_cron_enabled: false })
  const peer = openPeer()
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let markerWritten!: () => void
  const marker = new Promise<void>(resolve => { markerWritten = resolve })
  const run = store.driver.run.bind(store.driver)
  t.mock.method(store.driver, 'run', async (...args: Parameters<typeof run>) => {
    const changed = await run(...args)
    if (args[0].includes('INSERT INTO enterprise_cron_policy_migrations')) {
      markerWritten()
      await hold
    }
    return changed
  })
  let contentionSeen!: () => void
  const contention = new Promise<void>(resolve => { contentionSeen = resolve })
  const exclusive = peer.tryRunExclusive.bind(peer)
  t.mock.method(peer, 'tryRunExclusive', async <T>(key: string, body: () => Promise<T>) => {
    const result = await exclusive(key, body)
    if (result === null) contentionSeen()
    return result
  })
  const first = migrateLegacyEnterpriseCronPolicy(store.driver)
  await marker
  let secondFinished = false
  const second = migrateLegacyEnterpriseCronPolicy(peer).then(count => { secondFinished = true; return count })
  try {
    await contention
    assert.equal(secondFinished, false)
  } finally {
    release()
  }
  assert.deepEqual(await Promise.all([first, second]), [1, 0])
  assert.equal((await identities.getOrganizationProfile('org-a'))?.clientCronEnabled, false)
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
    await store.driver.run(`
      UPDATE enterprises SET app_name = ?, top_name = ? WHERE id = 'default'
    `, ['Legacy deployment name', 'Legacy'])

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
    new AuthCenterDb(store)
    ensureIdentitySchema(store.requireSqliteDb())
    const identities = new IdentityRepository(store.driver)
    const addOrg = async (orgId: string) => {
      await store.driver.run('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)', [orgId, orgId, Date.now()])
      await identities.putOrganizationProfile({
        orgId, code: orgId, loginMethod: 'password', localEnabled: true, cloudEnabled: true,
      })
    }
    const hooks = {
      getClientCronEnabled: async (orgId: string) => (await identities.getOrganizationProfile(orgId))?.clientCronEnabled ?? true,
      setClientCronEnabled: (orgId: string, enabled: boolean) => identities.setOrganizationClientCronEnabled(orgId, enabled),
    }
    return { store, identities, addOrg, hooks }
  }

  it('imports each old effective override once, preserving later policy edits and new org defaults', async () => {
    const { store, identities, addOrg, hooks } = setup()
    try {
      for (const orgId of ['org-a', 'org-b', 'org-inherited', 'org-null']) await addOrg(orgId)
      await store.updateEnterprise('default', { client_cron_enabled: false })
      await store.updateEnterprise('org-a', { client_cron_enabled: false })
      await store.updateEnterprise('org-b', { client_cron_enabled: true })
      await store.updateEnterprise('org-null', { client_cron_enabled: null })

      await migrateLegacyEnterpriseCronPolicy(store.driver)
      const api = createEnterpriseApi(store, settingsHome, hooks)
      for (const [orgId, expected] of [
        ['org-a', false], ['org-b', true], ['org-inherited', false], ['org-null', true],
      ] as const) {
        assert.equal((await identities.getOrganizationProfile(orgId))?.clientCronEnabled, expected, orgId)
        assert.equal((await api.getEffectivePolicy(orgId)).clientCronEnabled, expected, orgId)
      }

      await api.updateConfig('org-a', { client_cron_enabled: true })
      await identities.setOrganizationClientCronEnabled('org-b', false)
      await addOrg('org-new')
      // A later branding save can copy the legacy column; it must never reapply policy.
      await store.updateEnterprise('org-new', { app_name: 'New organization' })
      const restarted = createEnterpriseApi(store, settingsHome, hooks)
      assert.equal(await migrateLegacyEnterpriseCronPolicy(store.driver), 0)
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
      await addOrg('org-a')
      await store.updateEnterprise('org-a', { client_cron_enabled: false })
      const legacy = createEnterpriseApi(store, settingsHome)
      assert.equal((await legacy.getEffectivePolicy('org-a')).clientCronEnabled, false)
      assert.equal((await identities.getOrganizationProfile('org-a'))?.clientCronEnabled, true)
      assert.equal(await store.driver.get("SELECT 1 FROM sqlite_master WHERE name = 'enterprise_cron_policy_migrations'"), undefined)
      await migrateLegacyEnterpriseCronPolicy(store.driver)
      createEnterpriseApi(store, settingsHome, hooks)
      assert.equal((await identities.getOrganizationProfile('org-a'))?.clientCronEnabled, false)
      assert.equal((await legacy.getEffectivePolicy('org-a')).clientCronEnabled, false)
    } finally {
      await store.close()
    }
  })

  it('preserves preexisting profile restrictions despite legacy default or tenant true', async () => {
    const { store, identities, addOrg, hooks } = setup()
    try {
      for (const orgId of ['org-inherited', 'org-explicit']) {
        await addOrg(orgId)
        await identities.setOrganizationClientCronEnabled(orgId, false)
      }
      await store.updateEnterprise('default', { client_cron_enabled: true })
      await store.updateEnterprise('org-explicit', { client_cron_enabled: true })
      await migrateLegacyEnterpriseCronPolicy(store.driver)
      const api = createEnterpriseApi(store, settingsHome, hooks)
      for (const orgId of ['org-inherited', 'org-explicit']) {
        assert.equal((await api.getEffectivePolicy(orgId)).clientCronEnabled, false)
        await api.updateConfig(orgId, { client_cron_enabled: true })
      }
      await migrateLegacyEnterpriseCronPolicy(store.driver)
      assert.equal((await identities.getOrganizationProfile('org-inherited'))?.clientCronEnabled, true)
      assert.equal((await identities.getOrganizationProfile('org-explicit'))?.clientCronEnabled, true)
    } finally {
      await store.close()
    }
  })

  it('does not mark migration before profiles exist or before existing organizations are seeded', async () => {
    const store = new DirectConnectStore(':memory:')
    try {
      await store.updateEnterprise('default', { client_cron_enabled: false })
      new AuthCenterDb(store)
      await store.driver.run('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)', ['org-a', 'A', 1])
      const hooks = { getClientCronEnabled: () => true, setClientCronEnabled: () => {} }
      createEnterpriseApi(store, settingsHome, hooks)
      assert.equal(await migrateLegacyEnterpriseCronPolicy(store.driver), 0)
      assert.equal(await store.driver.get("SELECT 1 FROM sqlite_master WHERE name = 'enterprise_cron_policy_migrations'"), undefined)

      ensureIdentitySchema(store.requireSqliteDb())
      const identities = new IdentityRepository(store.driver)
      await assert.rejects(migrateLegacyEnterpriseCronPolicy(store.driver), /profiles must be initialized/)
      await identities.putOrganizationProfile({
        orgId: 'org-a', code: 'A', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
      })
      await migrateLegacyEnterpriseCronPolicy(store.driver)
      const api = createEnterpriseApi(store, settingsHome, {
        getClientCronEnabled: async orgId => (await identities.getOrganizationProfile(orgId))?.clientCronEnabled ?? true,
        setClientCronEnabled: (orgId, enabled) => identities.setOrganizationClientCronEnabled(orgId, enabled),
      })
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, false)
      assert.equal(await migrateLegacyEnterpriseCronPolicy(store.driver), 0)
    } finally {
      await store.close()
    }
  })

  it('rolls back profile changes and the marker on failure so the next attempt retries', async () => {
    const { store, identities, addOrg } = setup()
    try {
      await addOrg('org-a')
      await addOrg('org-b')
      await store.updateEnterprise('default', { client_cron_enabled: false })
      await store.driver.exec(`
        CREATE TRIGGER fail_cron_migration BEFORE UPDATE OF client_cron_enabled ON organization_profiles
        WHEN NEW.org_id = 'org-b' BEGIN SELECT RAISE(ABORT, 'migration failed'); END
      `)
      await assert.rejects(migrateLegacyEnterpriseCronPolicy(store.driver), /migration failed/)
      assert.equal((await identities.getOrganizationProfile('org-a'))?.clientCronEnabled, true)
      assert.equal((await identities.getOrganizationProfile('org-b'))?.clientCronEnabled, true)
      await store.driver.exec('DROP TRIGGER fail_cron_migration')
      assert.equal(await migrateLegacyEnterpriseCronPolicy(store.driver), 2)
      assert.equal((await identities.getOrganizationProfile('org-a'))?.clientCronEnabled, false)
      assert.equal((await identities.getOrganizationProfile('org-b'))?.clientCronEnabled, false)
    } finally {
      await store.close()
    }
  })

  it('keeps global AND organization semantics without copying the global switch into profiles', async () => {
    const { store, identities, addOrg, hooks } = setup()
    try {
      await addOrg('org-a')
      await updateSystemSettings({ clientCronEnabled: false })
      await migrateLegacyEnterpriseCronPolicy(store.driver)
      const api = createEnterpriseApi(store, settingsHome, hooks)
      assert.equal((await identities.getOrganizationProfile('org-a'))?.clientCronEnabled, true)
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, false)
      await updateSystemSettings({ clientCronEnabled: true })
      assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, true)
      await identities.setOrganizationClientCronEnabled('org-a', false)
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
  it('reads the current global kill switch after an asynchronous org policy resolves', async t => {
    const store = new DirectConnectStore(':memory:')
    t.after(() => store.close())
    const api = createEnterpriseApi(store, settingsHome, {
      getClientCronEnabled: async () => {
        await updateSystemSettings({ clientCronEnabled: false })
        return true
      },
    })
    assert.equal((await api.getEffectivePolicy('org-a')).clientCronEnabled, false)
  })

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
        getClientCronEnabled: async orgId => cronEnabled.get(orgId) ?? true,
        setClientCronEnabled: async (orgId, enabled) => { cronEnabled.set(orgId, enabled) },
        getClientPolicy: async orgId => orgId ? orgPolicies.get(orgId) ?? {} : {},
        putClientPolicy: async (orgId, patch) => {
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
